import { NextResponse, type NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { signToken, AUTH_COOKIE, TOKEN_TTL_SECONDS } from "@/lib/jwt";
import { toPublicUser } from "@/lib/summaries";
import { checkRateLimit, clientIpFrom } from "@/lib/rate-limit";
import { sessionCookieOptions } from "@/lib/auth";

export async function POST(req: NextRequest) {
  if (!checkRateLimit(`login:${clientIpFrom(req.headers)}`, 10, 60_000)) {
    return NextResponse.json(
      { error: "Too many attempts, try again in a minute" },
      { status: 429 }
    );
  }

  let body: { identifier?: unknown; password?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const identifier =
    typeof body.identifier === "string" ? body.identifier.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!identifier || !password) {
    return NextResponse.json({ error: "Please fill in all fields" }, { status: 400 });
  }

  const user = await prisma.user.findFirst({
    where: { OR: [{ email: identifier }, { username: identifier }] },
  });
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  const session = await prisma.session.create({
    data: {
      userId: user.id,
      userAgent: req.headers.get("user-agent")?.slice(0, 250) ?? null,
      expiresAt: new Date(Date.now() + TOKEN_TTL_SECONDS * 1000),
    },
  });
  const token = await signToken(user.id, session.id);
  const res = NextResponse.json({ user: toPublicUser(user), token });
  res.cookies.set(AUTH_COOKIE, token, sessionCookieOptions());
  return res;
}
