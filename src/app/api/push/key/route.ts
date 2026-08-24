import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getVapidPublicKey } from "@/lib/push-server";

export async function GET() {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const publicKey = getVapidPublicKey();
  if (!publicKey) {
    return NextResponse.json({ error: "Push is not configured on this server" }, { status: 501 });
  }
  return NextResponse.json({ publicKey });
}
