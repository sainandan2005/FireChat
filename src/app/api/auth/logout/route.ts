import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { AUTH_COOKIE, verifyToken } from "@/lib/jwt";
import { getSessionUser } from "@/lib/auth";

function clearCookie(res: NextResponse): void {
  res.cookies.set(AUTH_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 0,
    path: "/",
  });
}

/** Logs out the calling device only. */
export async function POST() {
  const store = await cookies();
  const token = store.get(AUTH_COOKIE)?.value;
  const claims = token ? await verifyToken(token) : null;

  if (claims) {
    await prisma.session.updateMany({
      where: { id: claims.sessionId },
      data: { revokedAt: new Date() },
    });
  }

  const res = NextResponse.json({ ok: true });
  clearCookie(res);
  return res;
}

/** Logs out EVERY device for the caller. */
export async function DELETE() {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  await prisma.session.updateMany({
    where: { userId: me.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  const res = NextResponse.json({ ok: true, loggedOutEverywhere: true });
  clearCookie(res);
  return res;
}
