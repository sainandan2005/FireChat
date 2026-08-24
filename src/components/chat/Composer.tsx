"use client";

import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { Loader2, Mic, Paperclip, Reply, SendHorizontal, X } from "lucide-react";
import type { MessageDTO, PublicUser, UploadResult } from "@/lib/types";

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_VOICE_MS = 120_000;

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function pickRecorderMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t));
}

export default function Composer({
  onSendText,
  onSendFile,
  onTypingChange,
  replyTarget,
  membersById,
  onCancelReply,
}: {
  onSendText: (content: string) => void;
  onSendFile: (result: UploadResult, durationSeconds?: number) => void;
  onTypingChange: (typing: boolean) => void;
  replyTarget: MessageDTO | null;
  membersById: Map<string, PublicUser>;
  onCancelReply: () => void;
}) {
  const [value, setValue] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordElapsed, setRecordElapsed] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const startedAtRef = useRef(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [value]);

  // focus the input whenever the user picks something to reply to
  const prevReplyIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (replyTarget && prevReplyIdRef.current !== replyTarget.id) {
      textareaRef.current?.focus();
    }
    prevReplyIdRef.current = replyTarget?.id ?? null;
  }, [replyTarget]);

  function notifyTyping(typing: boolean) {
    onTypingChange(typing);
  }

  async function startRecording() {
    if (uploading || recording) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = pickRecorderMime();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.start(250);
      recorderRef.current = recorder;
      startedAtRef.current = Date.now();
      setRecordElapsed(0);
      tickRef.current = setInterval(
        () => setRecordElapsed(Date.now() - startedAtRef.current),
        200
      );
      setRecording(true);
    } catch {
      setUploadError("Microphone access denied");
    }
  }

  function stopRecordingTracks() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = null;
    setRecording(false);
  }

  async function finishRecording(send: boolean) {
    const recorder = recorderRef.current;
    if (!recorder) return;
    const durationSeconds = Math.max(1, Math.round((Date.now() - startedAtRef.current) / 1000));
    recorderRef.current = null;

    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
      if (recorder.state === "inactive") resolve();
      else recorder.stop();
    });
    await stopped;
    stopRecordingTracks();

    if (!send) return;

    const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
    chunksRef.current = [];
    if (blob.size === 0) {
      setUploadError("Recording was empty");
      return;
    }

    setUploading(true);
    setUploadError(null);
    try {
      const form = new FormData();
      form.append("file", blob, `voice-${Date.now()}.weba`);
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const data = (await res.json()) as UploadResult & { error?: string };
      if (!res.ok) {
        setUploadError(data.error ?? "Upload failed");
        return;
      }
      onSendFile(data, durationSeconds);
    } catch {
      setUploadError("Upload failed, network error");
    } finally {
      setUploading(false);
    }
  }

  useEffect(() => {
    if (!recording) return;
    const t = setTimeout(() => void finishRecording(true), MAX_VOICE_MS - (Date.now() - startedAtRef.current));
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording]);

  function handleChange(e: ChangeEvent<HTMLTextAreaElement>) {
    const next = e.target.value;
    if (!value.trim() && next.trim()) {
      notifyTyping(true);
    }
    if (value.trim() && !next.trim()) {
      notifyTyping(false);
    }
    setValue(next);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  function send() {
    const content = value.trim();
    if (!content || uploading) return;
    onSendText(content);
    setValue("");
    notifyTyping(false);
    textareaRef.current?.focus();
  }

  async function handleFileSelected(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    setUploadError(null);
    if (file.size > MAX_FILE_SIZE) {
      setUploadError("File exceeds the 10 MB limit");
      return;
    }

    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const data = (await res.json()) as UploadResult & { error?: string };
      if (!res.ok) {
        setUploadError(data.error ?? "Upload failed");
        return;
      }
      onSendFile(data);
    } catch {
      setUploadError("Upload failed, network error");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="px-3 pb-4 pt-2">
      <div className="rounded-2xl border border-ink-600 bg-surface transition focus-within:border-accent-500">
      {replyTarget && (
        <div className="flex animate-pop-in items-center gap-2 border-b border-line px-4 py-2.5">
          <Reply className="size-4 shrink-0 text-accent-300" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-accent-300">
              Replying to {membersById.get(replyTarget.senderId)?.username ?? "message"}
            </p>
            <p className="truncate text-xs text-mist-400">
              {replyTarget.type === "TEXT"
                ? replyTarget.content
                : replyTarget.type === "IMAGE"
                  ? "📷 Photo"
                  : `📎 ${replyTarget.fileName ?? "File"}`}
            </p>
          </div>
          <button
            onClick={onCancelReply}
            aria-label="Cancel reply"
            className="flex size-6 shrink-0 items-center justify-center rounded-full text-mist-400 transition hover:bg-ink-700 hover:text-mist-200"
          >
            <X className="size-4" />
          </button>
        </div>
      )}
      {recording ? (
        <div className="flex items-center gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-2.5">
          <span className="size-2.5 animate-pulse rounded-full bg-red-500" aria-label="Recording" />
          <span className="font-mono text-sm text-mist-200">{formatElapsed(recordElapsed)}</span>
          <span className="flex-1 text-xs text-mist-400">Recording voice message… (max 2 min)</span>
          <button
            onClick={() => void finishRecording(false)}
            aria-label="Cancel recording"
            className="flex size-8 items-center justify-center rounded-full text-mist-400 transition hover:bg-ink-700 hover:text-mist-200"
          >
            <X className="size-4" />
          </button>
          <button
            onClick={() => void finishRecording(true)}
            disabled={uploading}
            aria-label="Send voice message"
            className="flex size-10 items-center justify-center rounded-full bg-accent-500 text-white transition hover:bg-accent-400 disabled:opacity-60"
          >
            {uploading ? <Loader2 className="size-5 animate-spin" /> : <SendHorizontal className="size-5" strokeWidth={2.25} />}
          </button>
        </div>
      ) : (
        <div className="flex items-end gap-1.5 p-2">
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={handleFileSelected}
            accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,text/csv,application/zip,audio/mpeg,video/mp4"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            aria-label="Attach a file"
            title="Attach a file"
            className="flex size-10 shrink-0 items-center justify-center rounded-full text-mist-400 transition hover:bg-ink-700 hover:text-mist-200 disabled:opacity-50"
          >
            <Paperclip className="size-5" />
          </button>

          <textarea
            ref={textareaRef}
            rows={1}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onBlur={() => value.trim() && notifyTyping(false)}
            placeholder="Type a message…"
            aria-label="Message"
            className="max-h-40 min-h-[44px] flex-1 resize-none rounded-2xl border border-ink-600 bg-ink-800 px-4 py-2.5 text-sm text-mist-200 placeholder-mist-400/60 outline-none transition focus:border-accent-500/70"
          />

          {!value.trim() && (
            <button
              onClick={() => void startRecording()}
              disabled={uploading}
              aria-label="Record voice message"
              title="Record voice message"
              className="flex size-10 shrink-0 items-center justify-center rounded-full text-mist-400 transition hover:bg-ink-700 hover:text-accent-300 disabled:opacity-50"
            >
              <Mic className="size-5" />
            </button>
          )}

          <button
            onClick={send}
            disabled={!value.trim() || uploading}
            aria-label="Send message"
            className={`flex size-10 shrink-0 items-center justify-center rounded-full transition ${
              value.trim() && !uploading
                ? "bg-accent-500 text-white hover:bg-accent-400"
                : "bg-ink-600 text-mist-400"
            }`}
          >
            {uploading ? (
              <Loader2 className="size-5 animate-spin" />
            ) : (
              <SendHorizontal className="size-5" strokeWidth={2.25} />
            )}
          </button>
        </div>
      )}
      </div>
      {(uploadError || uploading) && (
        <p className={`px-2 pt-1.5 text-xs ${uploadError ? "text-red-600" : "text-mist-400"}`}>
          {uploadError ?? "Uploading…"}
        </p>
      )}
    </div>
  );
}
