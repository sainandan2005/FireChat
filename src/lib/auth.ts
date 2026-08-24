import { cookies, headers } from "next/headers";
import { prisma } from "./prisma";
import { AUTH_COOKIE, TOKEN_TTL_SECONDS, verifyToken } from "./jwt";
import type { PublicUser } from "./types";

/**
 * Resolves the authenticated user from either:
 * - the httpOnly session cookie (browser flow), or
 * - an `Authorization: Bearer <jwt>` header (scripts / non-browser clients).
 *
 * The JWT carries a session id (jti) that must match a live (non-revoked,
 * non-expired) Session row, revoking a row kills that device everywhere.
 */
export async function getSessionUser(): Promise<PublicUser | null> {
  let token: string | null = null;

  const headerList = await headers();
  const authorization = headerList.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    token = authorization.slice("Bearer ".length).trim();
  }

  if (!token) {
    const store = await cookies();
    token = store.get(AUTH_COOKIE)?.value ?? null;
  }

  if (!token) return null;

  const claims = await verifyToken(token);
  if (!claims) return null;

  // throttled touch: only bump lastUsedAt at most once per minute per session
  const now = new Date();
  const session = await prisma.session.findUnique({
    where: { id: claims.sessionId },
    select: { userId: true, expiresAt: true, revokedAt: true, lastUsedAt: true },
  });
  if (!session || session.revokedAt || session.expiresAt <= now) return null;
  if (session.userId !== claims.userId) return null;

  void prisma.session
    .updateMany({
      where: { id: claims.sessionId, lastUsedAt: { lt: new Date(now.getTime() - 60_000) } },
      data: { lastUsedAt: now },
    })
    .catch(() => {});

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { id: true, username: true, avatarUrl: true, lastSeenAt: true },
  });
  if (!user) return null;

  return {
    id: user.id,
    username: user.username,
    avatarUrl: user.avatarUrl,
    lastSeenAt: user.lastSeenAt ? user.lastSeenAt.toISOString() : null,
  };
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    maxAge: TOKEN_TTL_SECONDS,
    path: "/",
  };
}
