"use client";

import type { Envelope, MessageDTO } from "./types";

export interface AckResult {
  ok: boolean;
  message?: MessageDTO;
  error?: string;
}

type Handler = (payload: unknown) => void;
interface PendingAck {
  resolve: (result: AckResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

const MAX_RECONNECT_DELAY_MS = 30_000;
const BASE_RECONNECT_DELAY_MS = 500;
const ACK_TIMEOUT_MS = 8_000;

/**
 * Hand-rolled WebSocket client.
 *
 * Owns everything Socket.IO used to hide:
 * - JSON envelope protocol ({ t: type, p: payload, c?: correlationId })
 * - exponential-backoff reconnection with jitter
 * - request/ack correlation for message sends
 * - automatic room re-join after a reconnect
 */
export class FireChatSocket {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<Handler>>();
  private pendingAcks = new Map<string, PendingAck>();
  private joinedRooms = new Set<string>();
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private manuallyClosed = false;

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    if (typeof window === "undefined") return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.manuallyClosed = false;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/api/ws`);
    this.ws = socket;

    socket.onopen = () => {
      this.attempts = 0;
      for (const conversationId of this.joinedRooms) {
        this.rawSend({ t: "conversation.join", p: { conversationId } });
      }
      const openSet = this.handlers.get("__open");
      if (openSet) for (const handler of [...openSet]) handler(undefined);
    };

    socket.onmessage = (event: MessageEvent) => {
      this.handleFrame(event.data);
    };

    socket.onclose = () => {
      this.failAllPendingAcks("Disconnected");
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      socket.close();
    };
  }

  send(type: string, payload?: unknown): void {
    this.rawSend({ t: type, p: payload });
  }

  sendWithAck(
    type: string,
    payload: unknown,
    timeoutMs = ACK_TIMEOUT_MS
  ): Promise<AckResult> {
    return new Promise((resolve) => {
      if (!this.isOpen) {
        resolve({ ok: false, error: "Not connected" });
        return;
      }
      const cid = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
      const timer = setTimeout(() => {
        this.pendingAcks.delete(cid);
        resolve({ ok: false, error: "Request timed out" });
      }, timeoutMs);
      this.pendingAcks.set(cid, { resolve, timer });
      this.rawSend({ t: type, p: payload, c: cid });
    });
  }

  join(conversationId: string): void {
    this.joinedRooms.add(conversationId);
    this.send("conversation.join", { conversationId });
  }

  leave(conversationId: string): void {
    this.joinedRooms.delete(conversationId);
    this.send("conversation.leave", { conversationId });
  }

  on(type: string, handler: Handler): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
      if (set.size === 0) this.handlers.delete(type);
    };
  }

  /** Fires every time the socket reaches an open state, including reconnects. */
  onOpen(handler: () => void): () => void {
    return this.on("__open", handler);
  }

  close(): void {
    this.manuallyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.failAllPendingAcks("Disconnected");
    this.ws?.close();
    this.ws = null;
  }

  /* internals */

  private handleFrame(data: unknown): void {
    let envelope: Envelope;
    try {
      envelope = JSON.parse(String(data)) as Envelope;
    } catch {
      return;
    }

    if (envelope.t === "ack" && typeof envelope.c === "string") {
      const pending = this.pendingAcks.get(envelope.c);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingAcks.delete(envelope.c);
        pending.resolve((envelope.p as AckResult | undefined) ?? { ok: false, error: "Malformed ack" });
      }
      return;
    }

    const set = this.handlers.get(envelope.t);
    if (set) {
      for (const handler of set) handler(envelope.p);
    }
  }

  private rawSend(envelope: Envelope): void {
    if (this.isOpen && this.ws) {
      this.ws.send(JSON.stringify(envelope));
    }
  }

  private failAllPendingAcks(reason: string): void {
    for (const [, pending] of this.pendingAcks) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: reason });
    }
    this.pendingAcks.clear();
  }

  private scheduleReconnect(): void {
    if (this.manuallyClosed) return;
    const delay = Math.min(MAX_RECONNECT_DELAY_MS, BASE_RECONNECT_DELAY_MS * 2 ** this.attempts) +
      Math.random() * 400;
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}

const globalForClient = globalThis as unknown as { __firechat_wsclient?: FireChatSocket };

export function getWs(): FireChatSocket {
  if (!globalForClient.__firechat_wsclient) {
    globalForClient.__firechat_wsclient = new FireChatSocket();
  }
  return globalForClient.__firechat_wsclient;
}
