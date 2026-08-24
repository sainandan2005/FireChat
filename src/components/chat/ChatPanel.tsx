"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import useSWR from "swr";
import { ArrowLeft, Info, Phone, Search as SearchIcon, Video, X } from "lucide-react";
import Avatar from "./Avatar";
import Composer from "./Composer";
import ConfirmDialog from "./ConfirmDialog";
import ConversationInfoDialog from "./ConversationInfoDialog";
import MessageList from "./MessageList";
import Lightbox from "./Lightbox";
import { useChat } from "./providers";
import { getWs } from "@/lib/ws-client";
import type {
  ConversationDetail,
  MessageDTO,
  MessageDeletedPayload,
  MessageUpdatedPayload,
  PublicUser,
  ReactionUpdatedPayload,
  ReceiptPayload,
  TypingPayload,
} from "@/lib/types";

const fetcher = (url: string) => fetch(url).then((res) => res.json());
const PAGE_SIZE = 30;

interface TypingEntry {
  timeoutId: ReturnType<typeof setTimeout>;
}

export default function ChatPanel({ conversationId }: { conversationId: string }) {
  const { onlineIds, me, callEngine } = useChat();
  const { data: detailData, mutate: mutateDetail } = useSWR<{ conversation: ConversationDetail }>(
    `/api/conversations/${conversationId}`,
    fetcher
  );
  const detail = detailData?.conversation ?? null;

  const [messages, setMessages] = useState<MessageDTO[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [receiptOverrides, setReceiptOverrides] = useState<Record<string, string>>({});
  const [typingIds, setTypingIds] = useState<Map<string, TypingEntry>>(new Map());
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MessageDTO | null>(null);
  const [replyTarget, setReplyTarget] = useState<MessageDTO | null>(null);
  const [deliveryOverrides, setDeliveryOverrides] = useState<Record<string, string>>({});
  const [lastSeenOverrides, setLastSeenOverrides] = useState<Record<string, string>>({});
  const [infoOpen, setInfoOpen] = useState(false);
  const [chatSearchOpen, setChatSearchOpen] = useState(false);
  const [chatSearchQuery, setChatSearchQuery] = useState("");
  const [chatSearchResults, setChatSearchResults] = useState<MessageDTO[]>([]);
  const [focusRequest, setFocusRequest] = useState<{ id: string; nonce: number } | null>(null);

  const router = useRouter();
  const searchParams = useSearchParams();
  const deepLinkMsgId = searchParams.get("msg");

  const requestFocus = useCallback((messageId: string) => {
    setFocusRequest({ id: messageId, nonce: Date.now() });
  }, []);

  // load a message window around an id we don't currently have rendered
  const loadAround = useCallback(
    async (messageId: string): Promise<boolean> => {
      try {
        const res = await fetch(
          `/api/conversations/${conversationId}/messages?aroundId=${encodeURIComponent(messageId)}`
        );
        if (!res.ok) return false;
        const data = (await res.json()) as { messages: MessageDTO[]; hasMore: boolean; nextCursor: string | null };
        setMessages((prev) => {
          const merged = [
            ...prev.filter((m) => !data.messages.some((n) => n.id === m.id)),
            ...data.messages,
          ];
          return merged.sort((a, b) =>
            a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt)
          );
        });
        setHasMore((prevHasMore) => data.hasMore || prevHasMore);
        setCursor((prevCursor) => data.nextCursor ?? prevCursor);
        return true;
      } catch {
        return false;
      }
    },
    [conversationId]
  );

  const messagesRef = useRef<MessageDTO[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // deep link: /c/[id]?msg=<messageId>
  const lastDeepLinkRef = useRef<string | null>(null);
  useEffect(() => {
    if (deepLinkMsgId && lastDeepLinkRef.current !== deepLinkMsgId) {
      lastDeepLinkRef.current = deepLinkMsgId;
      queueMicrotask(() => requestFocus(deepLinkMsgId));
    }
  }, [deepLinkMsgId, requestFocus]);

  // in-chat search
  useEffect(() => {
    const t = setTimeout(async () => {
      const q = chatSearchQuery.trim();
      if (!chatSearchOpen || q.length < 2) {
        setChatSearchResults([]);
        return;
      }
      try {
        const res = await fetch(
          `/api/search?q=${encodeURIComponent(q)}&conversationId=${encodeURIComponent(conversationId)}`
        );
        const data = (await res.json()) as { results: Array<{ message: MessageDTO }> };
        setChatSearchResults((data.results ?? []).map((r) => r.message));
      } catch {
        setChatSearchResults([]);
      }
    }, chatSearchOpen && chatSearchQuery.trim().length >= 2 ? 250 : 0);
    return () => clearTimeout(t);
  }, [chatSearchQuery, chatSearchOpen, conversationId]);

  function handleFocused() {
    if (deepLinkMsgId) {
      window.history.replaceState(null, "", `/c/${conversationId}`);
      router.replace(`/c/${conversationId}`, { scroll: false });
    }
    setFocusRequest(null);
  }

  // fetch anything that arrived while the socket was down
  const backfill = useCallback(async () => {
    const list = messagesRef.current;
    const newest = list[list.length - 1];
    const q = newest ? `&afterId=${encodeURIComponent(newest.id)}` : "";
    try {
      const res = await fetch(`/api/conversations/${conversationId}/messages?limit=50${q}`);
      if (!res.ok) return;
      const data = (await res.json()) as { messages: MessageDTO[] };
      if (!data.messages?.length) return;
      setMessages((prev) => {
        const known = new Set(prev.map((m) => m.id));
        const fresh = data.messages.filter((m) => !known.has(m.id));
        return fresh.length > 0 ? [...prev, ...fresh] : prev;
      });
    } catch {
      /* transient */
    }
  }, [conversationId]);

  // initial load (component is keyed by conversationId, so this runs once per conversation)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/conversations/${conversationId}/messages?limit=${PAGE_SIZE}`);
        if (!res.ok) return;
        const data = (await res.json()) as {
          messages: MessageDTO[];
          hasMore: boolean;
          nextCursor: string | null;
        };
        if (cancelled) return;
        setMessages(data.messages);
        setHasMore(data.hasMore);
        setCursor(data.nextCursor);
        getWs().send("receipt.markDelivered", { conversationId });
      } catch {
        /* network error; leave empty */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  const readStates = useMemo<Record<string, string>>(
    () => ({ ...(detail?.readStates ?? {}), ...receiptOverrides }),
    [detail, receiptOverrides]
  );

  const deliveryStates = useMemo<Record<string, string>>(
    () => ({ ...(detail?.deliveryStates ?? {}), ...deliveryOverrides }),
    [detail, deliveryOverrides]
  );

  const markRead = useCallback(() => {
    if (document.visibilityState !== "visible" || !document.hasFocus()) return;
    // badge clearing is handled by the receipt:update socket echo in the sidebar
    void fetch(`/api/conversations/${conversationId}/read`, { method: "POST" }).catch(() => {});
  }, [conversationId]);

  useEffect(() => {
    markRead();
    const onFocus = () => markRead();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);

    function onVisibility() {
      if (document.visibilityState === "visible") markRead();
    }
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [markRead, messages.length]);

  const clearTypingFor = useCallback((userId: string) => {
    setTypingIds((prev) => {
      if (!prev.has(userId)) return prev;
      const next = new Map(prev);
      clearTimeout(next.get(userId)?.timeoutId);
      next.delete(userId);
      return next;
    });
  }, []);

  // websocket wiring
  useEffect(() => {
    if (!me) return;
    const client = getWs();

    client.join(conversationId);

    const onMessageNew = (raw: unknown) => {
      const message = raw as MessageDTO;
      if (message.conversationId !== conversationId) return;
      clearTypingFor(message.senderId);
      setMessages((prev) =>
        prev.some((m) => m.id === message.id) ? prev : [...prev, message]
      );
    };

    const onDeliveryUpdate = (raw: unknown) => {
      const entries = raw as Array<{
        conversationId: string;
        userId: string;
        lastDeliveredAt: string;
      }>;
      if (!Array.isArray(entries)) return;
      setDeliveryOverrides((prev) => {
        const next = { ...prev };
        for (const entry of entries) {
          if (entry.conversationId !== conversationId) continue;
          next[entry.userId] = entry.lastDeliveredAt;
        }
        return next;
      });
    };

    const onPresenceUpdate = (raw: unknown) => {
      const payload = raw as { userId: string; online: boolean; lastSeenAt?: string | null };
      if (!payload.online && payload.lastSeenAt) {
        setLastSeenOverrides((prev) => ({ ...prev, [payload.userId]: payload.lastSeenAt as string }));
      }
    };

    const onTyping = (raw: unknown) => {
      const payload = raw as TypingPayload;
      if (payload.conversationId !== conversationId || payload.userId === me.id) return;
      if (payload.typing) {
        setTypingIds((prev) => {
          const next = new Map(prev);
          clearTimeout(next.get(payload.userId)?.timeoutId);
          next.set(payload.userId, {
            timeoutId: setTimeout(() => {
              setTypingIds((cur) => {
                const n = new Map(cur);
                n.delete(payload.userId);
                return n;
              });
            }, 6000),
          });
          return next;
        });
      } else {
        clearTypingFor(payload.userId);
      }
    };

    const onReceipt = (raw: unknown) => {
      const payload = raw as ReceiptPayload;
      if (payload.conversationId !== conversationId) return;
      setReceiptOverrides((prev) => ({ ...prev, [payload.userId]: payload.lastReadAt }));
    };

    const onMessageUpdated = (raw: unknown) => {
      const payload = raw as MessageUpdatedPayload;
      const message = payload.message;
      if (message.conversationId !== conversationId) return;
      setMessages((prev) => prev.map((m) => (m.id === message.id ? message : m)));
    };

    const onMessageDeleted = (raw: unknown) => {
      const payload = raw as MessageDeletedPayload;
      if (payload.conversationId !== conversationId) return;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === payload.messageId
            ? { ...m, deletedAt: new Date().toISOString(), content: null, fileUrl: null, fileName: null }
            : m
        )
      );
    };

    const onReactionUpdated = (raw: unknown) => {
      const payload = raw as ReactionUpdatedPayload;
      if (payload.conversationId !== conversationId) return;
      setMessages((prev) =>
        prev.map((m) => (m.id === payload.messageId ? { ...m, reactions: payload.reactions } : m))
      );
    };

    const offs = [
      client.on("message.new", onMessageNew),
      client.on("typing.update", onTyping),
      client.on("receipt.update", onReceipt),
      client.on("message.updated", onMessageUpdated),
      client.on("message.deleted", onMessageDeleted),
      client.on("reaction.updated", onReactionUpdated),
      client.on("delivery.update", onDeliveryUpdate),
      client.on("presence.update", onPresenceUpdate),
      client.onOpen(() => {
        void backfill();
        client.send("receipt.markDelivered", { conversationId });
      }),
    ];

    return () => {
      for (const off of offs) off();
      client.leave(conversationId);
    };
  }, [me, conversationId, clearTypingFor, backfill]);

  async function loadOlder(): Promise<void> {
    if (!hasMore || loadingOlder || !cursor) return;
    setLoadingOlder(true);
    try {
      const res = await fetch(
        `/api/conversations/${conversationId}/messages?limit=${PAGE_SIZE}&cursor=${encodeURIComponent(cursor)}`
      );
      if (!res.ok) return;
      const data = (await res.json()) as {
        messages: MessageDTO[];
        hasMore: boolean;
        nextCursor: string | null;
      };
      setMessages((prev) => [...data.messages, ...prev]);
      setHasMore(data.hasMore);
      setCursor(data.nextCursor);
    } finally {
      setLoadingOlder(false);
    }
  }

  function handleSendText(content: string): void {
    void getWs()
      .sendWithAck("message.send", {
        conversationId,
        type: "TEXT",
        content,
        ...(replyTarget ? { replyToId: replyTarget.id } : {}),
      })
      .then((response) => {
        if (!response.ok) showSendError(response.error ?? "Failed to send");
      });
    setReplyTarget(null);
  }

  function handleSendFile(
    result: {
      url: string;
      fileName: string;
      fileSize: number;
      mimeType: string;
    },
    durationSeconds?: number
  ): void {
    const isImage = result.mimeType.startsWith("image/");
    void getWs()
      .sendWithAck("message.send", {
        conversationId,
        type: isImage ? "IMAGE" : "FILE",
        fileUrl: result.url,
        fileName: result.fileName,
        fileSize: result.fileSize,
        mimeType: result.mimeType,
        ...(typeof durationSeconds === "number" ? { duration: durationSeconds } : {}),
        ...(replyTarget ? { replyToId: replyTarget.id } : {}),
      })
      .then((response) => {
        if (!response.ok) showSendError(response.error ?? "Failed to send");
      });
    setReplyTarget(null);
  }

  const sendErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function showSendError(message: string) {
    setSendError(message);
    if (sendErrorTimer.current) clearTimeout(sendErrorTimer.current);
    sendErrorTimer.current = setTimeout(() => setSendError(null), 4000);
  }

  function handleTypingChange(typing: boolean): void {
    getWs().send(typing ? "typing.start" : "typing.stop", { conversationId });
  }

  const membersById = useMemo(() => {
    const map = new Map<string, PublicUser>();
    for (const m of detail?.members ?? []) map.set(m.id, m);
    return map;
  }, [detail]);

  const otherMember = useMemo(
    () => detail && !detail.isGroup ? detail.members.find((m) => m.id !== me?.id) : undefined,
    [detail, me]
  );

  const typingNames = useMemo(
    () =>
      Array.from(typingIds.keys())
        .map((id) => membersById.get(id)?.username ?? "Someone")
        .filter(Boolean),
    [typingIds, membersById]
  );

  const lastSeenLabel = useMemo(() => {
    if (!otherMember) return null;
    const iso = lastSeenOverrides[otherMember.id] ?? otherMember.lastSeenAt;
    if (!iso) return null;
    const date = new Date(iso);
    const now = new Date();
    if (date.toDateString() === now.toDateString()) {
      return `last seen today at ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    }
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) {
      return `last seen yesterday at ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    }
    return `last seen ${date.toLocaleDateString([], { month: "short", day: "numeric" })}`;
  }, [otherMember, lastSeenOverrides]);

  if (!detail) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="size-8 animate-spin rounded-full border-2 border-ink-600 border-t-accent-500" />
      </div>
    );
  }

  const title = detail.isGroup ? (detail.name ?? "Group") : (otherMember?.username ?? "Unknown");
  const typingLabel =
    typingNames.length === 0
      ? null
      : typingNames.length === 1
        ? `${typingNames[0]} is typing…`
        : `${typingNames.slice(0, 2).join(" & ")}${typingNames.length > 2 ? " +" : ""} are typing…`;

  const subtitle = detail.isGroup
    ? `${detail.members.length} members`
    : onlineIds.has(otherMember?.id ?? "")
      ? "Online"
      : (lastSeenLabel ?? "Offline");

  return (
    <div className="flex h-full min-w-0 flex-col bg-canvas">
      <header className="flex h-[68px] items-center gap-2 border-b border-line bg-ink-900 px-4 ">
        <Link
          href="/"
          className="-ml-1 flex size-9 items-center justify-center rounded-full text-mist-300 transition hover:bg-ink-700 md:hidden"
          aria-label="Back to conversations"
        >
          <ArrowLeft className="size-5" />
        </Link>
        {detail.isGroup ? (
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-accent-500 to-accent-600 text-sm font-bold text-white">
            {(detail.name ?? "G").slice(0, 1).toUpperCase()}
          </div>
        ) : (
          <Avatar
            username={otherMember?.username ?? "?"}
            avatarUrl={otherMember?.avatarUrl}
            online={otherMember ? onlineIds.has(otherMember.id) : undefined}
          />
        )}
        <button
          onClick={() => setInfoOpen(true)}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-1 py-1 text-left transition hover:bg-ink-800/60"
          title="Conversation info"
        >
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-display font-semibold text-mist-200">{title}</h2>
            <p className={`truncate text-xs ${typingLabel ? "text-accent-400" : "text-mist-400"}`}>
              {typingLabel ?? subtitle}
            </p>
          </div>
          <Info className="size-4 shrink-0 text-mist-400" />
        </button>
        {!detail.isGroup && otherMember && (
          <>
            <button
              onClick={() => void callEngine?.start(otherMember.id, otherMember.username, false)}
              aria-label={`Voice call ${otherMember.username}`}
              title="Voice call"
              className="flex size-9 shrink-0 items-center justify-center rounded-full text-mist-400 transition hover:bg-ink-700 hover:text-online"
            >
              <Phone className="size-4.5" />
            </button>
            <button
              onClick={() => void callEngine?.start(otherMember.id, otherMember.username, true)}
              aria-label={`Video call ${otherMember.username}`}
              title="Video call"
              className="flex size-9 shrink-0 items-center justify-center rounded-full text-mist-400 transition hover:bg-ink-700 hover:text-accent-300"
            >
              <Video className="size-4.5" />
            </button>
          </>
        )}
        <button
          onClick={() => {
            setChatSearchOpen((v) => !v);
            setChatSearchQuery("");
            setChatSearchResults([]);
          }}
          aria-label={chatSearchOpen ? "Close search" : "Search in conversation"}
          title="Search in conversation"
          className={`flex size-9 shrink-0 items-center justify-center rounded-full transition ${
            chatSearchOpen
              ? "bg-ink-700 text-accent-300"
              : "text-mist-400 hover:bg-ink-700 hover:text-mist-200"
          }`}
        >
          {chatSearchOpen ? <X className="size-4.5" /> : <SearchIcon className="size-4.5" />}
        </button>
      </header>

      {chatSearchOpen && (
        <div className="relative border-b border-ink-800 bg-ink-900 px-3 py-2">
          <input
            autoFocus
            value={chatSearchQuery}
            onChange={(e) => setChatSearchQuery(e.target.value)}
            placeholder="Search this conversation…"
            className="w-full rounded-lg border border-ink-600 bg-ink-800 px-3 py-2 text-sm text-mist-200 placeholder-mist-400/60 outline-none focus:border-accent-500/70"
          />
          {chatSearchQuery.trim().length >= 2 && (
            <div className="absolute inset-x-3 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded-xl border border-ink-700 bg-ink-900 py-1 shadow-2xl">
              {chatSearchResults.length === 0 && (
                <p className="px-3 py-3 text-center text-xs text-mist-400">No matches</p>
              )}
              <ul>
                {chatSearchResults.map((m) => (
                  <li key={m.id}>
                    <button
                      onClick={() => requestFocus(m.id)}
                      className="block w-full px-3 py-2 text-left transition hover:bg-ink-800"
                    >
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="text-xs font-semibold text-accent-300">
                          {membersById.get(m.senderId)?.username ?? "Unknown"}
                        </span>
                        <span className="shrink-0 text-[10px] text-mist-400">
                          {new Date(m.createdAt).toLocaleString([], {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-mist-300">{m.content}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <MessageList
        messages={messages}
        meId={me?.id ?? ""}
        isGroup={detail.isGroup}
        membersById={membersById}
        readStates={readStates}
        hasMore={hasMore}
        loadingOlder={loadingOlder}
        onLoadMore={() => void loadOlder()}
        onImageClick={setLightboxUrl}
        typingUsernames={typingNames}
        editingId={editingId}
        onStartEdit={(id) => setEditingId(id)}
        onCancelEdit={() => setEditingId(null)}
        onSaveEdit={(messageId, content) => {
          setEditingId(null);
          void getWs()
            .sendWithAck("message.edit", { messageId, content })
            .then((res) => {
              if (!res.ok) showSendError(res.error ?? "Failed to edit");
            });
        }}
        onRequestDelete={(message) => setDeleteTarget(message)}
        onReply={(message) => setReplyTarget(message)}
        onToggleReaction={(messageId, emoji) => {
          void getWs().sendWithAck("reaction.toggle", { messageId, emoji });
        }}
        deliveryStates={deliveryStates}
        focusRequest={focusRequest}
        onLoadAround={loadAround}
        onFocused={handleFocused}
      />

      <div className="px-4 pb-1">
        {sendError && <p className="text-xs text-red-600">{sendError}</p>}
      </div>

      <Composer
        onSendText={handleSendText}
        onSendFile={handleSendFile}
        onTypingChange={handleTypingChange}
        replyTarget={replyTarget}
        membersById={membersById}
        onCancelReply={() => setReplyTarget(null)}
      />

      {lightboxUrl && <Lightbox url={lightboxUrl} onClose={() => setLightboxUrl(null)} />}

      {infoOpen && detail && (
        <ConversationInfoDialog
          conversation={detail}
          meId={me?.id ?? ""}
          onlineIds={onlineIds}
          onClose={() => setInfoOpen(false)}
          onChanged={() => void mutateDetail()}
        />
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete message?"
        body="This removes the message for everyone in this conversation."
        confirmLabel="Delete"
        onConfirm={() => {
          const target = deleteTarget;
          setDeleteTarget(null);
          if (!target) return;
          void getWs()
            .sendWithAck("message.delete", { messageId: target.id })
            .then((res) => {
              if (!res.ok) showSendError(res.error ?? "Failed to delete");
            });
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
