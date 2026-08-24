import ChatProviders from "./providers";
import Sidebar from "./Sidebar";

export default function ChatShell({
  me,
  children,
}: {
  me: { id: string; username: string; avatarUrl: string | null };
  children: React.ReactNode;
}) {
  return (
    <ChatProviders me={me}>
      <div className="flex h-dvh overflow-hidden bg-canvas">
        <Sidebar me={me} />
        <main className="flex min-w-0 flex-1 flex-col">{children}</main>
      </div>
    </ChatProviders>
  );
}
