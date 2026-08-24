import type { ReactNode } from "react";
import { Flame } from "lucide-react";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-sm animate-pop-in">
        <div className="mb-8 flex flex-col items-center gap-3">
          <div className="brand-tile size-14 rounded-2xl">
            <Flame className="size-7" strokeWidth={2.2} />
          </div>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-mist-200">
            FireChat
          </h1>
        </div>

        {children}
      </div>
    </main>
  );
}
