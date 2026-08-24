import { NextResponse, type NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { signToken, AUTH_COOKIE, TOKEN_TTL_SECONDS } from "@/lib/jwt";
import { toPublicUser } from "@/lib/summaries";
import { checkRateLimit, clientIpFrom } from "@/lib/rate-limit";
import { sessionCookieOptions } from "@/lib/auth";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

export async function POST(req: NextRequest) {
  if (!checkRateLimit(`register:${clientIpFrom(req.headers)}`, 5, 60_000)) {
    return NextResponse.json(
      { error: "Too many attempts, try again in a minute" },
      { status: 429 }
    );
  }

  let body: { email?: unknown; username?: unknown; password?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "Please enter a valid email address" }, { status: 400 });
  }
  if (!USERNAME_RE.test(username)) {
    return NextResponse.json(
      { error: "Username must be 3-20 characters (letters, numbers, underscores)" },
      { status: 400 }
    );
  }
  if (password.length < 8 || password.length > 100) {
    return NextResponse.json({ error: "Password must be 8-100 characters" }, { status: 400 });
  }

  const existing = await prisma.user.findFirst({
    where: { OR: [{ email }, { username }] },
    select: { email: true, username: true },
  });
  if (existing) {
    const conflict = existing.email === email ? "email" : "username";
    return NextResponse.json({ error: `That ${conflict} is already taken` }, { status: 409 });
  }

  const user = await prisma.user.create({
    data: {
      email,
      username,
      passwordHash: await bcrypt.hash(password, 10),
    },
  });

  const session = await prisma.session.create({
    data: {
      userId: user.id,
      userAgent: req.headers.get("user-agent")?.slice(0, 250) ?? null,
      expiresAt: new Date(Date.now() + TOKEN_TTL_SECONDS * 1000),
    },
  });
  const token = await signToken(user.id, session.id);
  const res = NextResponse.json({ user: toPublicUser(user), token }, { status: 201 });
  res.cookies.set(AUTH_COOKIE, token, sessionCookieOptions());
  return res;
}
