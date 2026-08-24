"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, CheckCheck, FileText, Loader2, Pencil, Reply, Smile, X } from "lucide-react";
import type { MessageDTO, PublicUser } from "@/lib/types";

const QUICK_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🙏", "🔥", "🎉"];

function formatDay(date: Date): string {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString([], {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: date.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function MessageList({
  messages,
  meId,
  isGroup,
  membersById,
  readStates,
  hasMore,
  loadingOlder,
  onLoadMore,
  onImageClick,
  editingId,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onRequestDelete,
  onReply,
  onToggleReaction,
  deliveryStates,
  focusRequest,
  onLoadAround,
  onFocused,
  typingUsernames,
}: {
  messages: MessageDTO[];
  meId: string;
  isGroup: boolean;
  membersById: Map<string, PublicUser>;
  readStates: Record<string, string>;
  hasMore: boolean;
  loadingOlder: boolean;
  onLoadMore: () => void;
  onImageClick: (url: string) => void;
  editingId: string | null;
  onStartEdit: (messageId: string) => void;
  onCancelEdit: () => void;
  onSaveEdit: (messageId: string, content: string) => void;
  onRequestDelete: (message: MessageDTO) => void;
  onReply: (message: MessageDTO) => void;
  onToggleReaction: (messageId: string, emoji: string) => void;
  deliveryStates: Record<string, string>;
  focusRequest: { id: string; nonce: number } | null;
  onLoadAround: (messageId: string) => Promise<boolean>;
  onFocused: () => void;
  typingUsernames: string[];
}) {
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [pickerForId, setPickerForId] = useState<string | null>(null);

  function jumpTo(messageId: string) {
    const el = document.getElementById(`msg-${messageId}`);
    if (!el) return false;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlightId(messageId);
    setTimeout(() => setHighlightId((cur) => (cur === messageId ? null : cur)), 1600);
    return true;
  }

  // external focus requests (deep links, in-chat search results)
  const attemptedFocusRef = useRef("");
  useEffect(() => {
    if (!focusRequest) return;
    const key = `${focusRequest.nonce}:${focusRequest.id}`;
    let cancelled = false;
    queueMicrotask(async () => {
      if (cancelled) return;
      if (jumpTo(focusRequest.id)) {
        attemptedFocusRef.current = "";
        queueMicrotask(() => onFocused());
        return;
      }
      if (attemptedFocusRef.current === key) return;
      attemptedFocusRef.current = key;
      await onLoadAround(focusRequest.id);
      // after the window loads, the messages-dep rerun will find the element
    });
    return () => {
      cancelled = true;
    };
  }, [focusRequest, messages, onLoadAround, onFocused]);
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const pendingPrependRef = useRef<{ height: number; top: number; prevFirstId: string | null } | null>(
    null
  );
  const lastCountRef = useRef(0);

  // scroll tracking
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);

  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
    setShowJumpToBottom(!nearBottomRef.current);
  }

  // infinite scroll sentinel
  const topSentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = topSentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasMore && !loadingOlder && messages.length > 0) {
          const first = messages[0];
          const c = containerRef.current;
          if (c) {
            pendingPrependRef.current = {
              height: c.scrollHeight,
              top: c.scrollTop,
              prevFirstId: first?.id ?? null,
            };
          }
          onLoadMore();
        }
      },
      { rootMargin: "200px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, loadingOlder, messages, onLoadMore]);

  // scroll management after updates
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const grewAtEnd = messages.length > lastCountRef.current;

    if (lastCountRef.current === 0 && messages.length > 0) {
      el.scrollTop = el.scrollHeight;
    } else if (pendingPrependRef.current) {
      const pending = pendingPrependRef.current;
      pendingPrependRef.current = null;
      const delta = el.scrollHeight - pending.height;
      el.scrollTop = pending.top + delta;
    } else if (grewAtEnd && nearBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }

    lastCountRef.current = messages.length;
  }, [messages]);

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="relative flex-1 overflow-y-auto px-4 py-5"
    >
      <div ref={topSentinelRef} className="h-px" />
      {loadingOlder && (
        <div className="flex justify-center py-2">
          <Loader2 className="size-5 animate-spin text-mist-400" />
        </div>
      )}

      {messages.length === 0 && !hasMore && (
        <div className="flex h-full items-center justify-center">
          <div className="rounded-full bg-accent-500/10 p-6">
            <p className="text-sm text-mist-400">No messages yet, say hi! 👋</p>
          </div>
        </div>
      )}

      <ul className="mx-auto w-full max-w-3xl space-y-1.5">
        {typingUsernames.length > 0 && (
          <li>
            <div className="flex items-end gap-2">
              <div className="flex items-center gap-1 rounded-2xl rounded-bl-md bg-ink-700 px-3.5 py-3">
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="size-1.5 animate-dot-bounce rounded-full bg-mist-400"
                    style={{ animationDelay: `${i * 150}ms` }}
                  />
                ))}
              </div>
            </div>
          </li>
        )}
        {messages.map((message, i) => {
          const prev = messages[i - 1];
          const mine = message.senderId === meId;
          const sender = membersById.get(message.senderId);

          const showDayDivider =
            !prev ||
            new Date(prev.createdAt).toDateString() !==
              new Date(message.createdAt).toDateString();

          const grouped =
            !showDayDivider &&
            prev !== undefined &&
            prev.senderId === message.senderId &&
            new Date(message.createdAt).getTime() -
              new Date(prev.createdAt).getTime() <
              5 * 60 * 1000;

          if (message.type === "SYSTEM") {
            return (
              <li key={message.id}>
                {showDayDivider && (
                  <div className="my-4 flex items-center gap-3" aria-hidden>
                    <div className="h-px flex-1 bg-ink-700" />
                    <span className="rounded-full bg-ink-800 px-3 py-1 text-[11px] font-medium text-mist-400">
                      {formatDay(new Date(message.createdAt))}
                    </span>
                    <div className="h-px flex-1 bg-ink-700" />
                  </div>
                )}
                <p className="py-0.5 text-center text-xs text-mist-400">{message.content}</p>
              </li>
            );
          }

          return (
            <li key={message.id} id={`msg-${message.id}`} className={`group/msg scroll-mt-6 ${highlightId === message.id ? "rounded-xl bg-accent-500/10 ring-1 ring-accent-500/40" : ""}`}>
              {showDayDivider && (
                <div className="my-4 flex items-center gap-3" aria-hidden>
                  <div className="h-px flex-1 bg-ink-700" />
                  <span className="rounded-full bg-ink-800 px-3 py-1 text-[11px] font-medium text-mist-400">
                    {formatDay(new Date(message.createdAt))}
                  </span>
                  <div className="h-px flex-1 bg-ink-700" />
                </div>
              )}

              <div className={`flex gap-2 ${mine ? "flex-row-reverse" : ""}`}>
                  {!mine && (
                    <div className="w-8 shrink-0 self-end">
                      {!grouped && (
                        <AvatarSmall username={sender?.username ?? "?"} avatarUrl={sender?.avatarUrl} />
                      )}
                    </div>
                  )}
                  <div
                    className={`flex min-w-0 max-w-[75%] flex-col ${mine ? "items-end" : "items-start"}`}
                  >
                    {!mine && isGroup && !grouped && !message.deletedAt && (
                      <span className="mb-0.5 px-1 text-xs font-medium text-mist-300">
                        {sender?.username ?? "Unknown"}
                      </span>
                    )}

                    {editingId === message.id ? (
                      <EditBox
                        initial={message.content ?? ""}
                        onCancel={onCancelEdit}
                        onSave={(content) => onSaveEdit(message.id, content)}
                      />
                    ) : (
                      <div className="relative">
                        <div className="absolute -top-4 right-0 z-10 hidden items-center gap-1 rounded-full border border-ink-700 bg-ink-800 px-1 py-0.5 shadow-lg group-hover/msg:flex">
                          <button
                            onClick={() => setPickerForId(pickerForId === message.id ? null : message.id)}
                            aria-label="Add reaction"
                            title="React"
                            className="flex size-6 items-center justify-center rounded-full text-mist-400 transition hover:bg-ink-600 hover:text-mist-200"
                          >
                            <Smile className="size-3.5" />
                          </button>
                          <button
                            onClick={() => onReply(message)}
                            aria-label="Reply to message"
                            title="Reply"
                            className="flex size-6 items-center justify-center rounded-full text-mist-400 transition hover:bg-ink-600 hover:text-mist-200"
                          >
                            <Reply className="size-3.5" />
                          </button>
                          {mine && !message.deletedAt && (
                            <>
                              {message.type === "TEXT" && (
                                <button
                                  onClick={() => onStartEdit(message.id)}
                                  aria-label="Edit message"
                                  title="Edit"
                                  className="flex size-6 items-center justify-center rounded-full text-mist-400 transition hover:bg-ink-600 hover:text-mist-200"
                                >
                                  <Pencil className="size-3.5" />
                                </button>
                              )}
                              <button
                                onClick={() => onRequestDelete(message)}
                                aria-label="Delete message"
                                title="Delete for everyone"
                                className="flex size-6 items-center justify-center rounded-full text-mist-400 transition hover:bg-ink-600 hover:text-red-600"
                              >
                                <X className="size-3.5" />
                              </button>
                            </>
                          )}
                        </div>
                        {pickerForId === message.id && (
                          <>
                            <div className="fixed inset-0 z-20" onClick={() => setPickerForId(null)} />
                            <div className="absolute -top-12 right-0 z-30 flex animate-pop-in gap-0.5 rounded-full border border-ink-700 bg-ink-800 px-1.5 py-1 shadow-xl">
                              {QUICK_EMOJIS.map((emoji) => (
                                <button
                                  key={emoji}
                                  onClick={() => {
                                    setPickerForId(null);
                                    onToggleReaction(message.id, emoji);
                                  }}
                                  className="flex size-7 items-center justify-center rounded-full text-base transition hover:scale-125 hover:bg-ink-600"
                                >
                                  {emoji}
                                </button>
                              ))}
                            </div>
                          </>
                        )}
                        <Bubble
                          message={message}
                          mine={mine}
                          onImageClick={onImageClick}
                          deliveryState={mine ? tickStateFor(message, meId, membersById, readStates, deliveryStates) : "none"}
                          onJumpTo={(id) => jumpTo(id)}
                        />
                        {!message.deletedAt && message.reactions.length > 0 && (
                          <div className="z-10 -mt-1.5 flex flex-wrap gap-1 px-1">
                            {Object.entries(
                              message.reactions.reduce<Record<string, string[]>>((acc, r) => {
                                (acc[r.emoji] ??= []).push(r.userId);
                                return acc;
                              }, {})
                            ).map(([emoji, userIds]) => {
                              const mineReaction = userIds.includes(meId);
                              return (
                                <button
                                  key={emoji}
                                  onClick={() => onToggleReaction(message.id, emoji)}
                                  className={`flex items-center gap-1 rounded-full border border-line-strong px-2 py-0.5 text-xs transition ${
                                    mineReaction
                                      ? "border-accent-500/60 bg-surface/95 text-accent-300"
                                      : "border-line-strong bg-surface/95 text-mist-200 hover:bg-hover"
                                  }`}
                                >
                                  <span>{emoji}</span>
                                  <span className="font-medium">{userIds.length}</span>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
            </li>
          );
        })}
      </ul>

      {showJumpToBottom && (
        <button
          onClick={() => {
            nearBottomRef.current = true;
            bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
          }}
          aria-label="Jump to latest messages"
          className="icon-btn absolute bottom-5 right-6 z-20 size-11 border border-ink-600 bg-ink-800 text-mist-300 hover:text-mist-200"
        >
          ↓
        </button>
      )}
      <div ref={bottomRef} />
    </div>
  );
}

type TickState = "sent" | "delivered" | "read" | "none";

function tickStateFor(
  message: MessageDTO,
  meId: string,
  membersById: Map<string, PublicUser>,
  readStates: Record<string, string>,
  deliveryStates: Record<string, string>
): TickState {
  const sentAt = new Date(message.createdAt).getTime();
  let read = false;
  let delivered = false;
  for (const userId of membersById.keys()) {
    if (userId === meId) continue;
    const readAt = readStates[userId];
    if (readAt && new Date(readAt).getTime() >= sentAt) read = true;
    const deliveredAt = deliveryStates[userId];
    if (deliveredAt && new Date(deliveredAt).getTime() >= sentAt) delivered = true;
  }
  if (read) return "read";
  if (delivered) return "delivered";
  return "sent";
}

function AvatarSmall({
  username,
  avatarUrl,
}: {
  username: string;
  avatarUrl?: string | null;
}) {
  if (avatarUrl) {
    return (
      <img src={avatarUrl} alt={username} className="size-8 rounded-full object-cover" />
    );
  }
  return (
    <div className="flex size-8 items-center justify-center rounded-full bg-ink-600 text-[10px] font-semibold text-mist-200">
      {username.slice(0, 2).toUpperCase()}
    </div>
  );
}

function Bubble({
  message,
  mine,
  onImageClick,
  deliveryState,
  onJumpTo,
}: {
  message: MessageDTO;
  mine: boolean;
  onImageClick: (url: string) => void;
  deliveryState: TickState;
  onJumpTo: (messageId: string) => void;
}) {
  const base = "rounded-2xl px-3.5 py-2 text-sm shadow-sm";
  const tone = mine
    ? "bg-accent-500 text-white rounded-br-md"
    : "bg-surface border border-line text-mist-200 rounded-bl-md";

  if (message.deletedAt) {
    return (
      <div className="rounded-2xl rounded-br-md border border-dashed border-ink-500/70 bg-ink-800/50 px-3.5 py-2 text-sm italic text-mist-400">
        This message was deleted
      </div>
    );
  }

  const quoted = message.replyTo ? (
    <button
      onClick={() => onJumpTo(message.replyTo!.id)}
      className={`mb-1.5 block w-full rounded-xl border-l-[3px] py-1 pl-2.5 pr-2 text-left transition ${
        mine
          ? "border-white/70 bg-black/15 hover:bg-black/25"
          : "border-accent-400 bg-black/[0.06] hover:bg-black/[0.12]"
      }`}
    >
      <span className={`block text-[11px] font-semibold ${mine ? "text-white/90" : "text-accent-300"}`}>
        {message.replyTo.senderUsername}
      </span>
      <span className={`block truncate text-xs ${mine ? "text-white/75" : "text-mist-300"}`}>
        {message.replyTo.content ??
          (message.replyTo.type === "TEXT" ? "" : "Media")}
      </span>
    </button>
  ) : null;

  let body: React.ReactNode;
  const isVoice =
    message.type !== "TEXT" &&
    !!message.fileUrl &&
    (message.mimeType ?? "").startsWith("audio/");

  if (isVoice) {
    body = (
      <div className="flex items-center gap-2 py-1 pr-1">
        <span
          className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${
            mine ? "bg-black/15" : "bg-ink-800"
          }`}
        >
          🎤
        </span>
        <audio controls preload="metadata" src={message.fileUrl!} className="h-9 w-44" />
        {typeof message.duration === "number" && (
          <span className={`shrink-0 text-xs ${mine ? "text-white/80" : "text-mist-400"}`}>
            {Math.floor(message.duration / 60)}:{String(message.duration % 60).padStart(2, "0")}
          </span>
        )}
      </div>
    );
  } else if (message.type === "IMAGE" && message.fileUrl) {
    body = (
      <button onClick={() => onImageClick(message.fileUrl!)} className="block overflow-hidden rounded-xl">
        <img
          src={message.fileUrl}
          alt={message.fileName ?? "Shared image"}
          className="max-h-72 max-w-[260px] object-cover transition hover:brightness-110"
          loading="lazy"
        />
      </button>
    );
  } else if (message.type === "FILE" && message.fileUrl) {
    body = (
      <a
        href={message.fileUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={`flex items-center gap-2.5 py-1 pr-1 underline-offset-2 ${tone}`}
      >
        <span
          className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${
            mine ? "bg-black/15" : "bg-ink-800"
          }`}
        >
          <FileText className="size-4.5" />
        </span>
        <span className="min-w-0">
          <span className="block max-w-48 truncate font-medium underline decoration-white/30 hover:decoration-white">
            {message.fileName ?? "File"}
          </span>
          <span className={`block text-xs ${mine ? "text-white/70" : "text-mist-400"}`}>
            {typeof message.fileSize === "number" ? formatFileSize(message.fileSize) : "Download"}
          </span>
        </span>
      </a>
    );
  } else {
    body = <p className="whitespace-pre-wrap break-words">{message.content}</p>;
  }

  return (
    <div className={`${base} ${tone} ${message.type !== "TEXT" ? "p-1.5!" : ""}`}>
      {quoted}
      {body}
      <div
        className={`mt-0.5 flex items-center justify-end gap-1 text-[10px] tabular-nums ${
          mine ? "text-white/60" : "text-mist-400"
        } ${message.type !== "TEXT" ? "pr-2 pb-0.5" : ""}`}
      >
        {formatTime(message.createdAt)}
        {message.editedAt && <span>(edited)</span>}
        {message.expiresAt && (
          <span title={`Disappears at ${new Date(message.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}>
            ⏳
          </span>
        )}
        {deliveryState !== "none" &&
          (deliveryState === "read" ? (
            <CheckCheck className="size-3.5 shrink-0 text-white" aria-label="Read" />
          ) : deliveryState === "delivered" ? (
            <CheckCheck className="size-3.5 shrink-0 opacity-80" aria-label="Delivered" />
          ) : (
            <Check className="size-3.5 shrink-0 opacity-80" aria-label="Sent" />
          ))}
      </div>
    </div>
  );
}

function EditBox({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (content: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, []);

  function save() {
    const content = value.trim();
    if (!content || content === initial) {
      onCancel();
      return;
    }
    onSave(content);
  }

  return (
    <div className="w-72 rounded-2xl border border-accent-500/60 bg-ink-800 p-2">
      <textarea
        ref={ref}
        rows={2}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            save();
          }
          if (e.key === "Escape") onCancel();
        }}
        className="max-h-32 w-full resize-none bg-transparent px-1 text-sm text-mist-200 outline-none"
      />
      <div className="mt-1 flex items-center justify-end gap-2">
        <button
          onClick={onCancel}
          aria-label="Cancel edit"
          className="flex size-7 items-center justify-center rounded-full text-mist-400 transition hover:bg-ink-700 hover:text-mist-200"
        >
          <X className="size-4" />
        </button>
        <button
          onClick={save}
          aria-label="Save edit"
          title="Save (Enter)"
          className="flex size-7 items-center justify-center rounded-full bg-accent-500 text-white transition hover:bg-accent-400"
        >
          <Check className="size-4" />
        </button>
      </div>
    </div>
  );
}
