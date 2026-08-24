import ChatPanel from "@/components/chat/ChatPanel";

export default async function ConversationPage({
  params,
}: PageProps<"/c/[id]">) {
  const { id } = await params;
  return <ChatPanel key={id} conversationId={id} />;
}
