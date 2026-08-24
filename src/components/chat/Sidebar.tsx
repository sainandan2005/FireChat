"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import useSWR from "swr";
import {
  Archive,
  Bell,
  BellOff,
  Flame,
  LogOut,
  MoreVertical,
  Pin,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import Avatar from "./Avatar";
import ConfirmDialog from "./ConfirmDialog";
import NewChatDialog from "./NewChatDialog";
import ProfileDialog from "./ProfileDialog";
import ThemeToggle from "./ThemeToggle";
import { useChat } from "./providers";
import { getWs } from "@/lib/ws-client";
import {
  disablePush,
  enablePush,
  getPushState,
  type PushState,
} from "@/lib/push-client";
import type {
  ConversationSummary,
  MessageDTO,
  ReceiptPayload,
} from "@/lib/types";

const fetcher = (url: string) => fetch(url).then((res) => res.json());

function formatTime(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  if (now.getTime() - date.getTime() < 7 * 86400000) {
    return date.toLocaleDateString([], { weekday: "short" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function previewText(message: MessageDTO | null): string {
  if (!message) return "No messages yet";
  const prefix = message.replyTo ? "↩ " : "";
  switch (message.type) {
    case "IMAGE":
      return `${prefix}📷 Photo`;
    case "FILE":
      return `${prefix}📎 ${message.fileName ?? "File"}`;
    default:
      return `${prefix}${message.content ?? ""}`;
  }
}

export default function Sidebar({
  me,
}: {
  me: { id: string; username: string; avatarUrl: string | null };
}) {
  const router = useRouter();
  const pathname = usePathname();
  const activeId = pathname.startsWith("/c/") ? pathname.slice(3) : null;

  const { onlineIds } = useChat();
  const { data, mutate } = useSWR<{ conversations: ConversationSummary[] }>(
    "/api/conversations",
    fetcher
  );
  const [filter, setFilter] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [menuForId, setMenuForId] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<ConversationSummary | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [pushState, setPushState] = useState<PushState>("unsubscribed");
  const [profileOpen, setProfileOpen] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);

  useEffect(() => {
    void getPushState().then(setPushState);
  }, []);

  async function togglePush() {
    if (pushBusy) return;
    setPushBusy(true);
    try {
      if (pushState === "subscribed") {
        await disablePush();
        setPushState("unsubscribed");
      } else {
        const res = await enablePush();
        if (res.ok) setPushState("subscribed");
        else {
          setPushState(await getPushState());
          if (res.error) console.warn("Push enable failed:", res.error);
        }
      }
    } finally {
      setPushBusy(false);
    }
  }

  // guard: never mutate the cache while the initial fetch is still in flight,
  // a mutate bumps the SWR generation, which would discard that response
  const dataRef = useRef<ConversationSummary[] | undefined>(undefined);
  useEffect(() => {
    dataRef.current = data?.conversations;
  }, [data]);

  const applyNewMessage = useCallback(
    (conversationId: string, message: MessageDTO, incrementUnread: boolean) => {
      if (!dataRef.current) return; // initial fetch will include this message
      mutate(
        (current) =>
          current && {
            conversations: current.conversations
              .map((c) =>
                c.id === conversationId
                  ? {
                      ...c,
                      lastMessage: message,
                      unreadCount:
                        incrementUnread && message.senderId !== me.id
                          ? c.unreadCount + 1
                          : c.unreadCount,
                    }
                  : c
              )
              .sort((a, b) => (a.lastMessage && b.lastMessage)
                ? b.lastMessage.createdAt.localeCompare(a.lastMessage.createdAt)
                : b.updatedAt.localeCompare(a.updatedAt)),
          },
        { revalidate: false }
      );
    },
    [me.id, mutate]
  );

  useEffect(() => {
    const client = getWs();

    const onMessageNew = (payload: unknown) => {
      const message = payload as MessageDTO;
      applyNewMessage(message.conversationId, message, false);
    };
    const onConversationNewMessage = (raw: unknown) => {
      const payload = raw as { conversationId: string; message: MessageDTO };
      applyNewMessage(
        payload.conversationId,
        payload.message,
        payload.conversationId !== activeId || document.visibilityState !== "visible"
      );
      if (payload.message.senderId !== me.id && payload.conversationId !== activeId) {
        client.send("receipt.markDelivered", { conversationId: payload.conversationId });
      }
    };
    const onConversationCreated = () => {
      void mutate();
    };
    const onReceipt = (raw: unknown) => {
      const payload = raw as ReceiptPayload;
      if (!dataRef.current) return;
      if (payload.userId !== me.id) return;
      mutate(
        (current) =>
          current && {
            conversations: current.conversations.map((c) =>
              c.id === payload.conversationId ? { ...c, unreadCount: 0 } : c
            ),
          },
        { revalidate: false }
      );
    };

    const offs = [
      client.on("message.new", onMessageNew),
      client.on("conversation.new-message", onConversationNewMessage),
      client.on("conversation.created", onConversationCreated),
      client.on("receipt.update", onReceipt),
      client.onOpen(() => void mutate()),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [me.id, activeId, applyNewMessage, mutate]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  async function handleConfirmDeleteOrExit() {
    if (!confirmTarget) return;
    const conv = confirmTarget;
    setConfirmTarget(null);
    const res = await fetch(`/api/conversations/${conv.id}`, { method: "DELETE" }).catch(
      () => null
    );
    if (res?.ok) {
      if (activeId === conv.id) router.push("/");
      void mutate();
    }
  }

  async function updateFlags(conv: ConversationSummary, flags: Record<string, boolean>) {
    const res = await fetch(`/api/conversations/${conv.id}/flags`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(flags),
    }).catch(() => null);
    if (res?.ok) {
      if (flags.archived === true && activeId === conv.id) router.push("/");
      void mutate();
    }
  }

  const sortConversations = useCallback(
    (list: ConversationSummary[]) =>
      [...list].sort((a, b) => {
        if (a.pinnedAt !== b.pinnedAt) {
          if (a.pinnedAt && !b.pinnedAt) return -1;
          if (!a.pinnedAt && b.pinnedAt) return 1;
          return (b.pinnedAt ?? "").localeCompare(a.pinnedAt ?? "");
        }
        return (a.lastMessage && b.lastMessage)
          ? b.lastMessage.createdAt.localeCompare(a.lastMessage.createdAt)
          : b.updatedAt.localeCompare(a.updatedAt);
      }),
    []
  );

  const { activeConversations, archivedList, archivedCount } = useMemo(() => {
    const all = data?.conversations ?? [];
    const q = filter.trim().toLowerCase();
    const matches = q
      ? all.filter((c) => {
          const title = c.isGroup
            ? (c.name ?? "")
            : (c.members.find((m) => m.id !== me.id)?.username ?? "");
          return title.toLowerCase().includes(q);
        })
      : all;
    const active = sortConversations(matches.filter((c) => !c.archivedAt));
    return {
      activeConversations: active,
      archivedCount: matches.filter((c) => c.archivedAt).length,
      archivedList: sortConversations(matches.filter((c) => c.archivedAt)),
    };
  }, [data, filter, me.id, sortConversations]);

  // global message search
  const [msgResults, setMsgResults] = useState<
    Array<{ conversationId: string; message: MessageDTO }>
  >([]);
  useEffect(() => {
    const t = setTimeout(async () => {
      const q = filter.trim();
      if (q.length < 2) {
        setMsgResults([]);
        return;
      }
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        const data = (await res.json()) as {
          results: Array<{ conversationId: string; message: MessageDTO }>;
        };
        setMsgResults(data.results ?? []);
      } catch {
        setMsgResults([]);
      }
    }, filter.trim().length >= 2 ? 250 : 0);
    return () => clearTimeout(t);
  }, [filter]);

  return (
    <>
      <aside
        className={`flex w-full flex-col border-r border-line bg-ink-900 md:w-[330px] lg:w-[370px] ${
          activeId ? "hidden md:flex" : "flex"
        }`}
      >
        <header className="flex items-center gap-2.5 px-4 pb-3 pt-4">
          <div className="brand-tile size-9 rounded-xl">
            <Flame className="size-5" strokeWidth={2.5} />
          </div>
          <h1 className="mr-auto font-display text-lg font-semibold tracking-tight text-mist-200">
            FireChat
          </h1>
          <button
            onClick={() => setDialogOpen(true)}
            className="flex size-9 items-center justify-center rounded-xl bg-accent-500 text-white transition hover:bg-accent-600 focus:outline-none focus:ring-2 focus:ring-accent-500/50"
            aria-label="New conversation"
          >
            <Plus className="size-5" strokeWidth={2.5} />
          </button>
        </header>

        <div className="px-3 pb-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-mist-400" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search conversations and messages"
              className="field !rounded-xl !py-2.5 pl-9"
            />
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto px-2.5 pb-2">
          {archivedCount > 0 && !filter.trim() && (
            <button
              onClick={() => setShowArchived((v) => !v)}
              className={`mb-1 flex w-full items-center gap-2 rounded-xl px-3 py-2 text-xs font-semibold uppercase tracking-wide transition ${
                showArchived
                  ? "bg-accent-500/10 text-accent-300 ring-1 ring-accent-500/25"
                  : "text-mist-400 hover:bg-ink-800"
              }`}
            >
              <Archive className="size-3.5" />
              {showArchived ? "Back to chats" : `Archived (${archivedCount})`}
            </button>
          )}

          {!data && (
            <div className="space-y-1 p-2">
              {[...Array(6)].map((_, i) => (
                <div key={i} className="flex items-center gap-3 rounded-lg p-2">
                  <div className="size-10 animate-pulse rounded-full bg-ink-700" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3 w-24 animate-pulse rounded bg-ink-700" />
                    <div className="h-2.5 w-36 animate-pulse rounded bg-ink-800" />
                  </div>
                </div>
              ))}
            </div>
          )}

          {data && activeConversations.length === 0 && archivedCount === 0 && !filter.trim() && (
            <p className="px-4 py-10 text-center text-sm text-mist-400">
              No conversations yet. Tap + to start one!
            </p>
          )}

          {msgResults.length > 0 && (
            <div className="mb-3 rounded-2xl border border-line bg-ink-800/50 p-1.5">
              <p className="px-2 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-accent-300">
                Messages
              </p>
              <ul className="space-y-0.5">
                {msgResults.slice(0, 8).map((r) => {
                  const conv = (data?.conversations ?? []).find((c) => c.id === r.conversationId);
                  const title = conv
                    ? conv.isGroup
                      ? (conv.name ?? "Group")
                      : (conv.members.find((m) => m.id !== me.id)?.username ?? "Unknown")
                    : "Unknown";
                  return (
                    <li key={r.message.id}>
                      <Link
                        href={`/c/${r.conversationId}?msg=${r.message.id}`}
                        onClick={() => setFilter("")}
                        className="block rounded-xl p-2 transition hover:bg-ink-700/70"
                      >
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="truncate text-xs font-semibold text-accent-300">{title}</span>
                          <span className="shrink-0 text-[10px] text-mist-400">
                            {formatTime(r.message.createdAt)}
                          </span>
                        </div>
                        <p className="truncate text-xs text-mist-400">{r.message.content}</p>
                      </Link>
                    </li>
                  );
                })}
              </ul>
              {msgResults.length > 8 && (
                <p className="px-2 py-1 text-[11px] text-mist-400">
                  +{msgResults.length - 8} more matches
                </p>
              )}
            </div>
          )}

          {(activeConversations.length > 0 || msgResults.length > 0) && (
            <p className="px-2 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-widest text-mist-400/80">
              Chats
            </p>
          )}

          <ul className="space-y-1">
            {(showArchived ? archivedList : activeConversations).map((c) => {
              const other = c.members.find((m) => m.id !== me.id);
              const title = c.isGroup ? (c.name ?? "Group") : (other?.username ?? "Unknown");
              const isActive = c.id === activeId;
              return (
                <li key={c.id} className="group/item relative">
                  <Link
                    href={`/c/${c.id}`}
                    onClick={() => {
                      setFilter("");
                      setMenuForId(null);
                    }}
                    className={`relative flex items-center gap-3 rounded-xl p-3 pr-10 transition-colors duration-150 ${
                      isActive
                        ? "bg-ink-800"
                        : "hover:bg-ink-800/70"
                    }`}
                  >
                    {isActive && (
                      <span className="absolute left-0 top-1/2 h-6 w-1 -translate-y-1/2 rounded-r-full bg-accent-500" />
                    )}
                    {c.isGroup ? (
                      <div className="relative flex size-11 shrink-0 items-center justify-center rounded-2xl bg-ink-600 text-sm font-bold text-mist-200">
                        {(c.name ?? "G").slice(0, 1).toUpperCase()}
                        {onlineIds.size > 0 && (
                          <span className="absolute -bottom-0.5 -right-0.5 size-3 rounded-full border-2 border-ink-900 bg-online" />
                        )}
                      </div>
                    ) : (
                      <Avatar
                        username={other?.username ?? "?"}
                        avatarUrl={other?.avatarUrl}
                        online={other ? onlineIds.has(other.id) : undefined}
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-1">
                          {c.pinnedAt && <Pin className="size-3 shrink-0 text-accent-400/80" />}
                          {c.muted && <BellOff className="size-3 shrink-0 text-mist-400" />}
                          <span className="truncate font-medium text-mist-200">{title}</span>
                        </span>
                        {c.lastMessage && (
                          <span className="shrink-0 text-[11px] tabular-nums text-mist-400">
                            {formatTime(c.lastMessage.createdAt)}
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 flex items-center justify-between gap-2">
                        <span className="truncate text-sm text-mist-400">
                          {previewText(c.lastMessage)}
                        </span>
                        {c.unreadCount > 0 && (
                          <span className="flex h-5 min-w-5 shrink-0 animate-pop-in items-center justify-center rounded-full bg-accent-500 px-1.5 text-[11px] font-bold text-white">
                            {c.unreadCount > 99 ? "99+" : c.unreadCount}
                          </span>
                        )}
                      </div>
                    </div>
                  </Link>

                  <button
                    onClick={() => setMenuForId(menuForId === c.id ? null : c.id)}
                    aria-label={`Options for ${title}`}
                    className={`absolute right-2 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-full text-mist-400 transition hover:bg-ink-600 hover:text-mist-200 group-hover/item:flex ${
                      menuForId === c.id ? "flex bg-ink-600" : "hidden"
                    }`}
                  >
                    <MoreVertical className="size-4" />
                  </button>

                  {menuForId === c.id && (
                    <>
                      <div className="fixed inset-0 z-10" onClick={() => setMenuForId(null)} />
                      <div className="absolute right-2 top-full z-20 mt-1 w-44 overflow-hidden rounded-lg border border-ink-700 bg-ink-800 py-1 shadow-xl animate-pop-in">
                        <button
                          onClick={() => {
                            setMenuForId(null);
                            void updateFlags(c, { pinned: !c.pinnedAt });
                          }}
                          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-mist-200 transition hover:bg-ink-700"
                        >
                          <Pin className="size-4" />
                          {c.pinnedAt ? "Unpin" : "Pin to top"}
                        </button>
                        <button
                          onClick={() => {
                            setMenuForId(null);
                            void updateFlags(c, { muted: !c.muted });
                          }}
                          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-mist-200 transition hover:bg-ink-700"
                        >
                          {c.muted ? <Bell className="size-4" /> : <BellOff className="size-4" />}
                          {c.muted ? "Unmute" : "Mute"}
                        </button>
                        <button
                          onClick={() => {
                            setMenuForId(null);
                            void updateFlags(c, { archived: !c.archivedAt });
                          }}
                          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-mist-200 transition hover:bg-ink-700"
                        >
                          <Archive className="size-4" />
                          {c.archivedAt ? "Unarchive" : "Archive"}
                        </button>
                        <div className="my-1 h-px bg-ink-700" />
                        <button
                          onClick={() => {
                            setMenuForId(null);
                            setConfirmTarget(c);
                          }}
                          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red-600 transition hover:bg-ink-700"
                        >
                          {c.isGroup ? <LogOut className="size-4" /> : <Trash2 className="size-4" />}
                          {c.isGroup ? "Exit group" : "Delete chat"}
                        </button>
                      </div>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </nav>

        <footer className="flex items-center gap-2 border-t border-line bg-ink-900 px-3 py-3">
          <button
            onClick={() => setProfileOpen(true)}
            className="flex min-w-0 flex-1 items-center gap-3 rounded-xl p-1 text-left transition hover:bg-ink-800/80"
            title="Edit profile"
          >
            <Avatar username={me.username} avatarUrl={me.avatarUrl} online />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-mist-200">{me.username}</p>
              <p className="text-xs text-online">Online</p>
            </div>
          </button>
          <ThemeToggle />
          <button
            onClick={() => void togglePush()}
            disabled={pushBusy || pushState === "unsupported"}
            aria-label={
              pushState === "subscribed" ? "Disable notifications" : "Enable notifications"
            }
            title={
              pushState === "subscribed"
                ? "Notifications on"
                : pushState === "denied"
                  ? "Notifications blocked in browser settings"
                  : pushState === "unsupported"
                    ? "Push not supported here"
                    : "Enable notifications"
            }
            className={`flex size-9 items-center justify-center rounded-full transition hover:bg-ink-700 disabled:opacity-50 ${
              pushState === "subscribed" ? "text-accent-400" : "text-mist-400 hover:text-mist-200"
            }`}
          >
            {pushState === "subscribed" ? (
              <Bell className="size-4.5" />
            ) : (
              <BellOff className="size-4.5" />
            )}
          </button>
          <button
            onClick={logout}
            aria-label="Sign out"
            title="Sign out"
            className="flex size-9 items-center justify-center rounded-full text-mist-400 transition hover:bg-ink-700 hover:text-mist-200"
          >
            <LogOut className="size-4.5" />
          </button>
        </footer>
      </aside>

      {dialogOpen && <NewChatDialog onClose={() => setDialogOpen(false)} />}

      {profileOpen && (
        <ProfileDialog
          me={me}
          onClose={() => setProfileOpen(false)}
          onSaved={() => router.refresh()}
        />
      )}

      <ConfirmDialog
        open={confirmTarget !== null}
        title={confirmTarget?.isGroup ? "Exit group?" : "Delete chat?"}
        body={
          confirmTarget?.isGroup
            ? "You will stop receiving messages from this group. You can be added again later."
            : `This clears ${
                confirmTarget && !confirmTarget.isGroup
                  ? (confirmTarget.members.find((m) => m.id !== me.id)?.username ?? "this chat")
                  : "this chat"
              } from your list and hides its messages here. They will keep their copy.`
        }
        confirmLabel={confirmTarget?.isGroup ? "Exit" : "Delete"}
        onConfirm={() => void handleConfirmDeleteOrExit()}
        onCancel={() => setConfirmTarget(null)}
      />
    </>
  );
}
