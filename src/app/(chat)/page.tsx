import { Flame, MessageCircle, Phone, Image as ImageIcon } from "lucide-react";

export default function EmptyStatePage() {
  return (
    <div className="hidden h-full flex-col items-center justify-center gap-5 md:flex">
      <div className="flex size-14 items-center justify-center rounded-2xl bg-ink-800">
        <Flame className="size-7 text-accent-400" />
      </div>

      <div className="text-center">
        <h2 className="font-display text-lg font-semibold tracking-tight text-mist-200">
          Welcome to FireChat
        </h2>
        <p className="mt-1 text-sm text-mist-400">
          Select a conversation, or press + to start one.
        </p>
      </div>

      <ul className="mt-3 space-y-2 text-sm text-mist-400">
        <li className="flex items-center gap-2.5">
          <MessageCircle className="size-4 text-accent-400" /> Message friends in real time
        </li>
        <li className="flex items-center gap-2.5">
          <Phone className="size-4 text-accent-400" /> Jump on a voice or video call
        </li>
        <li className="flex items-center gap-2.5">
          <ImageIcon className="size-4 text-accent-400" /> Share photos, files and voice notes
        </li>
      </ul>
    </div>
  );
}
