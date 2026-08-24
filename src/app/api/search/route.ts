import { NextResponse, type NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { toMessageDTO } from "@/lib/summaries";

const MAX_RESULTS = 30;

export async function GET(req: NextRequest) {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const params = new URL(req.url).searchParams;
  const q = (params.get("q") ?? "").trim();
  const conversationId = params.get("conversationId");
  if (q.length < 2) return NextResponse.json({ results: [] });

  // restrict to conversations where the caller is a member,
  // hiding anything older than that member's clearedAt
  const memberships = await prisma.participant.findMany({
    where: { userId: me.id },
    select: { conversationId: true, clearedAt: true },
  });
  const candidates = memberships.filter(
    (m) => !conversationId || m.conversationId === conversationId
  );
  if (candidates.length === 0) return NextResponse.json({ results: [] });

  const rows = await prisma.message.findMany({
    where: {
      deletedAt: null,
      type: "TEXT",
      content: { contains: q, mode: "insensitive" },
      AND: [
        { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        {
          OR: candidates.map((m) => ({
            conversationId: m.conversationId,
            ...(m.clearedAt ? { createdAt: { gt: m.clearedAt } } : {}),
          })),
        },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: MAX_RESULTS,
    include: { sender: { select: { username: true } } },
  });

  return NextResponse.json({
    results: rows.map((row) => ({
      conversationId: row.conversationId,
      message: toMessageDTO(row),
    })),
  });
}
