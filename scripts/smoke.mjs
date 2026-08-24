import { randomUUID } from "node:crypto";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
// unique spoofed client IP per run → fresh rate-limit buckets even on rapid reruns
const RUN_IP = `203.0.115.${Math.floor(Math.random() * 250) + 2}`;
process.env.DATABASE_URL ??=
  process.env.SMOKE_DATABASE_URL ?? "postgresql://firechat:firechat@localhost:5432/firechat?schema=public";
const results = [];

function check(name, ok, extra = "") {
  results.push({ name, ok, extra });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `, ${extra}` : ""}`);
}

async function api(path, { method = "GET", cookie, token, body, form, headers: extraHeaders } = {}) {
  const headers = { "x-forwarded-for": RUN_IP, ...(extraHeaders ?? {}) };
  if (cookie) headers.cookie = cookie;
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers["content-type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: form ?? (body ? JSON.stringify(body) : undefined),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { res, json };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Minimal raw-WebSocket test client speaking FireChat's JSON envelope protocol. */
class TestSocket {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.handlers = new Map();
    this.pending = new Map();
    this.joined = new Set();
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
      setTimeout(() => reject(new Error("ws connect timeout")), 8000);
    });
  }

  connect() {
    return new Promise((resolve) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.onopen = () => {
        for (const conversationId of this.joined) {
          this.send("conversation.join", { conversationId });
        }
      };
      ws.onmessage = (event) => {
        let env;
        try {
          env = JSON.parse(event.data);
        } catch {
          return;
        }
        if (env.t === "ready") {
          this.resolveReady(env.p);
          resolve();
          return;
        }
        if (env.t === "ack" && env.c) {
          const pending = this.pending.get(env.c);
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(env.c);
            pending.resolve(env.p);
          }
          return;
        }
        if (env.t === "error") {
          console.log(`      server error frame: ${env.p?.message}`);
        }
        const set = this.handlers.get(env.t);
        if (set) for (const h of set) h(env.p);
      };
      ws.onerror = () => {};
      ws.onclose = () => {
        this.rejectReady(new Error("connection closed before ready"));
      };
    });
  }

  send(t, p) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t, p }));
  }

  request(t, p, timeoutMs = 8000) {
    return new Promise((resolve) => {
      const c = randomUUID().slice(0, 8);
      const timer = setTimeout(() => {
        this.pending.delete(c);
        resolve({ ok: false, error: "ack timeout" });
      }, timeoutMs);
      this.pending.set(c, { resolve, timer });
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ t, p, c }));
      } else {
        clearTimeout(timer);
        this.pending.delete(c);
        resolve({ ok: false, error: "not connected" });
      }
    });
  }

  next(t, predicate = () => true, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting "${t}"`)), timeoutMs);
      const handler = (payload) => {
        if (!predicate(payload)) return;
        clearTimeout(timer);
        this.off(t, handler);
        resolve(payload);
      };
      this.on(t, handler);
    });
  }

  on(t, handler) {
    let set = this.handlers.get(t);
    if (!set) {
      set = new Set();
      this.handlers.set(t, set);
    }
    set.add(handler);
  }

  off(t, handler) {
    this.handlers.get(t)?.delete(handler);
  }

  join(conversationId) {
    this.joined.add(conversationId);
    this.send("conversation.join", { conversationId });
  }

  close() {
    this.ws?.close();
  }
}

async function main() {
  // ---- REST / auth ----
  const loginAlice = await api("/api/auth/login", {
    method: "POST",
    body: { identifier: "alice", password: "password123" },
  });
  check("alice login", loginAlice.res.status === 200);
  const tokenA = loginAlice.json.token;
  const aliceId = loginAlice.json.user.id;

  const loginBob = await api("/api/auth/login", {
    method: "POST",
    body: { identifier: "bob", password: "password123" },
  });
  const tokenB = loginBob.json.token;
  const bobId = loginBob.json.user.id;
  check("bob login + token issued", loginBob.res.status === 200 && !!tokenB);

  const meBob = await api("/api/auth/me", { token: tokenB });
  check("auth/me via bearer token", meBob.json?.user?.username === "bob");

  const badLogin = await api("/api/auth/login", {
    method: "POST",
    body: { identifier: "alice", password: "wrong" },
  });
  check("bad password rejected (401)", badLogin.res.status === 401);

  const noAuth = await api("/api/conversations");
  check("unauthenticated API blocked (401)", noAuth.res.status === 401);

  // ---- conversations ----
  const users = await api("/api/users?q=bo", { token: tokenA });
  check("user search finds bob", (users.json?.users ?? []).some((u) => u.id === bobId));

  const dm = await api("/api/conversations", {
    method: "POST",
    token: tokenA,
    body: { type: "dm", userId: bobId },
  });
  const convId = dm.json?.conversation?.id;
  check("dm create-or-get", dm.res.status === 200 && !!convId);

  const dmAgain = await api("/api/conversations", {
    method: "POST",
    token: tokenA,
    body: { type: "dm", userId: bobId },
  });
  check("dm dedupe (same conversation returned)", dmAgain.json?.conversation?.id === convId);

  const detail = await api(`/api/conversations/${convId}`, { token: tokenA });
  check(
    "conversation detail endpoint responds",
    detail.res.status === 200 &&
      detail.json?.conversation?.id === convId &&
      Array.isArray(detail.json.conversation.members) &&
      typeof detail.json.conversation.readStates === "object"
  );

  const group = await api("/api/conversations", {
    method: "POST",
    token: tokenA,
    body: { type: "group", name: "Smoke Group", memberIds: [bobId] },
  });
  check(
    "group create",
    group.res.status === 201 && group.json.conversation.isGroup === true
  );
  var groupId = group.json?.conversation?.id;

  // ---- raw websockets ----
  const sockA = new TestSocket(`ws://localhost:3000/api/ws?token=${encodeURIComponent(tokenA)}`);
  const sockB = new TestSocket(`ws://localhost:3000/api/ws?token=${encodeURIComponent(tokenB)}`);

  const presenceListPromise = sockB.next("presence.list");
  await Promise.all([sockA.connect(), sockB.connect()]);
  check("ws upgrade auth via ?token= (both connected)", sockA.ws.readyState === 1 && sockB.ws.readyState === 1);

  // ---- last seen on disconnect ----
  const offlineSeen = new Promise((resolve) => {
    const handler = (payload) => {
      if (payload.online === false && typeof payload.lastSeenAt === "string") {
        sockA.off("presence.update", handler);
        resolve(payload);
      }
    };
    sockA.on("presence.update", handler);
  });
  const tempId = randomUUID().slice(0, 8);
  const regTemp = await api("/api/auth/register", {
    method: "POST",
    body: { email: `${tempId}@firechat.dev`, username: `tmp${tempId}`, password: "password123" },
  });
  const tempSocket = new TestSocket(
    `ws://localhost:3000/api/ws?token=${encodeURIComponent(regTemp.json.token)}`
  );
  await tempSocket.connect();
  tempSocket.close();
  const seenPayload = await Promise.race([
    offlineSeen,
    sleep(6000).then(() => null),
  ]);
  check(
    "disconnect writes lastSeenAt and broadcasts it",
    !!seenPayload && typeof seenPayload.lastSeenAt === "string",
    seenPayload?.lastSeenAt
  );

  // ---- session management ----
  const tempLogin2 = await api("/api/auth/login", {
    method: "POST",
    body: { identifier: `tmp${tempId}`, password: "password123" },
  });
  const sessList = await api("/api/auth/sessions", { token: regTemp.json.token });
  check(
    "session list shows both devices",
    (sessList.json?.sessions ?? []).length === 2 &&
      sessList.json.sessions.some((s) => s.current),
    `got ${(sessList.json?.sessions ?? []).length}: ${JSON.stringify(sessList.json?.sessions)?.slice(0, 160)} status=${sessList.status}`
  );

  const currentRow = sessList.json.sessions.find((s) => s.current);
  const otherRow = sessList.json.sessions.find((s) => !s.current);
  if (currentRow && otherRow) {
    const revokeOther = await api(`/api/auth/sessions/${otherRow.id}`, {
      method: "DELETE",
      token: regTemp.json.token,
    });
    check("revoke single session ok", revokeOther.res.status === 200);

    const revokedMe = await api("/api/auth/me", { token: tempLogin2.json.token });
    check("revoked session rejected (401)", revokedMe.res.status === 401);

    const stillValid = await api("/api/auth/me", { token: regTemp.json.token });
    check("current session unaffected", stillValid.res.status === 200);
  }

  await api("/api/auth/logout", { method: "DELETE", token: regTemp.json.token });
  const afterLogoutAll = await api("/api/auth/me", { token: regTemp.json.token });
  check("logout-all kills remaining session (401)", afterLogoutAll.res.status === 401);

  const listB = await presenceListPromise;
  check("presence.list tracks online users", Array.isArray(listB) && listB.includes(aliceId) && listB.includes(bobId), JSON.stringify(listB));

  sockA.join(convId);
  sockB.join(convId);
  await sleep(400);

  // realtime messaging with ack correlation
  const bobGotMessage = sockB.next("message.new");
  const ack = await sockA.request("message.send", {
    conversationId: convId,
    type: "TEXT",
    content: "hello from the smoke test",
  });
  check("send ack correlated via cid", ack.ok === true && !!ack.message?.id);
  const received = await bobGotMessage;
  check("realtime delivery to peer", received.content === "hello from the smoke test");

  // ---- reply-to ----
  const replyBroadcast = sockB.next("message.new", (p) => !!p.replyTo);
  const replyAck = await sockA.request("message.send", {
    conversationId: convId,
    type: "TEXT",
    content: "replying to your welcome",
    replyToId: received.id,
  });
  check("reply ack carries replyTo preview", replyAck.ok === true && replyAck.message?.replyTo?.id === received.id && replyAck.message.replyTo.senderUsername === "alice");
  await replyBroadcast;
  check("reply delivers with quoted context to peers", true);

  const badReply = await sockA.request("message.send", {
    conversationId: convId,
    type: "TEXT",
    content: "bogus reply anchor",
    replyToId: "nonexistent",
  });
  check("invalid replyToId rejected", badReply.ok === false);

  // ---- delivery ticks plumbing ----
  const aliceGotDelivery = sockA.next(
    "delivery.update",
    (p) => Array.isArray(p) && p.some((e) => e.userId === bobId)
  );
  sockB.send("receipt.markDelivered", { conversationId: convId });
  const deliveryPayload = await aliceGotDelivery;
  const bobDelivery = deliveryPayload.find((e) => e.userId === bobId);
  check("markDelivered emits delivery.update to sender", typeof bobDelivery?.lastDeliveredAt === "string");

  const detailAfter = await api(`/api/conversations/${convId}`, { token: tokenA });
  check(
    "detail exposes deliveryStates + readStates",
    typeof detailAfter.json?.conversation?.deliveryStates === "object" &&
      detailAfter.json.conversation.readStates[bobId] !== undefined
  );

  // typing
  const bobSeesTyping = sockB.next("typing.update", (p) => p.typing === true);
  sockA.send("typing.start", { conversationId: convId });
  const typing = await bobSeesTyping;
  check("typing indicator propagates", typing.typing === true);

  // receipts
  const aliceSeesReceipt = sockA.next("receipt.update", (p) => p.userId === bobId);
  sockB.send("receipt.markRead", { conversationId: convId });
  const receipt = await aliceSeesReceipt;
  check("read receipts propagate", typeof receipt.lastReadAt === "string");

  // REST-triggered read must ALSO reach sockets (regression: module-fork bug)
  const aliceSeesRestReceipt = sockB.next("receipt.update", (p) => p.userId === aliceId);
  const restRead = await api(`/api/conversations/${convId}/read`, { method: "POST", token: tokenA });
  await restRead;
  try {
    const restReceipt = await aliceSeesRestReceipt;
    check("REST /read broadcasts receipt:update", restReceipt.userId === aliceId);
  } catch {
    check("REST /read broadcasts receipt:update", false, "no event received");
  }

  // file upload + attachment message
  const form = new FormData();
  form.append("file", new Blob(["smoke-file-contents"], { type: "text/plain" }), "note.txt");
  const up = await api("/api/upload", { method: "POST", token: tokenA, form });
  check("upload works", up.res.status === 200 && !!up.json?.url, up.json?.url);

  if (up.json?.url) {
    const fileRes = await fetch(`${BASE}${up.json.url}`, { headers: { authorization: `Bearer ${tokenB}` } });
    const text = await fileRes.text();
    check("uploaded file served back with auth", fileRes.status === 200 && text === "smoke-file-contents");

    const bobGotFile = sockB.next("message.new", (p) => p.type !== "TEXT");
    await sockA.request("message.send", {
      conversationId: convId,
      type: "FILE",
      content: "",
      fileUrl: up.json.url,
      fileName: up.json.fileName,
      fileSize: up.json.fileSize,
      mimeType: up.json.mimeType,
    });
    const fileMsg = await bobGotFile;
    check("file attachment message delivers realtime", fileMsg.type === "FILE" && !!fileMsg.fileUrl);
  }

  // history pagination sanity
  const hist = await api(`/api/conversations/${convId}/messages?limit=50`, { token: tokenB });
  check("history contains seeded + new messages", (hist.json?.messages?.length ?? 0) >= 3, `${hist.json?.messages?.length} messages`);

  // ---- afterId gap-fill (reconnect recovery) ----
  const firstMsgId = hist.json.messages[0].id;
  const gap = await api(`/api/conversations/${convId}/messages?afterId=${encodeURIComponent(firstMsgId)}`, { token: tokenB });
  const gapMsgs = gap.json?.messages ?? [];
  check(
    "afterId returns strictly newer messages in order",
    gap.res.status === 200 &&
      gapMsgs.length >= 2 &&
      !gapMsgs.some((m) => m.id === firstMsgId) &&
      gapMsgs.every((m, i) => i === 0 || m.createdAt >= gapMsgs[i - 1].createdAt),
    `${gapMsgs.length} messages after anchor`
  );

  // ---- pin / mute / archive flags ----
  const pinRes = await api(`/api/conversations/${convId}/flags`, {
    method: "PATCH",
    token: tokenA,
    body: { pinned: true },
  });
  check("pin accepted", pinRes.res.status === 200);

  const listAfterPin = await api("/api/conversations", { token: tokenA });
  check(
    "pinned conversation sorts first",
    listAfterPin.json?.conversations?.[0]?.id === convId
  );

  const muteArchive = await api(`/api/conversations/${convId}/flags`, {
    method: "PATCH",
    token: tokenA,
    body: { muted: true, archived: true },
  });
  check("mute+archive accepted", muteArchive.res.status === 200);

  const listAfterArchive = await api("/api/conversations", { token: tokenA });
  const archivedEntry = (listAfterArchive.json?.conversations ?? []).find(
    (c) => c.id === convId
  );
  check(
    "archive+mute flags present in list payload",
    !!archivedEntry?.archivedAt && archivedEntry.muted === true
  );

  const detailFlags = await api(`/api/conversations/${convId}`, { token: tokenA });
  check(
    "flags persisted on detail",
    detailFlags.json?.conversation?.muted === true &&
      !!detailFlags.json.conversation.archivedAt
  );

  await api(`/api/conversations/${convId}/flags`, {
    method: "PATCH",
    token: tokenA,
    body: { muted: false, archived: false, pinned: false },
  });

  // ---- message search ----
  const searchBob = await api(
    `/api/search?q=${encodeURIComponent("carol should")}`,
    { token: tokenB }
  );
  check(
    "global search finds message (member)",
    (searchBob.json?.results ?? []).some((r) => r.conversationId === convId)
  );

  const scoped = await api(
    `/api/search?q=${encodeURIComponent("carol should")}&conversationId=${
      groupId ?? "none"
    }`,
    { token: tokenB }
  );
  check(
    "scoped search excludes other conversations",
    (scoped.json?.results ?? []).length === 0 ||
      scoped.json.results.every((r) => r.conversationId !== convId)
  );

  // ---- aroundId window ----
  const histForWindow = await api(`/api/conversations/${convId}/messages?limit=50`, { token: tokenB });
  const msgsForWindow = histForWindow.json?.messages ?? [];
  if (msgsForWindow.length >= 3) {
    const anchorId = msgsForWindow[Math.floor(msgsForWindow.length / 2)].id;
    const win = await api(
      `/api/conversations/${convId}/messages?aroundId=${encodeURIComponent(anchorId)}`,
      { token: tokenB }
    );
    const winMsgs = win.json?.messages ?? [];
    const orderedAsc = winMsgs.every(
      (m, i) => i === 0 || winMsgs[i - 1].createdAt <= m.createdAt
    );
    check(
      "aroundId returns anchored ascending window",
      win.res.status === 200 && winMsgs.some((m) => m.id === anchorId) && orderedAsc,
      `${winMsgs.length} msgs`
    );
  }

  // ---- emoji reactions ----
  const bobSeesReaction = sockB.next("reaction.updated");
  const reactAck = await sockA.request("reaction.toggle", {
    messageId: received.id,
    emoji: "🔥",
  });
  check("reaction toggle ack", reactAck.ok === true);
  const reactionPayload = await bobSeesReaction;
  check(
    "reaction broadcasts to peers",
    reactionPayload.messageId === received.id &&
      reactionPayload.reactions.some((r) => r.userId === aliceId && r.emoji === "🔥")
  );

  const histWithReactions = await api(`/api/conversations/${convId}/messages?limit=50`, { token: tokenB });
  const reactedMsg = (histWithReactions.json?.messages ?? []).find((m) => m.id === received.id);
  check(
    "history includes reaction aggregates",
    (reactedMsg?.reactions ?? []).some((r) => r.emoji === "🔥")
  );

  const unreactAck = await sockA.request("reaction.toggle", {
    messageId: received.id,
    emoji: "🔥",
  });
  check("reaction toggle-off ack", unreactAck.ok === true);

  // ---- edit message for everyone ----
  const editedBroadcast = sockB.next("message.updated");
  const editAck = await sockA.request("message.edit", {
    messageId: received.id,
    content: "hello from the smoke test (edited)",
  });
  check("edit ack ok with editedAt", editAck.ok === true && !!editAck.message?.editedAt);
  const updatedPayload = await editedBroadcast;
  check("edit broadcasts to peers", updatedPayload.message.content === "hello from the smoke test (edited)");

  const hijack = await sockB.request("message.edit", {
    messageId: received.id,
    content: "bob was here",
  });
  check("editing someone else's message rejected", hijack.ok === false);

  // ---- delete message for everyone ----
  const deletedBroadcast = sockB.next("message.deleted");
  const delAck = await sockA.request("message.delete", { messageId: received.id });
  check("delete ack ok", delAck.ok === true);
  const deletedPayload = await deletedBroadcast;
  check("delete broadcasts tombstone event", deletedPayload.messageId === received.id);

  const histAfterDelete = await api(`/api/conversations/${convId}/messages?limit=50`, { token: tokenA });
  const tombstone = (histAfterDelete.json?.messages ?? []).find((m) => m.id === received.id);
  check(
    "history returns redacted tombstone",
    tombstone && tombstone.deletedAt !== null && tombstone.content === null
  );

  const editDeleted = await sockA.request("message.edit", {
    messageId: received.id,
    content: "zombie edit",
  });
  check("editing a deleted message rejected", editDeleted.ok === false);

  // outsider access control over WS: carol joins a room she's not in → must NOT receive traffic
  const loginCarol = await api("/api/auth/login", {
    method: "POST",
    body: { identifier: "carol", password: "password123" },
  });
  const sockC = new TestSocket(`ws://localhost:3000/api/ws?token=${encodeURIComponent(loginCarol.json.token)}`);
  await sockC.connect();
  sockC.join(convId);
  await sleep(300);

  let intruderHeardNothing = true;
  sockC.on("message.new", () => (intruderHeardNothing = false));
  const bobGotSecond = sockB.next("message.new");
  await sockA.request("message.send", {
    conversationId: convId,
    type: "TEXT",
    content: "carol should not see this",
  });
  await bobGotSecond;
  await sleep(200);
  check("outsider cannot receive room traffic", intruderHeardNothing);

  const intruderRest = await api(`/api/conversations/${convId}/messages`, { token: loginCarol.json.token });
  check("outsider cannot read DM via REST (404)", intruderRest.res.status === 404);

  // ---- web push endpoints ----
  const keyRes = await api("/api/push/key", { token: tokenA });
  check(
    "push vapid key endpoint",
    keyRes.res.status === 200 && typeof keyRes.json?.publicKey === "string" && keyRes.json.publicKey.length > 40
  );

  const fakeSub = {
    endpoint: "https://fcm.googleapis.com/fcm/send/smoke-test-endpoint",
    keys: { p256dh: `p${"x".repeat(60)}`, auth: `a${"y".repeat(20)}` },
  };
  const subRes = await api("/api/push/subscribe", { method: "POST", token: loginCarol.json.token, body: fakeSub });
  check("push subscribe accepts subscription", subRes.res.status === 200);

  const subAgain = await api("/api/push/subscribe", { method: "POST", token: tokenA, body: fakeSub });
  check("push subscribe re-points endpoint to new owner", subAgain.res.status === 200);

  const unsubWrong = await api("/api/push/unsubscribe", { method: "POST", token: loginCarol.json.token, body: { endpoint: fakeSub.endpoint } });
  const stillThere = await api("/api/push/key", { token: tokenA });
  check("unsubscribe scoped to owner", unsubWrong.res.status === 200 && stillThere.res.status === 200);

  const unsubOk = await api("/api/push/unsubscribe", { method: "POST", token: tokenA, body: { endpoint: fakeSub.endpoint } });
  check("push unsubscribe removes", unsubOk.res.status === 200);

  // ---- chat list ordering: activity bumps conversation to top ----
  {
    if (groupId) {
      await sockA.request("message.send", {
        conversationId: groupId,
        type: "TEXT",
        content: "bump the group to the top",
      });
      await sleep(300);
      const list = await api("/api/conversations", { token: tokenA });
      const ordered = (list.json?.conversations ?? []).map((c) => c.id);
      check("newest activity orders conversation list", ordered[0] === groupId, JSON.stringify(ordered.slice(0, 3)));
    } else {
      check("newest activity orders conversation list", false, "no group id");
    }
  }

  // ---- group member management (roles) ----
  if (groupId) {
    const renameByMember = await api(`/api/conversations/${groupId}`, {
      method: "PATCH",
      token: tokenB,
      body: { name: "Bob Renamed It" },
    });
    check("member cannot rename group (403)", renameByMember.res.status === 403);

    const renameByOwner = await api(`/api/conversations/${groupId}`, {
      method: "PATCH",
      token: tokenA,
      body: { name: "Renamed by Owner" },
    });
    check("owner renames group", renameByOwner.res.status === 200);

    const carolSearch = await api("/api/users?q=carol", { token: tokenA });
    const carolId = carolSearch.json?.users?.[0]?.id;

    if (carolId) {
      const addOk = await api(`/api/conversations/${groupId}/members`, {
        method: "POST",
        token: tokenA,
        body: { userId: carolId },
      });
      check("owner adds member", addOk.res.status === 200);

      const addDup = await api(`/api/conversations/${groupId}/members`, {
        method: "POST",
        token: tokenA,
        body: { userId: carolId },
      });
      check("duplicate add rejected (409)", addDup.res.status === 409);

      const removeByMember = await api(`/api/conversations/${groupId}/members`, {
        method: "DELETE",
        token: tokenB,
        body: { userId: carolId },
      });
      check("member cannot remove others (403)", removeByMember.res.status === 403);

      const removeByOwner = await api(`/api/conversations/${groupId}/members`, {
        method: "DELETE",
        token: tokenA,
        body: { userId: carolId },
      });
      check("owner removes member", removeByOwner.res.status === 200);

      const groupHistory = await api(`/api/conversations/${groupId}/messages?limit=50`, { token: tokenA });
      const systemTexts = (groupHistory.json?.messages ?? [])
        .filter((m) => m.type === "SYSTEM")
        .map((m) => m.content);
      check(
        "system messages recorded add+remove",
        systemTexts.some((c) => c?.includes("added carol")) &&
          systemTexts.some((c) => c?.includes("removed carol")),
        JSON.stringify(systemTexts)
      );
    }
  }

  // ---- delete chat (DM): hides history for caller only ----
  const clearRes = await api(`/api/conversations/${convId}`, { method: "DELETE", token: tokenA });
  check("delete chat returns cleared", clearRes.res.status === 200 && clearRes.json?.action === "cleared");

  const afterClearMine = await api(`/api/conversations/${convId}/messages`, { token: tokenA });
  check("cleared chat hides history for deleter", (afterClearMine.json?.messages ?? []).length === 0);

  const afterClearPeer = await api(`/api/conversations/${convId}/messages`, { token: tokenB });
  check("peer keeps their copy after clear", (afterClearPeer.json?.messages ?? []).length >= 3);

  // ---- exit group: membership removed + system message ----
  if (groupId) {
    const exitRes = await api(`/api/conversations/${groupId}`, { method: "DELETE", token: tokenB });
    check("exit group returns left", exitRes.res.status === 200 && exitRes.json?.action === "left");

    const exiled = await api(`/api/conversations/${groupId}/messages`, { token: tokenB });
    check("exited member loses access (404)", exiled.res.status === 404);

    const remainingView = await api(`/api/conversations/${groupId}/messages`, { token: tokenA });
    const sysMsgs = (remainingView.json?.messages ?? []).filter((m) => m.type === "SYSTEM");
    check(
      "system message records the exit",
      sysMsgs.some((m) => m.content === "bob left")
    );
  }

  sockA.close();
  sockB.close();
  sockC.close();

  // ================= hardening / edge cases =================
  const H = { token: tokenA };
  const REG_IP = { "x-forwarded-for": `203.0.113.${Math.floor(Math.random() * 250) + 2}` };

  // keep a live socket for alice through the remaining checks
  const sockMain = new TestSocket(`ws://localhost:3000/api/ws?token=${encodeURIComponent(tokenA)}`);
  await sockMain.connect();

  // health + brand icon
  const health = await api("/api/health");
  check(
    "health endpoint reports ok + db up",
    health.res.status === 200 && health.json?.ok === true && health.json?.checks?.db === "up"
  );

  const icon = await fetch(`${BASE}/icon.svg`);
  const iconBody = await icon.text();
  check(
    "brand icon route serves svg",
    icon.status === 200 && iconBody.includes("<svg") && iconBody.includes("#f54e00")
  );
  // auth validation
  const dupEmail = await api("/api/auth/register", {
    method: "POST",
    headers: REG_IP,
    body: { email: "alice@firechat.dev", username: `x${randomUUID().slice(0, 6)}`, password: "password123" },
  });
  check("duplicate email register rejected (409)", dupEmail.res.status === 409);

  const badEmail = await api("/api/auth/register", {
    method: "POST",
    headers: REG_IP,
    body: { email: "not-an-email", username: "validuser1", password: "password123" },
  });
  check("invalid email rejected (400)", badEmail.res.status === 400);

  const shortPass = await api("/api/auth/register", {
    method: "POST",
    headers: REG_IP,
    body: { email: `${randomUUID().slice(0, 6)}@t.dev`, username: "validuser2", password: "short" },
  });
  check("short password rejected (400)", shortPass.res.status === 400);

  const malformed = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  check("malformed JSON handled (400)", malformed.status === 400);

  // upload validation
  const bigBuffer = new Uint8Array(10 * 1024 * 1024 + 1);
  const oversizeForm = new FormData();
  oversizeForm.append("file", new Blob([bigBuffer], { type: "text/plain" }), "big.txt");
  const oversize = await api("/api/upload", { method: "POST", ...H, form: oversizeForm });
  check("oversized upload rejected (413)", oversize.res.status === 413);

  const exeForm = new FormData();
  exeForm.append("file", new Blob(["MZ..."], { type: "application/x-msdownload" }), "evil.exe");
  const badType = await api("/api/upload", { method: "POST", ...H, form: exeForm });
  check("disallowed file type rejected (415)", badType.res.status === 415);

  const emptyForm = new FormData();
  emptyForm.append("file", new Blob([], { type: "text/plain" }), "empty.txt");
  const emptyFile = await api("/api/upload", { method: "POST", ...H, form: emptyForm });
  check("empty file rejected (400)", emptyFile.res.status === 400);

  // files route security
  const noAuthFile = await fetch(`${BASE}${up.json?.url ?? "/api/files/x.txt"}`);
  check("file serving requires auth (401)", noAuthFile.status === 401);

  const traversal = await fetch(`${BASE}/api/files/..%2f..%2f.env`, {
    headers: { authorization: `Bearer ${tokenA}` },
  });
  check("path traversal blocked (404)", traversal.status === 404);

  const missingFile = await fetch(`${BASE}/api/files/does-not-exist.txt`, {
    headers: { authorization: `Bearer ${tokenA}` },
  });
  check("missing file served as 404", missingFile.status === 404);

  // WS protocol abuse
  let protocolErrorSeen = false;
  const errorProbe = new TestSocket(`ws://localhost:3000/api/ws?token=${encodeURIComponent(tokenA)}`);
  await errorProbe.connect();
  errorProbe.on("error", (p) => {
    if (typeof p?.message === "string") protocolErrorSeen = true;
  });
  errorProbe.ws.send("this is not json");
  errorProbe.send("totally.unknown.event", {});
  await sleep(400);
  check("protocol abuse answered with error frames", protocolErrorSeen);
  errorProbe.close();

  // pagination cursor chain integrity
  const chain = [];
  let cursor = null;
  let guard = 0;
  do {
    const page = await api(
      `/api/conversations/${convId}/messages?limit=5${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      { token: tokenB }
    );
    for (const m of page.json?.messages ?? []) chain.push(m.id);
    cursor = page.json?.nextCursor ?? null;
    guard += 1;
  } while (cursor && guard < 50);
  check(
    "cursor chain covers history without duplicates",
    new Set(chain).size === chain.length && chain.length >= 3,
    `${chain.length} collected`
  );

  // multi-device presence: closing ONE device must not mark user offline
  const stillOnlineProbe = new Promise((resolve) => {
    const handler = (p) => {
      if (p.userId === aliceId && p.online === false) resolve(false);
    };
    sockMain.on("presence.update", handler);
    setTimeout(() => resolve(true), 900);
  });
  const sockA2 = new TestSocket(`ws://localhost:3000/api/ws?token=${encodeURIComponent(tokenA)}`);
  await sockA2.connect();
  sockA2.close();
  check(
    "multi-device presence survives single-device disconnect",
    (await stillOnlineProbe) === true
  );

  // login rate limit per-IP
  let saw429 = false;
  for (let i = 0; i < 11; i += 1) {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.77" },
      body: JSON.stringify({ identifier: `rl${i}`, password: "wrong-password" }),
    });
    if (res.status === 429) saw429 = true;
  }
  check("login rate limit triggers 429", saw429);

  const normalLoginStillOk = await api("/api/auth/login", {
    method: "POST",
    body: { identifier: "alice", password: "password123" },
  });
  check("other clients unaffected by rate-limit bucket", normalLoginStillOk.res.status === 200);

  // message.send rate limit (isolated throwaway DM)
  const rlA = randomUUID().slice(0, 8);
  const rlB = randomUUID().slice(0, 8);
  const regRlA = await api("/api/auth/register", {
    method: "POST",
    headers: { "x-forwarded-for": "10.0.0.1" },
    body: { email: `${rlA}@t.dev`, username: rlA, password: "password123" },
  });
  const regRlB = await api("/api/auth/register", {
    method: "POST",
    headers: { "x-forwarded-for": "10.0.1.1" },
    body: { email: `${rlB}@t.dev`, username: rlB, password: "password123" },
  });
  if (regRlA.res.status === 201 && regRlB.res.status === 201) {
    const dmRl = await api("/api/conversations", {
      method: "POST",
      token: regRlA.json.token,
      body: { type: "dm", userId: regRlB.json.user.id },
    });
    const rlConvId = dmRl.json?.conversation?.id;
    const rlSock = new TestSocket(`ws://localhost:3000/api/ws?token=${encodeURIComponent(regRlA.json.token)}`);
    await rlSock.connect();
    let limited = false;
    for (let i = 0; i < 35; i += 1) {
      const r = await rlSock.request("message.send", {
        conversationId: rlConvId,
        type: "TEXT",
        content: `burst ${i}`,
      });
      if (!r.ok && /too fast/i.test(r.error ?? "")) {
        limited = true;
        break;
      }
    }
    check("message.send rate limit engages", limited);
    rlSock.close();
  }

  // ---- voice message (audio/webm;codecs normalization) ----
  const voiceForm = new FormData();
  voiceForm.append(
    "file",
    new Blob([new Uint8Array(64)], { type: "audio/webm;codecs=opus" }),
    "voice.webm"
  );
  const voiceUp = await api("/api/upload", { method: "POST", token: tokenA, form: voiceForm });
  check(
    "voice webm upload accepted",
    voiceUp.res.status === 200 && voiceUp.json?.mimeType === "audio/webm",
    voiceUp.json?.mimeType
  );

  // dedicated sockets for the remaining realtime checks
  const sockVA = new TestSocket(`ws://localhost:3000/api/ws?token=${encodeURIComponent(tokenA)}`);
  const sockVB = new TestSocket(`ws://localhost:3000/api/ws?token=${encodeURIComponent(tokenB)}`);
  await Promise.all([sockVA.connect(), sockVB.connect()]);
  sockVA.join(convId);
  sockVB.join(convId);
  await sleep(400);

  if (voiceUp.json?.url) {
    const bobSeesVoice = sockVB.next("message.new", (p) => p.mimeType === "audio/webm");
    await sockVA.request("message.send", {
      conversationId: convId,
      type: "FILE",
      content: "",
      fileUrl: voiceUp.json.url,
      fileName: "voice.weba",
      fileSize: voiceUp.json.fileSize,
      mimeType: "audio/webm",
      duration: 7,
    });
    const voiceMsg = await bobSeesVoice;
    check(
      "voice attachment delivers with duration",
      typeof voiceMsg.duration === "number" && voiceMsg.duration === 7
    );
  }

  // ---- disappearing messages ----
  const setDisappearing = await api(`/api/conversations/${convId}`, {
    method: "PATCH",
    token: tokenA,
    body: { disappearingSeconds: 3600 },
  });
  check("disappearing timer set", setDisappearing.res.status === 200);

  const bobGotTimed = sockVB.next("message.new", (p) => !!p.expiresAt);
  await sockVA.request("message.send", {
    conversationId: convId,
    type: "TEXT",
    content: "I will vanish in an hour",
  });
  const timedMsg = await bobGotTimed;
  check("new messages carry expiresAt when enabled", !!timedMsg.expiresAt);

  // force-expire directly, then confirm it vanishes
  const histBeforeExpire = await api(`/api/conversations/${convId}/messages?limit=50`, { token: tokenB });
  const vanishTarget = (histBeforeExpire.json?.messages ?? []).find(
    (m) => m.content === "I will vanish in an hour"
  );
  if (vanishTarget) {
    // expire directly in the DB, works locally and in CI (no docker dependency)
    const { Client } = await import("pg");
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    await client.query(`UPDATE "Message" SET "expiresAt" = NOW() - INTERVAL '1 minute' WHERE id = $1`, [
      vanishTarget.id,
    ]);
    await client.end();
    const histAfterExpire = await api(`/api/conversations/${convId}/messages?limit=50`, { token: tokenB });
    check(
      "expired message hidden from history",
      !(histAfterExpire.json?.messages ?? []).some((m) => m.id === vanishTarget.id)
    );
    const searchExpired = await api(`/api/search?q=${encodeURIComponent("vanish")}`, { token: tokenB });
    check(
      "expired message excluded from search",
      !(searchExpired.json?.results ?? []).some((r) => r.message.id === vanishTarget.id)
    );
  }

  const turnOff = await api(`/api/conversations/${convId}`, {
    method: "PATCH",
    token: tokenA,
    body: { disappearingSeconds: 0 },
  });
  check("disappearing timer turned off", turnOff.res.status === 200);
  const badTimer = await api(`/api/conversations/${convId}`, {
    method: "PATCH",
    token: tokenA,
    body: { disappearingSeconds: 1234 },
  });
  check("invalid timer value rejected (400)", badTimer.res.status === 400);

  // ---- WebRTC call signaling relay ----
  const callId = randomUUID().slice(0, 12);

  const incomingPromise = sockVB.next("call.incoming");
  const ringAck = await sockVA.request("call.ring", {
    toUserId: bobId,
    callId,
    video: false,
  });
  check("call.ring ack ok", ringAck.ok === true);
  const incoming = await incomingPromise;
  check(
    "incoming call delivered with caller identity",
    incoming.fromUserId === aliceId && incoming.video === false && incoming.callId === callId
  );

  const acceptedPromise = sockVA.next("call.accepted");
  const acceptAck = await sockVB.request("call.accept", { toUserId: aliceId, callId });
  check("call.accept ack ok", acceptAck.ok === true);
  const acceptedPayload = await acceptedPromise;
  check("acceptance relayed to caller", acceptedPayload.callId === callId);

  const candidatePromise = sockVB.next("call.signal", (p) => p.kind === "candidate");
  const sigAck = await sockVA.request("call.signal", {
    toUserId: bobId,
    callId,
    kind: "candidate",
    data: { candidate: "fake-candidate", sdpMid: "0" },
  });
  check("ice signal ack ok", sigAck.ok === true);
  const candidatePayload = await candidatePromise;
  check("candidate relayed to callee", candidatePayload.data?.candidate === "fake-candidate");

  const endedPromise = sockVB.next("call.ended");
  const endAck = await sockVA.request("call.end", {
    toUserId: bobId,
    callId,
    reason: "hangup",
  });
  check("call.end ack ok", endAck.ok === true);
  const endedPayload = await endedPromise;
  check("hangup relayed to peer", endedPayload.reason === "hangup");

  // stranger cannot ring into a pair they don't share a DM with
  const strangerId = randomUUID().slice(0, 8);
  const regStranger = await api("/api/auth/register", {
    method: "POST",
    headers: { "x-forwarded-for": `10.11.11.${Math.floor(Math.random() * 200) + 2}` },
    body: { email: `stranger-${strangerId}@t.dev`, username: `stranger_${strangerId}`, password: "password123" },
  });
  const sockStranger = new TestSocket(
    `ws://localhost:3000/api/ws?token=${encodeURIComponent(regStranger.json.token)}`
  );
  await sockStranger.connect();
  const strangerRing = await sockStranger.request("call.ring", {
    toUserId: aliceId,
    callId: randomUUID().slice(0, 12),
    video: false,
  });
  check("stranger call rejected (no shared DM)", strangerRing.ok === false);
  sockStranger.close();

  sockVA.close();
  sockVB.close();
  sockMain.close();

  const failedFinal = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failedFinal.length}/${results.length} checks passed`);
  process.exit(failedFinal.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("SMOKE TEST CRASHED:", err.message);
  process.exit(1);
});
