"use client";

import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";

export default function Modal({
  onClose,
  children,
  size = "md",
  labelledBy,
}: {
  onClose: () => void;
  children: ReactNode;
  size?: "sm" | "md" | "lg";
  labelledBy?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const widths = { sm: "max-w-xs", md: "max-w-md", lg: "max-w-lg" } as const;

  return (
    <div
      className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-black/70 p-4 backdrop-blur-md"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
    >
      <div
        className={`w-full ${widths[size]} max-h-[85vh] animate-pop-in overflow-hidden rounded-2xl border border-ink-700 bg-ink-900 `}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

export function ModalHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <header className="flex items-center justify-between border-b border-line px-5 py-3.5">
      <h2 className="font-semibold text-mist-200">{title}</h2>
      <button
        onClick={onClose}
        aria-label="Close"
        className="icon-btn size-8 text-mist-400 hover:text-mist-200"
      >
        <X className="size-4" />
      </button>
    </header>
  );
}
