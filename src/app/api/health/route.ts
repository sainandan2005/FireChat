import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { redisEnabled } from "@/lib/pubsub";

export async function GET() {
  let db = "up";
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    db = "down";
  }

  const body = {
    ok: db === "up",
    uptimeSeconds: Math.round(process.uptime()),
    checks: { db },
    clusterMode: redisEnabled() ? "redis" : "single-node",
  };

  return NextResponse.json(body, { status: body.ok ? 200 : 503 });
}
