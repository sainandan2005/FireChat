"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { Check, Loader2, MessageCircle, Users, X } from "lucide-react";
import Modal, { ModalHeader } from "./Modal";
import Avatar from "./Avatar";
import type { PublicUser } from "@/lib/types";

const fetcher = (url: string) => fetch(url).then((res) => res.json());

export default function NewChatDialog({
  onClose,
}: {
  onClose: () => void;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<"dm" | "group">("dm");
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selected, setSelected] = useState<Map<string, PublicUser>>(new Map());
  const [groupName, setGroupName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    setTimeout(() => inputRef.current?.focus(), 50);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const { data, isLoading } = useSWR<{ users: PublicUser[] }>(
    debounced ? `/api/users?q=${encodeURIComponent(debounced)}` : null,
    fetcher
  );
  const users = data?.users ?? [];

  function toggleUser(user: PublicUser) {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(user.id)) next.delete(user.id);
      else next.set(user.id, user);
      return next;
    });
  }

  async function startDm(userId: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "dm", userId }),
      });
      const data = (await res.json()) as { conversation?: { id: string }; error?: string };
      if (!res.ok || !data.conversation) {
        setError(data.error ?? "Could not start conversation");
        return;
      }
      router.push(`/c/${data.conversation.id}`);
      onClose();
    } catch {
      setError("Network error, please try again");
    } finally {
      setBusy(false);
    }
  }

  async function createGroup() {
    if (busy) return;
    if (!groupName.trim()) {
      setError("Please enter a group name");
      return;
    }
    if (selected.size === 0) {
      setError("Select at least one member");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "group",
          name: groupName.trim(),
          memberIds: Array.from(selected.keys()),
        }),
      });
      const data = (await res.json()) as { conversation?: { id: string }; error?: string };
      if (!res.ok || !data.conversation) {
        setError(data.error ?? "Could not create group");
        return;
      }
      router.push(`/c/${data.conversation.id}`);
      onClose();
    } catch {
      setError("Network error, please try again");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} labelledBy="new-chat-title">
      <div className="flex max-h-[80vh] w-full flex-col overflow-hidden">
        <ModalHeader title="New conversation" onClose={onClose} />

        <div className="flex gap-1 px-4 pt-3">
          <button
            onClick={() => setTab("dm")}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl py-2 text-sm font-medium transition ${
              tab === "dm"
                ? "bg-gradient-to-br from-accent-400 to-accent-600 text-white shadow-glow"
                : "bg-ink-800 text-mist-300 hover:bg-ink-700"
            }`}
          >
            <MessageCircle className="size-4" /> Direct message
          </button>
          <button
            onClick={() => setTab("group")}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl py-2 text-sm font-medium transition ${
              tab === "group"
                ? "bg-gradient-to-br from-accent-400 to-accent-600 text-white shadow-glow"
                : "bg-ink-800 text-mist-300 hover:bg-ink-700"
            }`}
          >
            <Users className="size-4" /> Group
          </button>
        </div>

        <div className="space-y-3 p-4">
          {tab === "group" && (
            <input
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              placeholder="Group name"
              maxLength={50}
              className="field"
            />
          )}

          {tab === "group" && selected.size > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {Array.from(selected.values()).map((u) => (
                <span
                  key={u.id}
                  className="flex items-center gap-1 rounded-full bg-ink-700 py-1 pl-1 pr-2 text-xs font-medium text-mist-200"
                >
                  <Avatar username={u.username} avatarUrl={u.avatarUrl} size="sm" />
                  {u.username}
                  <button
                    onClick={() => toggleUser(u)}
                    aria-label={`Remove ${u.username}`}
                    className="ml-0.5 rounded-full p-0.5 hover:bg-ink-600"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}

          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search people by username or email"
            className="field"
          />

          {error && (
            <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
              {error}
            </p>
          )}
        </div>

        <div className="min-h-40 flex-1 overflow-y-auto px-2 pb-2">
          {debounced && !isLoading && users.length === 0 && (
            <p className="py-8 text-center text-sm text-mist-400">No users found</p>
          )}
          {!debounced && (
            <p className="py-8 text-center text-sm text-mist-400">
              Type to search for people to chat with
            </p>
          )}
          {isLoading && debounced && (
            <div className="flex justify-center py-8">
              <Loader2 className="size-5 animate-spin text-mist-400" />
            </div>
          )}
          <ul className="space-y-0.5">
            {users.map((u) => {
              const isSelected = selected.has(u.id);
              return (
                <li key={u.id}>
                  <button
                    onClick={() =>
                      tab === "dm" ? startDm(u.id) : toggleUser(u)
                    }
                    disabled={busy}
                    className="flex w-full items-center gap-3 rounded-xl p-2.5 text-left transition hover:bg-ink-800 disabled:opacity-60"
                  >
                    <Avatar username={u.username} avatarUrl={u.avatarUrl} />
                    <span className="min-w-0 flex-1 truncate font-medium text-mist-200">
                      {u.username}
                    </span>
                    {tab === "group" && isSelected && (
                      <Check className="size-5 text-accent-400" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        {tab === "group" && (
          <footer className="border-t border-line p-4">
            <button
              onClick={createGroup}
              disabled={busy || selected.size === 0 || !groupName.trim()}
              className="btn-primary w-full"
            >
              {busy ? "Creating…" : `Create group${selected.size > 0 ? ` (${selected.size + 1})` : ""}`}
            </button>
          </footer>
        )}
      </div>
    </Modal>
  );
}
