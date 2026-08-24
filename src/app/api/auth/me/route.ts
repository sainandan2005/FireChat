import { NextResponse, type NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { toPublicUser } from "@/lib/summaries";

const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ user });
}

export async function PATCH(req: NextRequest) {
  const me = await getSessionUser();
  if (!me) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { username?: unknown; avatarUrl?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const data: { username?: string; avatarUrl?: string | null } = {};

  if (body.username !== undefined) {
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    if (!USERNAME_RE.test(username)) {
      return NextResponse.json(
        { error: "Username must be 3-20 characters (letters, numbers, underscores)" },
        { status: 400 }
      );
    }
    const taken = await prisma.user.findFirst({
      where: { username, id: { not: me.id } },
      select: { id: true },
    });
    if (taken) {
      return NextResponse.json({ error: "That username is already taken" }, { status: 409 });
    }
    data.username = username;
  }

  if (body.avatarUrl !== undefined) {
    data.avatarUrl =
      typeof body.avatarUrl === "string" && body.avatarUrl ? body.avatarUrl : null;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const user = await prisma.user.update({
    where: { id: me.id },
    data,
  });
  return NextResponse.json({ user: toPublicUser(user) });
}
