import "dotenv/config";
import { deflateSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";
import { PrismaClient } from "../src/generated/prisma/client";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const minsAgo = (m: number) => new Date(Date.now() - m * 60_000);
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);

/* ── minimal PNG encoder (truecolor, no filtering) ── */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function makePng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number]
): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3));
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A little "design mockup": indigo gradient, sidebar strip, cards. */
function designMockupPng(): Buffer {
  const w = 800;
  const h = 500;
  return makePng(w, h, (x, y) => {
    // background gradient
    const t = (x / w + y / h) / 2;
    let r = Math.round(30 + t * 30);
    let g = Math.round(33 + t * 26);
    let b = Math.round(58 + t * 40);
    // sidebar strip
    if (x < 140) {
      r = 22; g = 24; b = 40;
      if (x > 16 && x < 124 && y > 24 && y < 64) { r = 88; g = 101; b = 242; } // brand block
      if (x > 16 && x < 124 && [90, 140, 190, 240, 290].some((yy) => y > yy && y < yy + 26)) {
        r = 42; g = 46; b = 74;
      }
      return [r, g, b];
    }
    // two "cards"
    const inCard = (cx: number, cy: number, cw: number, ch: number) =>
      x > cx && x < cx + cw && y > cy && y < cy + ch;
    if (inCard(180, 60, 270, 180)) { r = 40; g = 46; b = 78; }
    else if (inCard(470, 60, 290, 180)) { r = 88; g = 101; b = 242; }
    else if (inCard(180, 270, 580, 190)) { r = 36; g = 41; b = 70; }
    // accent bar on big card
    if (inCard(210, 300, 200, 14)) { r = 255; g = 122; b = 31; }
    return [r, g, b];
  });
}

async function main() {
  const passwordHash = await bcrypt.hash("password123", 10);

  const [alice, bob, carol] = await Promise.all([
    prisma.user.upsert({
      where: { email: "alice@firechat.dev" },
      update: { passwordHash },
      create: { email: "alice@firechat.dev", username: "alice", passwordHash },
    }),
    prisma.user.upsert({
      where: { email: "bob@firechat.dev" },
      update: { passwordHash },
      create: { email: "bob@firechat.dev", username: "bob", passwordHash },
    }),
    prisma.user.upsert({
      where: { email: "carol@firechat.dev" },
      update: { passwordHash },
      create: { email: "carol@firechat.dev", username: "carol", passwordHash },
    }),
  ]);

  // ── image file for the photo bubble ──
  const uploadsDir = path.join(process.cwd(), "uploads");
  await mkdir(uploadsDir, { recursive: true });
  const imageName = `${randomUUID()}.png`;
  await writeFile(path.join(uploadsDir, imageName), designMockupPng());
  const imageUrl = `/api/files/${imageName}`;

  // ── DM: alice ↔ bob ──────────────────────────────────────────────
  const dm = await prisma.conversation.create({
    data: { isGroup: false, participants: { create: [{ userId: alice.id }, { userId: bob.id }] } },
  });

  await prisma.message.create({
    data: { conversationId: dm.id, senderId: bob.id, content: "yo, did you catch the design review yesterday?", createdAt: daysAgo(1) },
  });
  await prisma.message.create({
    data: { conversationId: dm.id, senderId: alice.id, content: "yeah, the new palette is a big upgrade", createdAt: daysAgo(1) },
  });
  await prisma.message.create({
    data: { conversationId: dm.id, senderId: bob.id, content: "the indigo surfaces read so much better than the old flat gray", createdAt: minsAgo(48) },
  });
  await prisma.message.create({
    data: { conversationId: dm.id, senderId: alice.id, content: "and the hairlines. everything feels lighter somehow", createdAt: minsAgo(46) },
  });
  const m5 = await prisma.message.create({
    data: { conversationId: dm.id, senderId: bob.id, content: "shipping it today?", createdAt: minsAgo(12) },
  });
  const m6 = await prisma.message.create({
    data: {
      conversationId: dm.id,
      senderId: alice.id,
      content: "shipping it right now 🚀",
      createdAt: minsAgo(10),
      replyToId: m5.id,
    },
  });
  await prisma.reaction.create({
    data: { messageId: m6.id, userId: bob.id, emoji: "🔥" },
  });
  await prisma.message.create({
    data: {
      conversationId: dm.id,
      senderId: bob.id,
      type: "IMAGE",
      fileUrl: imageUrl,
      fileName: "final-design.png",
      fileSize: 48_210,
      mimeType: "image/png",
      createdAt: minsAgo(8),
    },
  });

  await prisma.participant.update({
    where: { userId_conversationId: { userId: bob.id, conversationId: dm.id } },
    data: { lastReadAt: minsAgo(7), lastDeliveredAt: minsAgo(9) },
  });
  await prisma.participant.update({
    where: { userId_conversationId: { userId: alice.id, conversationId: dm.id } },
    data: { lastReadAt: minsAgo(47), lastDeliveredAt: minsAgo(47) },
  });

  // ── DM: alice ↔ carol ────────────────────────────────────────────
  const dm2 = await prisma.conversation.create({
    data: { isGroup: false, participants: { create: [{ userId: alice.id }, { userId: carol.id }] } },
  });
  await prisma.message.create({
    data: { conversationId: dm2.id, senderId: carol.id, content: "that call earlier was crystal clear btw", createdAt: hoursAgo(5) },
  });
  await prisma.message.create({
    data: { conversationId: dm2.id, senderId: alice.id, content: "right? webrtc doing its job", createdAt: hoursAgo(5) },
  });
  for (const u of [alice.id, carol.id]) {
    await prisma.participant.update({
      where: { userId_conversationId: { userId: u, conversationId: dm2.id } },
      data: { lastReadAt: hoursAgo(4), lastDeliveredAt: hoursAgo(5) },
    });
  }

  // ── Group: Design Crew ───────────────────────────────────────────
  const group = await prisma.conversation.create({
    data: {
      isGroup: true,
      name: "Design Crew",
      participants: {
        create: [
          { userId: alice.id, role: "owner" },
          { userId: bob.id },
          { userId: carol.id },
        ],
      },
    },
  });
  await prisma.message.create({
    data: { conversationId: group.id, senderId: alice.id, content: "kickoff, new palette is live on staging", createdAt: hoursAgo(26) },
  });
  await prisma.message.create({
    data: { conversationId: group.id, senderId: bob.id, content: "pulling it now", createdAt: hoursAgo(25) },
  });
  await prisma.message.create({
    data: { conversationId: group.id, senderId: carol.id, content: "dark mode contrast is spot on 👌", createdAt: hoursAgo(3) },
  });

  await prisma.conversation.update({ where: { id: dm.id }, data: { updatedAt: minsAgo(8) } });
  await prisma.conversation.update({ where: { id: dm2.id }, data: { updatedAt: hoursAgo(4) } });
  await prisma.conversation.update({ where: { id: group.id }, data: { updatedAt: minsAgo(90) } });

  console.log("Seeded: alice / bob / carol (password123), DM with reply + reaction + photo, DM with carol, group Design Crew");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
