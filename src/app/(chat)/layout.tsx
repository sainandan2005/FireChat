import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import ChatShell from "@/components/chat/ChatShell";

export default async function ChatLayout({ children }: LayoutProps<"/">) {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  return <ChatShell me={user}>{children}</ChatShell>;
}
