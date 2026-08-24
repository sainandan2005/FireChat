import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { prisma } from "./prisma";
import { AUTH_COOKIE, verifyToken } from "./jwt";
import { sendPushToUser } from "./push-server";
import { checkRateLimit } from "./rate-limit";
import { initRedisFanout, nodeId, publishFanout, redisEnabled } from "./pubsub";
import { toMessageDTO } from "./summaries";
import type { Envelope, MessageType } from "./types";

export const WS_PATH = "/api/ws";

const HEARTBEAT_INTERVAL_MS = 30_000;
const MESSAGE_MAX_LENGTH = 4000;
const TYPING_TIMEOUT_MS = 5000;

interface Conn {
  id: string;
  userId: string;
  socket: WebSocket;
  rooms: Set<string>;
  isAlive: boolean;
}

type EnvelopeHandler = (conn: Conn, payload: unknown, cid?: string) => void | Promise<void>;

/**
 * The custom server (tsx) and Next's bundled route handlers load this module as
 * SEPARATE instances, so module-level state would fork into two disconnected
 * registries. Stashing everything on globalThis keeps one process-wide source
 * of truth, the same trick the Prisma singleton uses.
 */
interface WsState {
  wss?: WebSocketServer;
  connsByUser: Map<string, Set<Conn>>;
  rooms: Map<string, Set<Conn>>;
  typingTimers: Map<string, ReturnType<typeof setTimeout>>;
}

const globalForWs = globalThis as unknown as { __firechat_ws?: WsState };

function wsState(): WsState {
  if (!globalForWs.__firechat_ws) {
    globalForWs.__firechat_ws = {
      connsByUser: new Map(),
      rooms: new Map(),
      typingTimers: new Map(),
    };
  }
  return globalForWs.__firechat_ws;
}

/* ---------------- outbound helpers (used by REST routes too) ---------------- */

function send(conn: Conn, env: Envelope): void {
  if (conn.socket.readyState === conn.socket.OPEN) {
    conn.socket.send(JSON.stringify(env));
  }
}

/* local-only delivery, the exported wrappers add Redis fan-out */
function localEmitToUser(userId: string, env: Envelope): void {
  const conns = Array.from(wsState().connsByUser.get(userId) ?? []);
  if (env.t === "conversation.new-message") {
  }
  for (const conn of conns) send(conn, env);
}

function localEmitToConversation(conversationId: string, env: Envelope): void {
  for (const conn of wsState().rooms.get(conversationId) ?? []) send(conn, env);
}

function localBroadcastAll(env: Envelope): void {
  for (const set of wsState().connsByUser.values()) {
    for (const conn of set) send(conn, env);
  }
}

function redisOn(): boolean {
  return redisEnabled();
}

export function emitToUser(userId: string, env: Envelope): void {
  localEmitToUser(userId, env);
  if (redisOn()) publishFanout({ scope: "user", target: userId, origin: nodeId(), env });
}


export function emitToConversation(conversationId: string, env: Envelope): void {
  localEmitToConversation(conversationId, env);
  if (redisOn()) publishFanout({ scope: "conv", target: conversationId, origin: nodeId(), env });
}

export function onlineUserIds(): string[] {
  return Array.from(wsState().connsByUser.keys());
}


/* --------------------------------- auth ---------------------------------- */

function extractCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

async function authenticate(req: IncomingMessage, url: URL): Promise<string | null> {
  const token =
    extractCookie(req.headers.cookie, AUTH_COOKIE) ?? url.searchParams.get("token");
  if (!token) return null;

  const claims = await verifyToken(token);
  if (!claims) return null;

  // revoked / expired sessions are rejected at the door
  const session = await prisma.session.findUnique({
    where: { id: claims.sessionId },
    select: { userId: true, expiresAt: true, revokedAt: true },
  });
  if (!session || session.revokedAt || session.expiresAt <= new Date()) return null;
  if (session.userId !== claims.userId) return null;

  return session.userId;
}

/* ------------------------------ registry ops ----------------------------- */

function register(conn: Conn): void {
  let set = wsState().connsByUser.get(conn.userId);
  const wasOnline = set !== undefined && set.size > 0;
  if (!set) {
    set = new Set();
    wsState().connsByUser.set(conn.userId, set);
  }
  set.add(conn);

  if (!wasOnline) {
    broadcastAll({ t: "presence.update", p: { userId: conn.userId, online: true } });
  }
}

function unregister(conn: Conn): void {
  for (const roomId of conn.rooms) {
    wsState().rooms.get(roomId)?.delete(conn);
    if (wsState().rooms.get(roomId)?.size === 0) wsState().rooms.delete(roomId);
  }
  conn.rooms.clear();

  const set = wsState().connsByUser.get(conn.userId);
  if (set) {
    set.delete(conn);
    if (set.size === 0) {
      wsState().connsByUser.delete(conn.userId);

      const now = new Date();
      void prisma.user
        .update({ where: { id: conn.userId }, data: { lastSeenAt: now } })
        .then(() => {
          broadcastAll({
            t: "presence.update",
            p: { userId: conn.userId, online: false, lastSeenAt: now.toISOString() },
          });
        })
        .catch(() => {});
    }
  }

  for (const [key, timer] of wsState().typingTimers) {
    if (key.endsWith(`:${conn.userId}`)) {
      clearTimeout(timer);
      wsState().typingTimers.delete(key);
    }
  }
}

function joinRoom(conn: Conn, conversationId: string): void {
  let room = wsState().rooms.get(conversationId);
  if (!room) {
    room = new Set();
    wsState().rooms.set(conversationId, room);
  }
  room.add(conn);
  conn.rooms.add(conversationId);
}

function leaveRoom(conn: Conn, conversationId: string): void {
  wsState().rooms.get(conversationId)?.delete(conn);
  conn.rooms.delete(conversationId);
}

function broadcastAll(env: Envelope): void {
  localBroadcastAll(env);
  if (redisOn()) publishFanout({ scope: "all", origin: nodeId(), env });
}

/* ------------------------------- validation ------------------------------ */

async function isParticipant(userId: string, conversationId: string): Promise<boolean> {
  const participant = await prisma.participant.findUnique({
    where: { userId_conversationId: { userId, conversationId } },
    select: { id: true },
  });
  return participant !== null;
}

function clearTyping(conversationId: string, userId: string): void {
  const key = `${conversationId}:${userId}`;
  const timer = wsState().typingTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    wsState().typingTimers.delete(key);
  }
}

/* -------------------------------- handlers ------------------------------- */

const handlers: Record<string, EnvelopeHandler> = {
  "conversation.join": async (conn, payload) => {
    const { conversationId } = payload as { conversationId?: unknown };
    if (typeof conversationId !== "string") return;
    if (await isParticipant(conn.userId, conversationId)) {
      joinRoom(conn, conversationId);
    }
  },

  "conversation.leave": (conn, payload) => {
    const { conversationId } = payload as { conversationId?: unknown };
    if (typeof conversationId !== "string") return;
    leaveRoom(conn, conversationId);
  },

  "message.send": async (conn, payload, cid) => {
    const ackError = (error: string) =>
      send(conn, { t: "ack", c: cid, p: { ok: false, error } });

    try {
      const p = payload as Partial<{
        conversationId: unknown;
        type: unknown;
        content: unknown;
        fileUrl: unknown;
        fileName: unknown;
        fileSize: unknown;
        mimeType: unknown;
        replyToId: unknown;
        duration: unknown;
      }>;
      if (typeof p.conversationId !== "string") {
        ackError("Invalid payload");
        return;
      }
      if (!checkRateLimit(`msg:${conn.userId}`, 30, 10_000)) {
        ackError("You're sending messages too fast");
        return;
      }
      const conversationId = p.conversationId;

      const type: MessageType =
        p.type === "IMAGE" || p.type === "FILE" ? p.type : "TEXT";

      let content = typeof p.content === "string" ? p.content.trim() : "";
      if (content.length > MESSAGE_MAX_LENGTH) content = content.slice(0, MESSAGE_MAX_LENGTH);

      if (type === "TEXT" && !content) {
        ackError("Message is empty");
        return;
      }
      if (type !== "TEXT" && (typeof p.fileUrl !== "string" || !p.fileUrl)) {
        ackError("Attachment URL is missing");
        return;
      }

      if (!(await isParticipant(conn.userId, conversationId))) {
        ackError("Not a participant");
        return;
      }

      const targetConversation = await prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { disappearingSeconds: true, isGroup: true, name: true },
      });

      const created = await prisma.message.create({
        data: {
          conversationId,
          senderId: conn.userId,
          type,
          content: content || null,
          fileUrl: typeof p.fileUrl === "string" ? p.fileUrl : null,
          fileName: typeof p.fileName === "string" ? p.fileName : null,
          fileSize: typeof p.fileSize === "number" ? Math.trunc(p.fileSize) : null,
          mimeType: typeof p.mimeType === "string" ? p.mimeType : null,
          duration:
            typeof p.duration === "number" && p.duration >= 0
              ? Math.min(Math.trunc(p.duration), 3600)
              : null,
          ...(targetConversation?.disappearingSeconds
            ? { expiresAt: new Date(Date.now() + targetConversation.disappearingSeconds * 1000) }
            : {}),
          ...(typeof p.replyToId === "string" && p.replyToId ? { replyToId: p.replyToId } : {}),
        },
        include: {
          replyTo: { include: { sender: { select: { id: true, username: true } } } },
        },
      });
      const dto = toMessageDTO(created);

      // bump so GET /api/conversations reorders this chat to the top
      await prisma.conversation.update({
        where: { id: conversationId },
        data: { updatedAt: created.createdAt },
      });

      emitToConversation(conversationId, { t: "message.new", p: dto });

      const participants = await prisma.participant.findMany({
        where: { conversationId },
        select: { userId: true },
      });

      // push notifications + delivery receipts for participants with live sockets
      const [sender] = await Promise.all([
        prisma.user.findUnique({ where: { id: conn.userId }, select: { username: true } }),
      ]);
      const preview =
        dto.type === "IMAGE"
          ? "📷 Photo"
          : dto.type === "FILE"
            ? dto.mimeType?.startsWith("audio/")
              ? "🎤 Voice message"
              : `📎 ${dto.fileName ?? "File"}`
            : (dto.content ?? "").slice(0, 120);
      const pushTitle = targetConversation?.isGroup
        ? `${sender?.username ?? "Someone"} in ${targetConversation.name ?? "the group"}`
        : (sender?.username ?? "Someone");

      const now = new Date();
      const deliveredTo: string[] = [];
      for (const { userId } of participants) {
        if (userId !== conn.userId) {
          emitToUser(userId, { t: "conversation.new-message", p: { conversationId, message: dto } });
          if (!wsState().connsByUser.has(userId)) {
            void sendPushToUser(userId, {
              title: pushTitle,
              body: preview,
              conversationId,
            });
          } else {
            deliveredTo.push(userId);
          }
        }
      }
      if (deliveredTo.length > 0) {
        await prisma.participant.updateMany({
          where: { conversationId, userId: { in: deliveredTo } },
          data: { lastDeliveredAt: now },
        });
        emitToUser(conn.userId, {
          t: "delivery.update",
          p: deliveredTo.map((userId) => ({
            conversationId,
            userId,
            lastDeliveredAt: now.toISOString(),
          })),
        });
      }

      clearTyping(conversationId, conn.userId);
      for (const peer of wsState().rooms.get(conversationId) ?? []) {
        if (peer.userId !== conn.userId) {
          send(peer, {
            t: "typing.update",
            p: { conversationId, userId: conn.userId, typing: false },
          });
        }
      }

      send(conn, { t: "ack", c: cid, p: { ok: true, message: dto } });
    } catch {
      ackError("Failed to send message");
    }
  },

  "typing.start": async (conn, payload) => {
    const { conversationId } = payload as { conversationId?: unknown };
    if (typeof conversationId !== "string") return;
    if (!(await isParticipant(conn.userId, conversationId))) return;

    const key = `${conversationId}:${conn.userId}`;
    const existing = wsState().typingTimers.get(key);
    if (existing) clearTimeout(existing);
    wsState().typingTimers.set(
      key,
      setTimeout(() => {
        wsState().typingTimers.delete(key);
        for (const peer of wsState().rooms.get(conversationId) ?? []) {
          if (peer.userId !== conn.userId) {
            send(peer, {
              t: "typing.update",
              p: { conversationId, userId: conn.userId, typing: false },
            });
          }
        }
      }, TYPING_TIMEOUT_MS)
    );

    for (const peer of wsState().rooms.get(conversationId) ?? []) {
      if (peer.userId !== conn.userId) {
        send(peer, {
          t: "typing.update",
          p: { conversationId, userId: conn.userId, typing: true },
        });
      }
    }
  },

  "typing.stop": async (conn, payload) => {
    const { conversationId } = payload as { conversationId?: unknown };
    if (typeof conversationId !== "string") return;
    if (!(await isParticipant(conn.userId, conversationId))) return;

    clearTyping(conversationId, conn.userId);
    for (const peer of wsState().rooms.get(conversationId) ?? []) {
      if (peer.userId !== conn.userId) {
        send(peer, {
          t: "typing.update",
          p: { conversationId, userId: conn.userId, typing: false },
        });
      }
    }
  },

  "message.edit": async (conn, payload, cid) => {
    const ackFail = (error: string) =>
      send(conn, { t: "ack", c: cid, p: { ok: false, error } });
    try {
      const p = payload as { messageId?: unknown; content?: unknown };
      if (typeof p.messageId !== "string") {
        ackFail("Invalid payload");
        return;
      }
      let content = typeof p.content === "string" ? p.content.trim() : "";
      if (!content) {
        ackFail("Message is empty");
        return;
      }
      if (content.length > MESSAGE_MAX_LENGTH) content = content.slice(0, MESSAGE_MAX_LENGTH);

      const message = await prisma.message.findUnique({ where: { id: p.messageId } });
      if (!message || message.deletedAt) {
        ackFail("Message not found");
        return;
      }
      if (message.senderId !== conn.userId) {
        ackFail("You can only edit your own messages");
        return;
      }
      if (message.type !== "TEXT") {
        ackFail("Only text messages can be edited");
        return;
      }
      if (!(await isParticipant(conn.userId, message.conversationId))) {
        ackFail("Not a participant");
        return;
      }

      const updated = await prisma.message.update({
        where: { id: message.id },
        data: { content, editedAt: new Date() },
      });

      emitToConversation(message.conversationId, {
        t: "message.updated",
        p: { message: toMessageDTO(updated) },
      });
      send(conn, { t: "ack", c: cid, p: { ok: true, message: toMessageDTO(updated) } });
    } catch {
      ackFail("Failed to edit message");
    }
  },

  "message.delete": async (conn, payload, cid) => {
    const ackFail = (error: string) =>
      send(conn, { t: "ack", c: cid, p: { ok: false, error } });
    try {
      const p = payload as { messageId?: unknown };
      if (typeof p.messageId !== "string") {
        ackFail("Invalid payload");
        return;
      }

      const message = await prisma.message.findUnique({ where: { id: p.messageId } });
      if (!message || message.deletedAt) {
        ackFail("Message not found");
        return;
      }
      if (message.senderId !== conn.userId) {
        ackFail("You can only delete your own messages");
        return;
      }
      if (!(await isParticipant(conn.userId, message.conversationId))) {
        ackFail("Not a participant");
        return;
      }

      await prisma.message.update({
        where: { id: message.id },
        data: { deletedAt: new Date() },
      });

      emitToConversation(message.conversationId, {
        t: "message.deleted",
        p: { messageId: message.id, conversationId: message.conversationId },
      });
      send(conn, { t: "ack", c: cid, p: { ok: true } });
    } catch {
      ackFail("Failed to delete message");
    }
  },

  "reaction.toggle": async (conn, payload, cid) => {
    const ackFail = (error: string) =>
      send(conn, { t: "ack", c: cid, p: { ok: false, error } });
    try {
      const p = payload as { messageId?: unknown; emoji?: unknown };
      if (typeof p.messageId !== "string" || typeof p.emoji !== "string") {
        ackFail("Invalid payload");
        return;
      }
      const emoji = [...p.emoji].slice(0, 8).join("");
      if (!emoji) {
        ackFail("Emoji is empty");
        return;
      }

      const message = await prisma.message.findUnique({
        where: { id: p.messageId },
        select: { id: true, conversationId: true, deletedAt: true },
      });
      if (!message || message.deletedAt) {
        ackFail("Message not found");
        return;
      }
      if (!(await isParticipant(conn.userId, message.conversationId))) {
        ackFail("Not a participant");
        return;
      }

      const existing = await prisma.reaction.findUnique({
        where: { messageId_userId_emoji: { messageId: message.id, userId: conn.userId, emoji } },
        select: { id: true },
      });
      if (existing) {
        await prisma.reaction.delete({ where: { id: existing.id } });
      } else {
        await prisma.reaction.create({
          data: { messageId: message.id, userId: conn.userId, emoji },
        });
      }

      const reactions = await prisma.reaction.findMany({
        where: { messageId: message.id },
        select: { userId: true, emoji: true },
      });

      emitToConversation(message.conversationId, {
        t: "reaction.updated",
        p: { messageId: message.id, conversationId: message.conversationId, reactions },
      });
      send(conn, { t: "ack", c: cid, p: { ok: true } });
    } catch {
      ackFail("Failed to toggle reaction");
    }
  },

  "receipt.markDelivered": async (conn, payload) => {
    const p = payload as { conversationId?: unknown };
    if (typeof p.conversationId !== "string") return;
    if (!(await isParticipant(conn.userId, p.conversationId))) return;

    const now = new Date();
    await prisma.participant.update({
      where: { userId_conversationId: { userId: conn.userId, conversationId: p.conversationId } },
      data: { lastDeliveredAt: now },
    });

    // everyone ELSE cares that this user has caught up (their ticks flip)
    const entry = {
      conversationId: p.conversationId,
      userId: conn.userId,
      lastDeliveredAt: now.toISOString(),
    };
    const participants = await prisma.participant.findMany({
      where: { conversationId: p.conversationId },
      select: { userId: true },
    });
    for (const { userId } of participants) {
      if (userId !== conn.userId) {
        emitToUser(userId, { t: "delivery.update", p: [entry] });
      }
    }
    // and echo to the user's own devices so their sidebar stays consistent
    emitToUser(conn.userId, { t: "delivery.update", p: [entry] });
  },

  "receipt.markRead": async (conn, payload) => {
    const { conversationId } = payload as { conversationId?: unknown };
    if (typeof conversationId !== "string") return;
    if (!(await isParticipant(conn.userId, conversationId))) return;

    const now = new Date();
    await prisma.participant.update({
      where: { userId_conversationId: { userId: conn.userId, conversationId } },
      data: { lastReadAt: now },
    });
    const receipt = {
      conversationId,
      userId: conn.userId,
      lastReadAt: now.toISOString(),
    };
    emitToConversation(conversationId, { t: "receipt.update", p: receipt });
    emitToUser(conn.userId, { t: "receipt.update", p: receipt });
  },
};

/* ------------------------------ call signaling --------------------------- */

async function findSharedDm(a: string, b: string): Promise<boolean> {
  const conv = await prisma.conversation.findFirst({
    where: {
      isGroup: false,
      AND: [
        { participants: { some: { userId: a } } },
        { participants: { some: { userId: b } } },
      ],
    },
    select: { id: true, participants: { select: { userId: true } } },
  });
  return !!conv && conv.participants.length === 2;
}

const CALL_SIGNAL_KINDS = new Set(["description", "candidate"]);
const MAX_SIGNAL_BYTES = 64 * 1024;

function registerCallHandlers(map: Record<string, EnvelopeHandler>): void {
  const relay = (
    conn: Conn,
    payload: { toUserId?: unknown; callId?: unknown },
    event: string,
    build: (fromUsername: string) => unknown,
    ack?: (ok: boolean, error?: string) => void
  ): Promise<void> =>
    (async () => {
      try {
        const toUserId = typeof payload.toUserId === "string" ? payload.toUserId : "";
        const callId = typeof payload.callId === "string" ? payload.callId : "";
        if (!toUserId || !callId || toUserId === conn.userId) {
          ack?.(false, "Invalid payload");
          return;
        }
        if (!(await findSharedDm(conn.userId, toUserId))) {
          ack?.(false, "No shared conversation");
          return;
        }
        const from = await prisma.user.findUnique({
          where: { id: conn.userId },
          select: { username: true },
        });
        emitToUser(toUserId, {
          t: event,
          p: build(from?.username ?? "Someone"),
        });
        ack?.(true);
      } catch {
        ack?.(false, "Signaling failed");
      }
    })();

  map["call.ring"] = async (conn, payload, cid) => {
    const p = payload as { toUserId?: unknown; callId?: unknown; video?: unknown };
    await relay(
      conn,
      p,
      "call.incoming",
      (fromUsername) => ({
        callId: p.callId,
        fromUserId: conn.userId,
        fromUsername,
        video: p.video === true,
      }),
      (ok, error) => send(conn, { t: "ack", c: cid, p: { ok, error } })
    );
  };

  map["call.accept"] = async (conn, payload, cid) => {
    await relay(
      conn,
      payload as { toUserId?: unknown; callId?: unknown },
      "call.accepted",
      () => ({ callId: (payload as { callId?: unknown }).callId, fromUserId: conn.userId }),
      (ok, error) => send(conn, { t: "ack", c: cid, p: { ok, error } })
    );
  };

  map["call.signal"] = async (conn, payload, cid) => {
    const p = payload as { toUserId?: unknown; callId?: unknown; kind?: unknown; data?: unknown };
    if (typeof p.kind !== "string" || !CALL_SIGNAL_KINDS.has(p.kind)) {
      send(conn, { t: "ack", c: cid, p: { ok: false, error: "Invalid signal kind" } });
      return;
    }
    if (JSON.stringify(p.data ?? null).length > MAX_SIGNAL_BYTES) {
      send(conn, { t: "ack", c: cid, p: { ok: false, error: "Signal too large" } });
      return;
    }
    await relay(
      conn,
      p,
      "call.signal",
      () => ({ callId: p.callId, fromUserId: conn.userId, kind: p.kind, data: p.data }),
      (ok, error) => send(conn, { t: "ack", c: cid, p: { ok, error } })
    );
  };

  map["call.end"] = async (conn, payload, cid) => {
    const p = payload as { toUserId?: unknown; callId?: unknown; reason?: unknown };
    await relay(
      conn,
      p,
      "call.ended",
      () => ({
        callId: p.callId,
        fromUserId: conn.userId,
        reason: typeof p.reason === "string" ? p.reason : "hangup",
      }),
      (ok, error) => send(conn, { t: "ack", c: cid, p: { ok, error } })
    );
  };
}

registerCallHandlers(handlers);

/* --------------------------------- server -------------------------------- */

function dispatch(conn: Conn, raw: unknown): void {
  let envelope: Envelope;
  try {
    envelope = JSON.parse(String(raw)) as Envelope;
  } catch {
    send(conn, { t: "error", p: { message: "Invalid JSON frame" } });
    return;
  }

  if (typeof envelope.t !== "string") {
    send(conn, { t: "error", p: { message: "Missing event type" } });
    return;
  }

  const handler = handlers[envelope.t];
  if (!handler) {
    send(conn, { t: "error", p: { message: `Unknown event "${envelope.t}"` } });
    return;
  }

  void Promise.resolve(handler(conn, envelope.p, envelope.c)).catch(() => {
    if (envelope.c) {
      send(conn, { t: "ack", c: envelope.c, p: { ok: false, error: "Internal error" } });
    }
  });
}

function startHeartbeat(wss: WebSocketServer): NodeJS.Timeout {
  const interval = setInterval(() => {
    for (const client of wss.clients) {
      const conn = client as WebSocket & { __conn?: Conn };
      if (conn.__conn === undefined) continue;
      if (!conn.__conn.isAlive) {
        conn.terminate();
        continue;
      }
      conn.__conn.isAlive = false;
      conn.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  interval.unref();
  return interval;
}

export function attachWebSocketServer(httpServer: import("node:http").Server): void {
  const wss = new WebSocketServer({ noServer: true });
  wsState().wss = wss;

  httpServer.on("upgrade", async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    } catch {
      return;
    }
    if (url.pathname !== WS_PATH) return;

    const userId = await authenticate(req, url);
    if (!userId) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn: Conn = {
        id: randomUUID(),
        userId,
        socket: ws,
        rooms: new Set(),
        isAlive: true,
      };
      (ws as WebSocket & { __conn?: Conn }).__conn = conn;

      register(conn);

      ws.send(JSON.stringify({ t: "ready", p: { userId } }));
      ws.send(JSON.stringify({ t: "presence.list", p: onlineUserIds() }));

      ws.on("pong", () => {
        conn.isAlive = true;
      });

      ws.on("message", (data) => {
        dispatch(conn, data);
      });

      ws.on("close", () => {
        unregister(conn);
      });

      ws.on("error", (err) => {
        console.error(`[ws] socket error user=…${userId.slice(-6)}: ${err.message}`);
        unregister(conn);
        ws.terminate();
      });
    });
  });

  startHeartbeat(wss);
  startExpirySweeper();

  initRedisFanout((msg) => {
    switch (msg.scope) {
      case "user":
        localEmitToUser(msg.target as string, msg.env);
        break;
      case "conv":
        localEmitToConversation(msg.target as string, msg.env);
        break;
      default:
        localBroadcastAll(msg.env);
    }
  });
}

/** Hard-deletes expired disappearing messages and tells live clients. */
function startExpirySweeper(): NodeJS.Timeout {
  const interval = setInterval(async () => {
    try {
      const expired = await prisma.message.findMany({
        where: { expiresAt: { lt: new Date() } },
        select: { id: true, conversationId: true },
      });
      if (expired.length === 0) return;
      await prisma.message.deleteMany({
        where: { id: { in: expired.map((m) => m.id) } },
      });
      for (const m of expired) {
        emitToConversation(m.conversationId, {
          t: "message.deleted",
          p: { messageId: m.id, conversationId: m.conversationId },
        });
      }
    } catch {
      /* next sweep retries */
    }
  }, 30_000);
  interval.unref();
  return interval;
}

