import { NextResponse, type NextRequest } from "next/server";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { getSessionUser } from "@/lib/auth";
import { UPLOADS_DIR, mimeFromExtension } from "@/lib/uploads";
import { getObject, s3Enabled, objectKeyFor } from "@/lib/storage";

type RouteContext = { params: Promise<{ path: string[] }> };

export async function GET(req: NextRequest, ctx: RouteContext) {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { path: segments } = await ctx.params;
  if (!segments || segments.length === 0 || segments.length > 4) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (segments.some((s) => s === "." || s === ".." || s.includes("/") || s.includes("\\"))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // S3 keys are "<yyyy>/<mm>/<storedName>", mirror the segment shape
  const storedName = segments[segments.length - 1];
  const ext = path.extname(storedName).replace(".", "").toLowerCase();
  if (!/^[a-z0-9-]{36}\.(png|jpg|jpeg|gif|webp|pdf|txt|csv|zip|mp3|weba|ogg|mp4|webm)$/i.test(storedName)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (s3Enabled) {
    try {
      const object = segments.length >= 3
        ? await getObject(segments.join("/"))
        : await getObject(objectKeyFor(storedName));
      if (!object) return NextResponse.json({ error: "Not found" }, { status: 404 });

      return new Response(new Uint8Array(object.body), {
        headers: {
          "Content-Type": mimeFromExtension(ext),
          "Content-Length": String(object.size),
          "Cache-Control": "private, max-age=31536000, immutable",
        },
      });
    } catch (err) {
      console.error("[storage] get failed:", (err as Error).message);
      return NextResponse.json({ error: "Storage error" }, { status: 500 });
    }
  }

  const target = path.resolve(UPLOADS_DIR, ...segments);
  if (!target.startsWith(UPLOADS_DIR + path.sep)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const info = await stat(target);
    if (!info.isFile()) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const data = await readFile(target);
    return new Response(new Uint8Array(data), {
      headers: {
        "Content-Type": mimeFromExtension(ext),
        "Content-Length": String(info.size),
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
