import { NextResponse, type NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { MESSAGE_INCLUDE_SENDER, toMessageDTO } from "@/lib/summaries";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: RouteContext) {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;

  const member = await prisma.participant.findUnique({
    where: { userId_conversationId: { userId: me.id, conversationId: id } },
    select: { id: true, clearedAt: true },
  });
  if (!member) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });

  const url = new URL(req.url);
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const afterId = url.searchParams.get("afterId") ?? undefined;
  const aroundId = url.searchParams.get("aroundId") ?? undefined;
  // note: Number(null) is 0, not NaN, treat absent param as the default explicitly
  const rawLimit = url.searchParams.get("limit");
  const requestedLimit = rawLimit === null ? 30 : Number(rawLimit);
  const limit = Math.min(
    Math.max(Number.isFinite(requestedLimit) && requestedLimit >= 1 ? Math.trunc(requestedLimit) : 30, 1),
    50
  );

  const visibility = {
    conversationId: id,
    ...(member.clearedAt ? { createdAt: { gt: member.clearedAt } } : {}),
    OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
  };

  if (aroundId) {
    const anchor = await prisma.message.findFirst({
      where: { id: aroundId, ...visibility },
      select: { createdAt: true },
    });
    if (!anchor) return NextResponse.json({ error: "Message not found" }, { status: 404 });

    const half = 8;
    const [older, newer] = await Promise.all([
      prisma.message.findMany({
        where: { ...visibility, createdAt: { lt: anchor.createdAt } },
        orderBy: { createdAt: "desc" },
        take: half,
        include: MESSAGE_INCLUDE_SENDER,
      }),
      prisma.message.findMany({
        where: { ...visibility, createdAt: { gte: anchor.createdAt } },
        orderBy: { createdAt: "asc" },
        take: half + 1,
        include: MESSAGE_INCLUDE_SENDER,
      }),
    ]);
    const merged = [...older.reverse(), ...newer];
    const hasOlder = older.length === half;

    return NextResponse.json({
      messages: merged.map(toMessageDTO),
      hasMore: hasOlder,
      nextCursor: hasOlder && merged.length > 0 ? merged[0].id : null,
    });
  }

  let afterFilter: Record<string, unknown> = {};
  if (afterId) {
    const anchor = await prisma.message.findUnique({
      where: { id: afterId },
      select: { createdAt: true },
    });
    if (!anchor) {
      return NextResponse.json({ error: "Unknown afterId" }, { status: 400 });
    }
    afterFilter = {
      OR: [{ createdAt: { gt: anchor.createdAt } }, { createdAt: anchor.createdAt, id: { gt: afterId } }],
    };
  }

  const rows = await prisma.message.findMany({
    where: { ...visibility, ...afterFilter },
    ...(cursor && !afterId ? { cursor: { id: cursor }, skip: 1 } : {}),
    orderBy: afterId ? [{ createdAt: "asc" }, { id: "asc" }] : { createdAt: "desc" },
    take: afterId ? 100 : limit + 1,
    include: MESSAGE_INCLUDE_SENDER,
  });

  if (afterId) {
    return NextResponse.json({
      messages: rows.map(toMessageDTO),
      hasMore: rows.length === 100,
      nextCursor: null,
    });
  }

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).reverse();

  return NextResponse.json({
    messages: page.map(toMessageDTO),
    hasMore,
    nextCursor: hasMore && page.length > 0 ? page[0].id : null,
  });
}
