import { NextResponse, type NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { emitToConversation, emitToUser } from "@/lib/ws-server";
import { toMessageDTO } from "@/lib/summaries";

type RouteContext = { params: Promise<{ id: string }> };

async function loadContext(req: NextRequest, ctx: RouteContext) {
  const me = await getSessionUser();
  if (!me) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) } as const;
  }
  const { id } = await ctx.params;

  const conversation = await prisma.conversation.findUnique({
    where: { id },
    select: { isGroup: true, participants: { select: { userId: true, role: true } } },
  });
  if (!conversation || !conversation.isGroup) {
    return { error: NextResponse.json({ error: "Group not found" }, { status: 404 }) } as const;
  }

  const meRow = conversation.participants.find((p) => p.userId === me.id);
  if (!meRow) {
    return { error: NextResponse.json({ error: "Not a member" }, { status: 403 }) } as const;
  }

  return { me, id, myRole: meRow.role, participantIds: conversation.participants.map((p) => p.userId) } as const;
}

async function broadcastSystemMessage(conversationId: string, senderId: string, content: string, notifyUserIds: string[]) {
  const system = await prisma.message.create({
    data: { conversationId, senderId, type: "SYSTEM", content },
  });
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { updatedAt: new Date() },
  });
  const dto = toMessageDTO({
    ...system,
    reactions: [],
    replyTo: null,
  });
  emitToConversation(conversationId, { t: "message.new", p: dto });
  for (const userId of notifyUserIds) {
    if (userId !== senderId) {
      emitToUser(userId, { t: "conversation.new-message", p: { conversationId, message: dto } });
    }
  }
  return dto;
}

export async function POST(req: NextRequest, ctx: RouteContext) {
  const ctxResult = await loadContext(req, ctx);
  if ("error" in ctxResult) return ctxResult.error;
  const { me, id, participantIds } = ctxResult;

  let body: { userId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const userId = typeof body.userId === "string" ? body.userId : "";
  if (!userId || userId === me.id) {
    return NextResponse.json({ error: "Invalid user" }, { status: 400 });
  }

  const target = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, username: true } });
  if (!target) return NextResponse.json({ error: "User not found" }, { status: 404 });

  if (participantIds.includes(userId)) {
    return NextResponse.json({ error: "Already a member" }, { status: 409 });
  }

  const meUser = await prisma.user.findUnique({ where: { id: me.id }, select: { username: true } });

  await prisma.participant.create({ data: { conversationId: id, userId, role: "member" } });
  await broadcastSystemMessage(
    id,
    me.id,
    `${meUser?.username ?? me.username} added ${target.username}`,
    [...participantIds, userId]
  );

  // the added member needs the conversation to appear in their sidebar
  emitToUser(userId, { t: "conversation.created", p: { conversationId: id } });

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, ctx: RouteContext) {
  const ctxResult = await loadContext(req, ctx);
  if ("error" in ctxResult) return ctxResult.error;
  const { me, id, myRole, participantIds } = ctxResult;

  let body: { userId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const userId = typeof body.userId === "string" ? body.userId : "";
  if (!userId) return NextResponse.json({ error: "Invalid user" }, { status: 400 });
  if (userId === me.id) {
    return NextResponse.json(
      { error: "Use exit group instead" },
      { status: 400 }
    );
  }
  if (myRole !== "owner") {
    return NextResponse.json({ error: "Only the group owner can remove members" }, { status: 403 });
  }
  if (!participantIds.includes(userId)) {
    return NextResponse.json({ error: "Not a member" }, { status: 404 });
  }

  const target = await prisma.user.findUnique({ where: { id: userId }, select: { username: true } });
  const meUser = await prisma.user.findUnique({ where: { id: me.id }, select: { username: true } });

  await prisma.participant.delete({
    where: { userId_conversationId: { userId, conversationId: id } },
  });
  await broadcastSystemMessage(
    id,
    me.id,
    `${meUser?.username ?? me.username} removed ${target?.username ?? "a member"}`,
    participantIds
  );

  // removed member refreshes their (now absent) sidebar entry
  emitToUser(userId, { t: "conversation.created", p: { conversationId: id } });

  return NextResponse.json({ ok: true });
}
