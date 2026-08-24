import { randomUUID } from "node:crypto";
import type { Envelope } from "./types";

/**
 * Optional Redis fan-out so the WebSocket layer can scale beyond one node.
 *
 * When REDIS_URL is set, every emit is also published to a channel; each node
 * subscribes and delivers to its locally-connected sockets (skipping its own
 * origin). Without REDIS_URL everything stays in-process, zero overhead.
 */

export interface FanoutMessage {
  scope: "user" | "conv" | "all";
  target?: string;
  origin: string;
  env: Envelope;
}

interface PubsubState {
  nodeId: string;
  enabled: boolean;
  pub: unknown;
  sub: unknown;
  handler?: (msg: FanoutMessage) => void;
}

const globalForPubsub = globalThis as unknown as { __firechat_pubsub?: PubsubState };

function ensure(): PubsubState {
  if (!globalForPubsub.__firechat_pubsub) {
    globalForPubsub.__firechat_pubsub = { nodeId: randomUUID(), enabled: false, pub: null, sub: null };
  }
  return globalForPubsub.__firechat_pubsub;
}

export function nodeId(): string {
  return ensure().nodeId;
}

export function redisEnabled(): boolean {
  return ensure().enabled;
}

/** Wires up pub/sub once. Safe to call multiple times; no-ops without REDIS_URL. */
export function initRedisFanout(onMessage: (msg: FanoutMessage) => void): void {
  const state = ensure();
  if (state.enabled || state.pub) return;

  const url = process.env.REDIS_URL;
  if (!url) return;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Redis = require("ioredis");
    const opts = {
      lazyConnect: true,
      retryStrategy: (times: number) => (times > 20 ? null : Math.min(1000 * times, 5_000)),
    };
    const pub = new Redis(url, opts);
    const sub = new Redis(url, opts);
    pub.on("error", (err: Error) => console.error("[pubsub] pub error:", err.message));
    sub.on("error", (err: Error) => console.error("[pubsub] sub error:", err.message));

        
    sub
      .connect()
      .then(() => sub.subscribe("firechat:fanout"))
      .catch((err: Error) => console.error("[pubsub] sub subscribe:", err.message));
    sub.on("message", (_channel: string, raw: string) => {
      try {
        const msg = JSON.parse(raw) as FanoutMessage;
        if (msg.origin === state.nodeId) return;
        state.handler?.(msg);
      } catch {
        /* malformed frame */
      }
    });

    state.pub = pub;
    state.sub = sub;
    state.enabled = true;
    state.handler = onMessage;

    void pub.connect().catch((err: Error) => console.error("[pubsub] pub connect:", err.message));
  } catch (err) {
    console.error("[pubsub] init failed:", (err as Error).message);
  }
}

export function publishFanout(msg: FanoutMessage): void {
  void (async () => {
    const state = ensure();
    if (!state.enabled || !state.pub) {
      console.error("[pubsub] publish skipped: enabled=", state.enabled);
      return;
    }
    try {
      await (
        state.pub as { publish: (ch: string, v: string) => Promise<number> }
      ).publish("firechat:fanout", JSON.stringify(msg));
    } catch (err) {
      console.error("[pubsub] publish failed:", (err as Error).message);
    }
  })();
}
