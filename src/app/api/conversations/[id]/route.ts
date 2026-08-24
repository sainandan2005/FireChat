import { NextResponse, type NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { emitToConversation, emitToUser } from "@/lib/ws-server";
import {
  PUBLIC_USER_SELECT,
  buildConversationDetail,
  toMessageDTO,
} from "@/lib/summaries";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: RouteContext) {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;

  const row = await prisma.participant.findUnique({
    where: { userId_conversationId: { userId: me.id, conversationId: id } },
    include: {
      conversation: {
        include: {
          participants: { include: { user: { select: PUBLIC_USER_SELECT } } },
          messages: {
            orderBy: { createdAt: "desc" },
            take: 1,
            where: { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
          },
        },
      },
    },
  });
  if (!row) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });

  let conversation = row.conversation;
  if (row.clearedAt) {
    const [lastVisible] = await prisma.message.findMany({
      where: {
        conversationId: id,
        createdAt: { gt: row.clearedAt },
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: { createdAt: "desc" },
      take: 1,
    });
    conversation = { ...conversation, messages: lastVisible ? [lastVisible] : [] };
  }

  const unreadCount = await prisma.message.count({
    where: {
      conversationId: id,
      senderId: { not: me.id },
      ...(row.lastReadAt && (!row.clearedAt || row.lastReadAt > row.clearedAt)
        ? { createdAt: { gt: row.lastReadAt } }
        : row.clearedAt
          ? { createdAt: { gt: row.clearedAt } }
          : {}),
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
  });

  const detail = buildConversationDetail(
    conversation,
    me.id,
    {
      lastReadAt: row.lastReadAt,
      clearedAt: row.clearedAt,
      pinnedAt: row.pinnedAt,
      muted: row.muted,
      archivedAt: row.archivedAt,
    },
    unreadCount,
    row.role
  );
  return NextResponse.json({ conversation: detail });
}

const NAME_MAX_LENGTH = 50;
const DISAPPEARING_OPTIONS = new Set([0, 3600, 86_400, 604_800, 2_592_000]);

export async function PATCH(req: NextRequest, ctx: RouteContext) {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;

  const member = await prisma.participant.findUnique({
    where: { userId_conversationId: { userId: me.id, conversationId: id } },
    select: { id: true, role: true },
  });
  if (!member) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });

  let body: { name?: unknown; disappearingSeconds?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const conversation = await prisma.conversation.findUnique({
    where: { id },
    select: { isGroup: true, disappearingSeconds: true },
  });
  if (!conversation) {
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
  }

  let systemText: string | null = null;

  if (body.name !== undefined) {
    if (!conversation.isGroup) {
      return NextResponse.json({ error: "Only groups can be renamed" }, { status: 400 });
    }
    if (member.role !== "owner") {
      return NextResponse.json({ error: "Only the group owner can rename" }, { status: 403 });
    }
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > NAME_MAX_LENGTH) {
      return NextResponse.json(
        { error: `Group name must be 1-${NAME_MAX_LENGTH} characters` },
        { status: 400 }
      );
    }
    await prisma.conversation.update({ where: { id }, data: { name } });
    return NextResponse.json({ ok: true, name });
  }

  if (body.disappearingSeconds !== undefined) {
    const seconds =
      typeof body.disappearingSeconds === "number" && Number.isInteger(body.disappearingSeconds)
        ? body.disappearingSeconds
        : -1;
    if (!DISAPPEARING_OPTIONS.has(seconds)) {
      return NextResponse.json(
        { error: "disappearingSeconds must be one of 0, 3600, 86400, 604800, 2592000" },
        { status: 400 }
      );
    }
    if (conversation.isGroup && member.role !== "owner") {
      return NextResponse.json(
        { error: "Only the group owner can change disappearing messages" },
        { status: 403 }
      );
    }

    const value = seconds === 0 ? null : seconds;
    await prisma.conversation.update({ where: { id }, data: { disappearingSeconds: value } });
    const label =
      value === null
        ? "off"
        : value === 3600
          ? "1 hour"
          : value === 86_400
            ? "1 day"
            : value === 604_800
              ? "1 week"
              : "30 days";
    systemText = `${me.username} set disappearing messages to ${label}`;

    const system = await prisma.message.create({
      data: { conversationId: id, senderId: me.id, type: "SYSTEM", content: systemText },
    });
    emitToConversation(id, {
      t: "message.new",
      p: toMessageDTO({ ...system, reactions: [], replyTo: null }),
    });

    return NextResponse.json({ ok: true, disappearingSeconds: value });
  }

  return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
}

export async function DELETE(req: NextRequest, ctx: RouteContext) {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;

  const row = await prisma.participant.findUnique({
    where: { userId_conversationId: { userId: me.id, conversationId: id } },
    include: {
      conversation: {
        include: { participants: { select: { userId: true } } },
      },
    },
  });
  if (!row) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });

  if (row.conversation.isGroup) {
    // exit group: remove membership and leave a system message behind
    await prisma.participant.delete({ where: { id: row.id } });

    const system = await prisma.message.create({
      data: {
        conversationId: id,
        senderId: me.id,
        type: "SYSTEM",
        content: `${me.username} left`,
      },
    });

    await prisma.conversation.update({
      where: { id },
      data: { updatedAt: new Date() },
    });

    const dto = {
      ...system,
      createdAt: system.createdAt.toISOString(),
    };
    emitToConversation(id, { t: "message.new", p: dto });
    for (const p of row.conversation.participants) {
      if (p.userId !== me.id) {
        emitToUser(p.userId, { t: "conversation.new-message", p: { conversationId: id, message: dto } });
      }
    }
    // also notify the leaver's other devices so their sidebar refreshes
    emitToUser(me.id, { t: "conversation.created", p: { conversationId: id } });

    return NextResponse.json({ ok: true, action: "left" });
  }

  // DM: "delete chat", hide all history for me only; the peer keeps everything
  await prisma.participant.update({
    where: { id: row.id },
    data: { clearedAt: new Date() },
  });

  return NextResponse.json({ ok: true, action: "cleared" });
}
