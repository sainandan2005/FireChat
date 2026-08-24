"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, Loader2 } from "lucide-react";
import Avatar from "./Avatar";
import Modal, { ModalHeader } from "./Modal";
import type { PublicUser } from "@/lib/types";

const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const MAX_AVATAR_SIZE = 10 * 1024 * 1024;

export default function ProfileDialog({
  me,
  onClose,
  onSaved,
}: {
  me: { id: string; username: string; avatarUrl: string | null };
  onClose: () => void;
  onSaved: (user: PublicUser) => void;
}) {
  const [username, setUsername] = useState(me.username);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(me.avatarUrl);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const dirty = username.trim().toLowerCase() !== me.username || avatarUrl !== me.avatarUrl;

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    setError(null);
    if (!file.type.startsWith("image/")) {
      setError("Avatar must be an image");
      return;
    }
    if (file.size > MAX_AVATAR_SIZE) {
      setError("Image exceeds the 10 MB limit");
      return;
    }

    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const data = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !data.url) {
        setError(data.error ?? "Upload failed");
        return;
      }
      setAvatarUrl(data.url);
    } catch {
      setError("Upload failed, network error");
    } finally {
      setUploading(false);
    }
  }

  async function save() {
    const nextUsername = username.trim().toLowerCase();
    if (!USERNAME_RE.test(nextUsername)) {
      setError("Username must be 3-20 characters (letters, numbers, underscores)");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: nextUsername,
          ...(avatarUrl !== me.avatarUrl ? { avatarUrl: avatarUrl ?? "" } : {}),
        }),
      });
      const data = (await res.json()) as { user?: PublicUser; error?: string };
      if (!res.ok || !data.user) {
        setError(data.error ?? "Could not save profile");
        return;
      }
      onSaved(data.user);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal onClose={onClose} size="sm" labelledBy="profile-title">
      <ModalHeader title="Your profile" onClose={onClose} />

      <div className="flex flex-col items-center gap-2.5 px-6 pb-5 pt-6">
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          aria-label="Change avatar"
          title="Change avatar"
          className="group relative rounded-full focus:outline-none focus:ring-2 focus:ring-accent-500/60 disabled:opacity-70"
        >
          <Avatar username={me.username} avatarUrl={avatarUrl} size="lg" />
          <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/55 opacity-0 backdrop-blur-[2px] transition group-hover:opacity-100">
            {uploading ? (
              <Loader2 className="size-5 animate-spin text-white" />
            ) : (
              <Camera className="size-5 text-white" />
            )}
          </span>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          className="hidden"
          onChange={handleFileSelected}
        />
        <span className="text-xs text-mist-400">Click the avatar to upload</span>
      </div>

      <div className="px-6 pb-1">
        <label htmlFor="profile-username" className="mb-1.5 block text-sm font-medium text-mist-300">
          Username
        </label>
        <input
          id="profile-username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          maxLength={20}
          autoComplete="username"
          className="field"
        />
      </div>

      {error && (
        <p className="mx-6 mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
          {error}
        </p>
      )}

      <div className="p-6 pt-5">
        <button onClick={() => void save()} disabled={saving || uploading || !dirty} className="btn-primary w-full">
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </Modal>
  );
}
