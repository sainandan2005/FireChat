import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";

/**
 * Media storage abstraction.
 *
 * When S3_* env vars are present, files go to any S3-compatible bucket
 * (MinIO in docker-compose, AWS S3 / R2 / B2 in production). Otherwise a
 * local `uploads/` directory is used, zero-config for development.
 */

const endpoint = process.env.S3_ENDPOINT;
const bucket = process.env.S3_BUCKET;
const accessKeyId = process.env.S3_ACCESS_KEY_ID;
const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;

export const s3Enabled = Boolean(endpoint && bucket && accessKeyId && secretAccessKey);

let client: S3Client | null = null;

function s3(): S3Client {
  if (!client) {
    client = new S3Client({
      endpoint,
      region: process.env.S3_REGION ?? "us-east-1",
      forcePathStyle: true, // required for MinIO
      credentials: { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey! },
    });
  }
  return client;
}

export function objectKeyFor(storedName: string): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${yyyy}/${mm}/${storedName}`;
}

export async function putObject(storedName: string, body: Buffer, mimeType: string): Promise<string> {
  if (!s3Enabled) throw new Error("S3 storage is not configured");

  const key = objectKeyFor(storedName);
  await s3().send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: mimeType })
  );
  return key;
}

export async function getObject(key: string): Promise<{ body: Uint8Array; size: number } | null> {
  if (!s3Enabled) return null;
  try {
    const result = await s3().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const bytes = await result.Body?.transformToByteArray();
    if (!bytes) return null;
    return { body: bytes, size: bytes.byteLength };
  } catch (err) {
    if ((err as { name?: string }).name === "NoSuchKey") return null;
    throw err;
  }
}

/** Generates a collision-proof stored filename. */
