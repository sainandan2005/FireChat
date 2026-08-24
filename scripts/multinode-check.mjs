/**
 * Multi-node delivery proof.
 *
 * Requires two FireChat nodes sharing one database + Redis:
 *   node 1 → BASE1 (default http://localhost:3000, REDIS_URL set)
 *   node 2 → BASE2 (default http://localhost:3001, REDIS_URL set)
 *
 * Asserts a message sent through node 1 arrives on a socket connected to node 2,
 * which is only possible via the Redis fan-out layer.
 */
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

const BASE1 = process.env.BASE1 ?? "http://localhost:3000";
const BASE2 = process.env.BASE2 ?? "http://localhost:3001";
const results = [];

function check(name, ok, extra = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `, ${extra}` : ""}`);
}

async function api(base, path, { method = "GET", token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers["content-type"] = "application/json";
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

class Sock {
  constructor(url, debug = false) {
    this.handlers = new Map();
    this.ws = new WebSocket(url);
    this.debug = debug;
    this.ready = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("connect timeout")), 8000);
      this.ws.addEventListener("message", function h(e) {
        if (JSON.parse(e.data).t === "ready") {
          clearTimeout(t);
          this.removeEventListener("message", h);
          resolve();
        }
      });
      this.ws.addEventListener("error", () => {
        clearTimeout(t);
        reject(new Error("connect failed"));
      });
    });
    this.ws.addEventListener("message", (e) => {
      let env;
      try {
        env = JSON.parse(e.data);
      } catch {
        return;
      }
      const set = this.handlers.get(env.t);
      if (this.debug) console.log(`   [alice<-${env.t}]`, JSON.stringify(env.p)?.slice(0, 120));
      if (set) for (const h of [...set]) h(env.p);
    });
  }

  next(t, predicate = () => true, timeoutMs = 6000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting "${t}"`)), timeoutMs);
      const handler = (payload) => {
        if (!predicate(payload)) return;
        clearTimeout(timer);
        resolve(payload);
      };
      let set = this.handlers.get(t);
      if (!set) {
        set = new Set();
        this.handlers.set(t, set);
      }
      set.add(handler);
    });
  }

  send(t, p) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t, p }));
  }
}

const health1 = await api(BASE1, "/api/health");
const health2 = await api(BASE2, "/api/health");
check("node 1 healthy", health1.status === 200 && health1.json?.ok === true, JSON.stringify(health1.json));
check("node 2 healthy", health2.status === 200 && health2.json?.ok === true, JSON.stringify(health2.json));
check(
  "both nodes report redis cluster mode",
  health1.json?.clusterMode === "redis" && health2.json?.clusterMode === "redis"
);

// unique pair per run so reruns stay clean
const suffix = randomUUID().slice(0, 8);
const regA = await api(BASE1, "/api/auth/register", {
  method: "POST",
  headers: { "x-forwarded-for": "10.9.0.1" },
  body: { email: `mn-a-${suffix}@t.dev`, username: `mn_a_${suffix.replace(/-/g, "")}`, password: "password123" },
});
const regB = await api(BASE2, "/api/auth/register", {
  method: "POST",
  headers: { "x-forwarded-for": "10.9.0.2" },
  body: { email: `mn-b-${suffix}@t.dev`, username: `mn_b_${suffix.replace(/-/g, "")}`, password: "password123" },
});
check("users registered across nodes", regA.status === 201 && regB.status === 201);

const dm = await api(BASE1, "/api/conversations", {
  method: "POST",
  token: regA.json.token,
  body: { type: "dm", userId: regB.json.user.id },
});
const convId = dm.json?.conversation?.id;
check("DM created via node 1", !!convId);

// alice listens on node 2; bob sends through node 1.
// The personal-room relay (conversation.new-message) is the cross-node proof.
const aliceSock = new Sock(`ws://localhost:3001/api/ws?token=${encodeURIComponent(regA.json.token)}`);
await aliceSock.ready;

// arm the listener, create the sender, then send, all within the wait window
const t0 = Date.now();
const deliveryResult = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ timeout: true }), 7000);
  let set = aliceSock.handlers.get("conversation.new-message");
  if (!set) {
    set = new Set();
    aliceSock.handlers.set("conversation.new-message", set);
  }
  const handler = (payload) => {
    if (payload.message?.content === "cross-node hello") {
      clearTimeout(timer);
      set.delete(handler);
      resolve({ elapsed: Date.now() - t0, message: payload.message });
    }
  };
  set.add(handler);

  const sockBob = new Sock(`ws://localhost:3000/api/ws?token=${encodeURIComponent(regB.json.token)}`);
  sockBob.ready
    .then(async () => {
      sockBob.send("conversation.join", { conversationId: convId });
      await new Promise((r) => setTimeout(r, 300));
      console.log("   bob sending message via node 1…");
      sockBob.send("message.send", {
        conversationId: convId,
        type: "TEXT",
        content: "cross-node hello",
      });
    })
    .catch((err) => {
      console.log("   sender error:", err.message);
      resolve({ timeout: true });
    });
});

check(
  "cross-node realtime delivery works",
  deliveryResult.timeout !== true && deliveryResult.message?.content === "cross-node hello",
  deliveryResult.timeout ? "timed out" : `${deliveryResult.elapsed}ms via node 2`
);

aliceSock.ws.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length > 0 ? 1 : 0);
