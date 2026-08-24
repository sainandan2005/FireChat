import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { AUTH_COOKIE, verifyToken } from "@/lib/jwt";
import { getSessionUser } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // identify which session is making this request (cookie OR bearer)
  const authHeader = req.headers.get("authorization");
  const bearer = authHeader?.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : null;
  const store = await cookies();
  const rawToken =
    bearer ?? store.get(AUTH_COOKIE)?.value ?? null;
  const claims = rawToken ? await verifyToken(rawToken) : null;

  const sessions = await prisma.session.findMany({
    where: { userId: me.id, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastUsedAt: "desc" },
    select: {
      id: true,
      userAgent: true,
      createdAt: true,
      lastUsedAt: true,
      expiresAt: true,
    },
  });

  return NextResponse.json({
    sessions: sessions.map((s) => ({ ...s, current: s.id === (claims?.sessionId ?? "") })),
  });
}
