import { prisma } from "./prisma";
import type { ConversationDetail, ConversationSummary, MessageDTO, MessageType, PublicUser } from "./types";

export const PUBLIC_USER_SELECT = {
  id: true,
  username: true,
  avatarUrl: true,
  lastSeenAt: true,
} as const;

export const MESSAGE_INCLUDE_SENDER = {
  sender: { select: PUBLIC_USER_SELECT },
  replyTo: {
    include: { sender: { select: { id: true, username: true } } },
  },
  reactions: { select: { userId: true, emoji: true } },
} as const;

type DbMessage = {
  id: string;
  conversationId: string;
  senderId: string;
  type: MessageType;
  content: string | null;
  fileUrl: string | null;
  fileName: string | null;
  fileSize: number | null;
  mimeType: string | null;
  createdAt: Date;
  editedAt?: Date | null;
  deletedAt?: Date | null;
  expiresAt?: Date | null;
  duration?: number | null;
  reactions?: Array<{ userId: string; emoji: string }>;
  replyTo?: {
    id: string;
    senderId: string;
    type: MessageType;
    content: string | null;
    fileName?: string | null;
    deletedAt: Date | null;
    sender: { id: string; username: string } | null;
  } | null;
};

export function toMessageDTO(message: DbMessage): MessageDTO {
  const deleted = message.deletedAt !== null && message.deletedAt !== undefined;

  let replyTo: MessageDTO["replyTo"] = null;
  if (message.replyTo) {
    const r = message.replyTo;
    const rDeleted = r.deletedAt !== null && r.deletedAt !== undefined;
    replyTo = {
      id: r.id,
      senderId: r.senderId,
      senderUsername: r.sender?.username ?? "Unknown",
      type: r.type,
      content: rDeleted
        ? null
        : r.type === "TEXT"
          ? (r.content ?? "").slice(0, 140) || null
          : r.type === "IMAGE"
            ? "📷 Photo"
            : `📎 ${r.fileName ?? "File"}`,
    };
  }

  return {
    id: message.id,
    conversationId: message.conversationId,
    senderId: message.senderId,
    type: message.type,
    // tombstones leave no trace of the original content
    content: deleted ? null : message.content,
    fileUrl: deleted ? null : message.fileUrl,
    fileName: deleted ? null : message.fileName,
    fileSize: deleted ? null : message.fileSize,
    mimeType: deleted ? null : message.mimeType,
    createdAt: message.createdAt.toISOString(),
    editedAt: message.editedAt ? message.editedAt.toISOString() : null,
    deletedAt: message.deletedAt ? message.deletedAt.toISOString() : null,
    expiresAt: message.expiresAt ? message.expiresAt.toISOString() : null,
    duration: message.duration ?? null,
    replyTo,
    reactions: message.deletedAt
      ? []
      : (message.reactions ?? []).map((r) => ({ userId: r.userId, emoji: r.emoji })),
  };
}

export function toPublicUser(user: {
  id: string;
  username: string;
  avatarUrl: string | null;
  lastSeenAt?: Date | null;
}): PublicUser {
  return {
    id: user.id,
    username: user.username,
    avatarUrl: user.avatarUrl,
    lastSeenAt: user.lastSeenAt ? user.lastSeenAt.toISOString() : null,
  };
}

interface ConversationRow {
  id: string;
  isGroup: boolean;
  name: string | null;
  avatarUrl: string | null;
  disappearingSeconds?: number | null;
  updatedAt: Date;
  participants: Array<{
    userId: string;
    role?: string;
    lastReadAt: Date | null;
    lastDeliveredAt?: Date | null;
    user: { id: string; username: string; avatarUrl: string | null; lastSeenAt?: Date | null };
  }>;
  messages: DbMessage[];
}

interface MyParticipantMeta {
  lastReadAt: Date | null;
  clearedAt?: Date | null;
  pinnedAt?: Date | null;
  muted?: boolean;
  archivedAt?: Date | null;
}

function baseSummary(
  conversation: ConversationRow,
  meId: string,
  meta: MyParticipantMeta,
  unreadCount: number
): ConversationSummary {
  return {
    id: conversation.id,
    isGroup: conversation.isGroup,
    name: conversation.name,
    avatarUrl: conversation.avatarUrl,
    updatedAt: conversation.updatedAt.toISOString(),
    lastReadAt: meta.lastReadAt ? meta.lastReadAt.toISOString() : null,
    lastMessage: conversation.messages[0] ? toMessageDTO(conversation.messages[0]) : null,
    unreadCount,
    members: conversation.participants.map((p) => toPublicUser(p.user)),
    pinnedAt: meta.pinnedAt ? meta.pinnedAt.toISOString() : null,
    muted: meta.muted ?? false,
    archivedAt: meta.archivedAt ? meta.archivedAt.toISOString() : null,
  };
}

export async function buildConversationSummary(
  conversation: ConversationRow,
  meId: string,
  meta: MyParticipantMeta,
  precomputedUnread?: number
): Promise<ConversationSummary> {
  let unreadCount = precomputedUnread;
  if (unreadCount === undefined) {
    const visibleFrom =
      meta.clearedAt && meta.lastReadAt && meta.lastReadAt > meta.clearedAt
        ? meta.lastReadAt
        : (meta.clearedAt ?? meta.lastReadAt);
    unreadCount = await prisma.message.count({
      where: {
        conversationId: conversation.id,
        senderId: { not: meId },
        ...(visibleFrom ? { createdAt: { gt: visibleFrom } } : {}),
      },
    });
  }
  return baseSummary(conversation, meId, meta, unreadCount);
}

export function buildConversationDetail(
  conversation: ConversationRow,
  meId: string,
  meta: MyParticipantMeta,
  unreadCount: number,
  myRole = "member"
): ConversationDetail {
  const readStates: Record<string, string> = {};
  const deliveryStates: Record<string, string> = {};
  let ownerId: string | null = null;
  for (const p of conversation.participants) {
    if (p.lastReadAt) readStates[p.userId] = p.lastReadAt.toISOString();
    if (p.lastDeliveredAt) deliveryStates[p.userId] = p.lastDeliveredAt.toISOString();
    if (p.role === "owner") ownerId = p.userId;
  }
  return {
    ...baseSummary(conversation, meId, meta, unreadCount),
    clearedAt: meta.clearedAt ? meta.clearedAt.toISOString() : null,
    myRole,
    ownerId,
    disappearingSeconds: conversation.disappearingSeconds ?? null,
    readStates,
    deliveryStates,
  };
}
