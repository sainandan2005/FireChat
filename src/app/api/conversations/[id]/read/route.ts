import { NextResponse, type NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { emitToConversation, emitToUser } from "@/lib/ws-server";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: RouteContext) {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;

  const member = await prisma.participant.findUnique({
    where: { userId_conversationId: { userId: me.id, conversationId: id } },
    select: { id: true },
  });
  if (!member) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });

  const now = new Date();
  await prisma.participant.update({
    where: { userId_conversationId: { userId: me.id, conversationId: id } },
    data: { lastReadAt: now, lastDeliveredAt: now },
  });

  const receipt = {
    conversationId: id,
    userId: me.id,
    lastReadAt: now.toISOString(),
  };
  emitToConversation(id, { t: "receipt.update", p: receipt });
  emitToUser(me.id, { t: "receipt.update", p: receipt });

  return NextResponse.json({ ok: true, lastReadAt: receipt.lastReadAt });
}
