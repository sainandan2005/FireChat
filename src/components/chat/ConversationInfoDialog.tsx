"use client";

import { useEffect, useState } from "react";
import { Crown, Loader2, UserMinus } from "lucide-react";
import Avatar from "./Avatar";
import Modal, { ModalHeader } from "./Modal";
import type { ConversationDetail, PublicUser } from "@/lib/types";

function formatLastSeen(iso: string | null): string {
  if (!iso) return "Never online";
  const date = new Date(iso);
  return `Last seen ${date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

export default function ConversationInfoDialog({
  conversation,
  meId,
  onlineIds,
  onClose,
  onChanged,
}: {
  conversation: ConversationDetail;
  meId: string;
  onlineIds: Set<string>;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PublicUser[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(conversation.name ?? "");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const t = setTimeout(async () => {
      const q = query.trim();
      if (!adding || !q) {
        setResults([]);
        setSearching(false);
        return;
      }
      setSearching(true);
      try {
        const res = await fetch(`/api/users?q=${encodeURIComponent(q)}`);
        const data = (await res.json()) as { users: PublicUser[] };
        setResults((data.users ?? []).filter((u) => !conversation.members.some((m) => m.id === u.id)));
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, adding && query.trim() ? 250 : 0);
    return () => clearTimeout(t);
  }, [query, adding, conversation.members]);

  async function addMember(userId: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/conversations/${conversation.id}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Could not add member");
        return;
      }
      setQuery("");
      setResults([]);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function removeMember(userId: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/conversations/${conversation.id}/members`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Could not remove member");
        return;
      }
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function saveName() {
    const name = nameDraft.trim();
    if (!name || name === conversation.name) {
      setRenaming(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/conversations/${conversation.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Could not rename");
        return;
      }
      setRenaming(false);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  const otherMember =
    !conversation.isGroup
      ? conversation.members.find((m) => m.id !== meId)
      : undefined;

  return (
    <Modal onClose={onClose} labelledBy="info-title">
      <div className="max-h-[80vh] w-full overflow-y-auto">
        <ModalHeader
          title={conversation.isGroup ? "Group info" : "Profile"}
          onClose={onClose}
        />

        <div className="flex flex-col items-center gap-2 px-6 pb-4 pt-2 text-center">
          {conversation.isGroup ? (
            <div className="brand-tile size-20 rounded-full text-2xl font-bold text-white">
              {(conversation.name ?? "G").slice(0, 1).toUpperCase()}
            </div>
          ): (
            <Avatar
              username={otherMember?.username ?? "?"}
              avatarUrl={otherMember?.avatarUrl}
              size="lg"
            />
          )}

          {conversation.isGroup && renaming ? (
            <div className="mt-1 flex w-full items-center gap-2">
              <input
                autoFocus
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveName();
                  if (e.key === "Escape") setRenaming(false);
                }}
                maxLength={50}
                className="flex-1 rounded-lg border border-ink-600 bg-ink-800 px-3 py-1.5 text-sm text-mist-200 outline-none focus:border-accent-500"
              />
              <button onClick={() => void saveName()} className="rounded-lg bg-accent-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-accent-400">
                Save
              </button>
            </div>
          ) : (
            <h3 className="text-lg font-bold text-mist-200">
              {conversation.isGroup ? (conversation.name ?? "Group") : (otherMember?.username ?? "Unknown")}
              {!conversation.isGroup && otherMember && (
                <span className={`ml-2 inline-block rounded-full px-2 py-0.5 align-middle text-[10px] font-semibold ${
                  onlineIds.has(otherMember.id)
                    ? "bg-online/15 text-online"
                    : "bg-ink-700 text-mist-400"
                }`}>
                  {onlineIds.has(otherMember.id) ? "Online" : "Offline"}
                </span>
              )}
            </h3>
          )}
          {conversation.isGroup && (
            <p className="text-xs text-mist-400">
              {conversation.members.length} members · created{" "}
              {new Date(conversation.updatedAt).toLocaleDateString([], { month: "short", day: "numeric" })}
            </p>
          )}
          {!conversation.isGroup && otherMember && (
            <p className="text-xs text-mist-400">{formatLastSeen(otherMember.lastSeenAt)}</p>
          )}
        </div>

        {error && (
          <p className="mx-4 mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
            {error}
          </p>
        )}

        {conversation.isGroup ? (
          <section className="border-t border-ink-800 px-4 py-3">
            <div className="mb-2 flex items-center justify-between">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-mist-400">
                Members
              </h4>
              <button
                onClick={() => setAdding((v) => !v)}
                disabled={busy}
                className="rounded-full bg-ink-700 px-3 py-1 text-xs font-semibold text-accent-300 transition hover:bg-ink-600"
              >
                {adding ? "Cancel" : "+ Add"}
              </button>
            </div>

            {conversation.isGroup && conversation.myRole === "owner" && !renaming && (
              <button
                onClick={() => {
                  setNameDraft(conversation.name ?? "");
                  setRenaming(true);
                }}
                className="mb-2 w-full rounded-lg border border-ink-600 py-1.5 text-xs font-medium text-mist-300 transition hover:bg-ink-800"
              >
                Rename group
              </button>
            )}

            {adding && (
              <div className="mb-3">
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search people to add…"
                  className="w-full rounded-lg border border-ink-600 bg-ink-800 px-3 py-2 text-sm text-mist-200 placeholder-mist-400/60 outline-none focus:border-accent-500"
                />
                {searching && (
                  <div className="flex justify-center py-3">
                    <Loader2 className="size-4 animate-spin text-mist-400" />
                  </div>
                )}
                <ul className="mt-1 space-y-0.5">
                  {results.map((u) => (
                    <li key={u.id}>
                      <button
                        onClick={() => void addMember(u.id)}
                        disabled={busy}
                        className="flex w-full items-center gap-2.5 rounded-lg p-2 text-left transition hover:bg-ink-800 disabled:opacity-60"
                      >
                        <Avatar username={u.username} avatarUrl={u.avatarUrl} size="sm" />
                        <span className="truncate text-sm text-mist-200">{u.username}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <ul className="space-y-0.5">
              {conversation.members.map((member) => {
                const isOwnerRow = conversation.ownerId === member.id;
                const canRemove =
                  conversation.myRole === "owner" && member.id !== meId;
                return (
                  <li key={member.id} className="group flex items-center gap-2.5 rounded-lg p-2 hover:bg-ink-800">
                    <Avatar username={member.username} avatarUrl={member.avatarUrl} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-mist-200">
                        {member.username}
                        {member.id === meId && <span className="ml-1 text-xs text-mist-400">(you)</span>}
                      </p>
                      <p className="text-[11px] text-mist-400">
                        {onlineIds.has(member.id) ? "Online" : formatLastSeen(member.lastSeenAt)}
                      </p>
                    </div>
                    {isOwnerRow && (
                      <Crown className="size-4 shrink-0 text-accent-400" aria-label="Group owner" />
                    )}
                    {canRemove && (
                      <button
                        onClick={() => void removeMember(member.id)}
                        disabled={busy}
                        aria-label={`Remove ${member.username}`}
                        title="Remove from group"
                        className="hidden size-7 items-center justify-center rounded-full text-mist-400 transition hover:bg-ink-600 hover:text-red-600 group-hover:flex"
                      >
                        <UserMinus className="size-4" />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : (
          <section className="border-t border-ink-800 px-4 py-3">
            <p className="text-xs uppercase tracking-wide text-mist-400">Username</p>
            <p className="text-sm text-mist-200">{otherMember?.username}</p>
          </section>
        )}
      </div>
    </Modal>
  );
}
