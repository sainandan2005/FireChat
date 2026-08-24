import { NextResponse, type NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, ctx: RouteContext) {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;

  const member = await prisma.participant.findUnique({
    where: { userId_conversationId: { userId: me.id, conversationId: id } },
    select: { id: true },
  });
  if (!member) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });

  let body: { pinned?: unknown; muted?: unknown; archived?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const data: { pinnedAt?: Date | null; muted?: boolean; archivedAt?: Date | null } = {};
  if (typeof body.pinned === "boolean") data.pinnedAt = body.pinned ? new Date() : null;
  if (typeof body.muted === "boolean") data.muted = body.muted;
  if (typeof body.archived === "boolean") data.archivedAt = body.archived ? new Date() : null;

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  await prisma.participant.update({ where: { id: member.id }, data });
  return NextResponse.json({ ok: true, ...data });
}
