import { NextResponse, type NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { emitToUser } from "@/lib/ws-server";
import {
  PUBLIC_USER_SELECT,
  buildConversationSummary,
} from "@/lib/summaries";

export async function GET() {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rows = await prisma.participant.findMany({
    where: { userId: me.id },
    orderBy: { conversation: { updatedAt: "desc" } },
    include: {
      conversation: {
        include: {
          participants: { include: { user: { select: PUBLIC_USER_SELECT } } },
          messages: { orderBy: { createdAt: "desc" }, take: 1, where: { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] } },
        },
      },
    },
  });

  // one round-trip for every conversation's unread count instead of one COUNT each
  const unreadRows = await prisma.$queryRaw<Array<{ conversationId: string; count: number }>>`
    SELECT m."conversationId", COUNT(*)::int AS count
    FROM "Message" m
    JOIN "Participant" p ON p."conversationId" = m."conversationId"
    WHERE p."userId" = ${me.id}
      AND m."senderId" <> ${me.id}
      AND (p."clearedAt" IS NULL OR m."createdAt" > p."clearedAt")
      AND (p."lastReadAt" IS NULL OR m."createdAt" > p."lastReadAt")
      AND (m."expiresAt" IS NULL OR m."expiresAt" > NOW())
    GROUP BY m."conversationId"
  `;
  const unreadMap = new Map(
    unreadRows.map((r) => [r.conversationId, Number(r.count)])
  );

  const summaries = await Promise.all(
    rows.map(async (row) => {
      let conversation = row.conversation;
      if (row.clearedAt) {
        const [lastVisible] = await prisma.message.findMany({
          where: { conversationId: conversation.id, createdAt: { gt: row.clearedAt } },
          orderBy: { createdAt: "desc" },
          take: 1,
        });
        conversation = { ...conversation, messages: lastVisible ? [lastVisible] : [] };
      }
      return buildConversationSummary(conversation, me.id, {
        lastReadAt: row.lastReadAt,
        clearedAt: row.clearedAt,
        pinnedAt: row.pinnedAt,
        muted: row.muted,
        archivedAt: row.archivedAt,
      }, unreadMap.get(conversation.id) ?? 0);
    })
  );

  return NextResponse.json({ conversations: summaries });
}

interface CreateBody {
  type?: unknown;
  userId?: unknown;
  name?: unknown;
  memberIds?: unknown;
}

export async function POST(req: NextRequest) {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: CreateBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (body.type === "dm") {
    const targetId = typeof body.userId === "string" ? body.userId : "";
    if (!targetId || targetId === me.id) {
      return NextResponse.json({ error: "Invalid user" }, { status: 400 });
    }
    const target = await prisma.user.findUnique({ where: { id: targetId }, select: { id: true } });
    if (!target) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const existing = await prisma.conversation.findFirst({
      where: {
        isGroup: false,
        AND: [
          { participants: { some: { userId: me.id } } },
          { participants: { some: { userId: targetId } } },
        ],
      },
      include: {
        participants: { include: { user: { select: PUBLIC_USER_SELECT } } },
        messages: { orderBy: { createdAt: "desc" }, take: 1, where: { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] } },
      },
    });

    const conversation =
      existing && existing.participants.length === 2
        ? existing
        : await prisma.conversation.create({
            data: {
              isGroup: false,
              participants: { create: [{ userId: me.id }, { userId: targetId }] },
            },
            include: {
              participants: { include: { user: { select: PUBLIC_USER_SELECT } } },
              messages: { orderBy: { createdAt: "desc" }, take: 1, where: { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] } },
            },
          });

    const myRow = conversation.participants.find((p) => p.userId === me.id);
    const summary = await buildConversationSummary(conversation, me.id, {
      lastReadAt: myRow?.lastReadAt ?? null,
    });

    emitToUser(targetId, { t: "conversation.created", p: { conversationId: conversation.id } });

    return NextResponse.json({ conversation: summary }, { status: existing ? 200 : 201 });
  }

  if (body.type === "group") {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 50) {
      return NextResponse.json({ error: "Group name must be 1-50 characters" }, { status: 400 });
    }

    const rawIds = Array.isArray(body.memberIds) ? body.memberIds : [];
    const memberIds = Array.from(
      new Set(rawIds.filter((id): id is string => typeof id === "string"))
    ).filter((id) => id !== me.id);

    if (memberIds.length < 1) {
      return NextResponse.json(
        { error: "Select at least one member for the group" },
        { status: 400 }
      );
    }
    if (memberIds.length > 49) {
      return NextResponse.json({ error: "Groups are limited to 50 members" }, { status: 400 });
    }

    const users = await prisma.user.findMany({
      where: { id: { in: memberIds } },
      select: { id: true },
    });
    if (users.length !== memberIds.length) {
      return NextResponse.json({ error: "One or more users not found" }, { status: 404 });
    }

    const conversation = await prisma.conversation.create({
      data: {
        isGroup: true,
        name,
        participants: {
          create: [
            { userId: me.id, role: "owner" },
            ...memberIds.map((id) => ({ userId: id })),
          ],
        },
      },
      include: {
        participants: { include: { user: { select: PUBLIC_USER_SELECT } } },
        messages: { orderBy: { createdAt: "desc" }, take: 1, where: { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] } },
      },
    });

    const myRow = conversation.participants.find((p) => p.userId === me.id);
    const summary = await buildConversationSummary(conversation, me.id, {
      lastReadAt: myRow?.lastReadAt ?? null,
    });

    for (const memberId of memberIds) {
      emitToUser(memberId, { t: "conversation.created", p: { conversationId: conversation.id } });
    }

    return NextResponse.json({ conversation: summary }, { status: 201 });
  }

  return NextResponse.json({ error: "Invalid conversation type" }, { status: 400 });
}
