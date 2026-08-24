export type MessageType = "TEXT" | "IMAGE" | "FILE" | "SYSTEM";

export interface PublicUser {
  id: string;
  username: string;
  avatarUrl: string | null;
  lastSeenAt: string | null;
}

export interface ReplyPreview {
  id: string;
  senderId: string;
  senderUsername: string;
  type: MessageType;
  content: string | null;
}

export interface MessageDTO {
  id: string;
  conversationId: string;
  senderId: string;
  type: MessageType;
  content: string | null;
  fileUrl: string | null;
  fileName: string | null;
  fileSize: number | null;
  mimeType: string | null;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  expiresAt: string | null;
  duration: number | null;
  replyTo: ReplyPreview | null;
  reactions: Array<{ userId: string; emoji: string }>;
}

export interface ReactionUpdatedPayload {
  messageId: string;
  conversationId: string;
  reactions: Array<{ userId: string; emoji: string }>;
}

/* ---- WebRTC call signaling (relayed by the server) ---- */

export type CallSignalKind = "description" | "candidate";

export interface CallIncomingPayload {
  callId: string;
  fromUserId: string;
  fromUsername: string;
  video: boolean;
}

export interface CallEndedPayload {
  callId: string;
  fromUserId: string;
  reason?: string;
}

export interface CallSignalPayload {
  callId: string;
  fromUserId: string;
  kind: CallSignalKind;
  data: unknown;
}

export interface ConversationSummary {
  id: string;
  isGroup: boolean;
  name: string | null;
  avatarUrl: string | null;
  updatedAt: string;
  lastReadAt: string | null;
  lastMessage: MessageDTO | null;
  unreadCount: number;
  members: PublicUser[];
  pinnedAt: string | null;
  muted: boolean;
  archivedAt: string | null;
}

export interface ConversationDetail extends ConversationSummary {
  clearedAt: string | null;
  myRole: string;
  ownerId: string | null;
  disappearingSeconds: number | null;
  readStates: Record<string, string>;
  deliveryStates: Record<string, string>;
}

export interface UploadResult {
  url: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
}

/* ---- WebSocket protocol ----
 * Every frame is a JSON envelope: { t: type, p: payload, c?: correlationId }
 * `c` is set by clients on requests that expect an ack; the server echoes it.
 */

export interface Envelope {
  t: string;
  p?: unknown;
  c?: string;
}

export interface MessageAckPayload {
  ok: boolean;
  message?: MessageDTO;
  error?: string;
}

export interface ConversationCreatedPayload {
  conversationId: string;
}

export interface NewMessageRelayPayload {
  conversationId: string;
  message: MessageDTO | null;
}

export interface MessageUpdatedPayload {
  message: MessageDTO;
}

export interface MessageDeletedPayload {
  messageId: string;
  conversationId: string;
}

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface SendMessagePayload {
  conversationId: string;
  type?: MessageType;
  content?: string;
  fileUrl?: string;
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
}

export interface TypingPayload {
  conversationId: string;
  userId: string;
  typing: boolean;
}

export interface ReceiptPayload {
  conversationId: string;
  userId: string;
  lastReadAt: string;
}

export interface PresenceUpdatePayload {
  userId: string;
  online: boolean;
  lastSeenAt?: string | null;
}

export interface DeliveryUpdatePayload {
  conversationId: string;
  userId: string;
  lastDeliveredAt: string;
}
