"use client";

import Modal from "./Modal";

export default function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;

  return (
    <Modal onClose={onCancel} size="sm">
      <div className="p-6">
        <h3 className="font-semibold text-mist-200">{title}</h3>
        <p className="mt-2 text-sm leading-relaxed text-mist-400">{body}</p>
        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-xl px-4 py-2 text-sm font-medium text-mist-300 transition hover:bg-ink-700"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white  transition hover:bg-red-500 focus:outline-none focus:ring-2 focus:ring-red-500/50"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
