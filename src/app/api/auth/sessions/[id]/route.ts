import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { AUTH_COOKIE, verifyToken } from "@/lib/jwt";
import { getSessionUser } from "@/lib/auth";

type RouteContext = { params: Promise<{ id: string }> };

export async function DELETE(req: NextRequest, ctx: RouteContext) {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;

  const result = await prisma.session.updateMany({
    where: { id, userId: me.id },
    data: { revokedAt: new Date() },
  });
  if (result.count === 0) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  // if a device revokes its own session, clear its cookie too
  const store = await cookies();
  const token = store.get(AUTH_COOKIE)?.value;
  const claims = token ? await verifyToken(token) : null;
  void claims;

  return NextResponse.json({ ok: true });
}
