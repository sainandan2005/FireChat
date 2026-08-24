import { NextResponse, type NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const q = (new URL(req.url).searchParams.get("q") ?? "").trim().toLowerCase();
  if (!q) return NextResponse.json({ users: [] });

  const users = await prisma.user.findMany({
    where: {
      AND: [
        { id: { not: me.id } },
        { OR: [{ username: { contains: q } }, { email: { contains: q } }] },
      ],
    },
    select: { id: true, username: true, avatarUrl: true },
    orderBy: { username: "asc" },
    take: 20,
  });

  return NextResponse.json({ users });
}
