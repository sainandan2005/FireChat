"use client";

import { useEffect } from "react";
import { X } from "lucide-react";

export default function Lightbox({ url, onClose }: { url: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[60] flex animate-fade-in items-center justify-center bg-black/85 p-6"
      onClick={onClose}
      role="dialog"
      aria-label="Image preview"
    >
      <button
        onClick={onClose}
        aria-label="Close preview"
        className="absolute right-5 top-5 flex size-10 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-white/20"
      >
        <X className="size-5" />
      </button>
      <img
        src={url}
        alt="Full size"
        className="max-h-[90vh] max-w-full animate-pop-in rounded-lg object-contain shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}
