import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getSessionUser } from "@/lib/auth";
import { UPLOADS_DIR } from "@/lib/uploads";
import { putObject, s3Enabled } from "@/lib/storage";

const MAX_FILE_SIZE = 10 * 1024 * 1024;

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/csv": "csv",
  "application/zip": "zip",
  "audio/mpeg": "mp3",
  "audio/webm": "weba",
  "audio/ogg": "ogg",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

export async function POST(req: NextRequest) {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid multipart body" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: "File is empty" }, { status: 400 });
  }
  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json({ error: "File exceeds the 10 MB limit" }, { status: 413 });
  }

  // MediaRecorder mints types like "audio/webm;codecs=opus", strip parameters
  const normalizedMime = file.type.split(";")[0].trim();
  const ext = MIME_TO_EXT[normalizedMime];
  if (!ext) {
    return NextResponse.json(
      { error: "Unsupported file type. Allowed: images, PDF, text, CSV, ZIP, MP3, MP4" },
      { status: 415 }
    );
  }

  const storedName = `${randomUUID()}.${ext}`;
  const buffer = Buffer.from(await file.arrayBuffer());

  if (s3Enabled) {
    await putObject(storedName, buffer, normalizedMime);
  } else {
    await mkdir(UPLOADS_DIR, { recursive: true });
    await writeFile(
      path.join(/* turbopackIgnore: true */ UPLOADS_DIR, storedName),
      buffer
    );
  }

  const displayName =
    file.name
      .replace(/[/\\]/g, "")
      .slice(0, 120) || `file.${ext}`;

  return NextResponse.json({
    url: `/api/files/${storedName}`,
    fileName: displayName,
    fileSize: file.size,
    mimeType: normalizedMime,
  });
}
