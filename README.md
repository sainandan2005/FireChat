# FireChat 🔥

A WhatsApp-style real-time messenger built to demonstrate **realtime-systems engineering end to end**. Next.js 16 on the surface; underneath, every layer that most projects delegate to a library is implemented by hand: a custom WebSocket protocol with heartbeats and ack-correlated requests, WebRTC call signaling, Redis multi-node fan-out, revocable sessions, and a 108-assertion test suite that treats the server as a hostile environment.

> The interesting part is not the feature list. It is `src/lib/ws-server.ts` and `src/lib/ws-client.ts`, where everything Socket.IO usually hides is written out in the open.

## Screenshots

| Light | Dark |
| --- | --- |
| ![Conversation (light)](screenshots/chat-light.png) | ![Conversation (dark)](screenshots/chat-dark.png) |

More in `screenshots/`: `login-light.png`, `login-dark.png`, `app.png`, `app-dark.png`.

## What this project demonstrates

| Skill | Implementation | Code |
| --- | --- | --- |
| **Protocol design** | Hand-rolled JSON envelope protocol (`{ t, p, c }`) over native WebSockets: correlated request/ack pairs, generic error frames, per-event handlers, 64 KB signal caps | `src/lib/ws-server.ts`, `src/lib/ws-client.ts` |
| **Connection lifecycle** | Upgrade-time JWT auth, room registry, ping/pong heartbeats with dead-client termination, exponential-backoff reconnect with jitter, automatic room re-subscribe | `ws-server.ts`, `ws-client.ts` |
| **WebRTC** | Peer-to-peer voice/video calls with custom signaling relayed over the WS layer: ringing, accept/decline, ICE trickle, lazy callee peer construction, ring timeouts | `src/lib/webrtc.ts`, `call.*` handlers |
| **Multi-node scaling** | Optional Redis pub/sub fan-out with origin-node dedupe. A dedicated script asserts cross-node delivery between two live app instances | `src/lib/pubsub.ts`, `scripts/multinode-check.mjs` |
| **Reconnect engineering** | Missed messages backfilled via `?afterId=` keyset queries on socket reopen; sidebar re-syncs; delivery receipts re-marked | `ChatPanel.tsx`, messages route |
| **SQL craft** | Unread badges for all conversations in one round-trip (`GREATEST`/`COALESCE` over participant thresholds), `pg_trgm` GIN index for substring search, keyset pagination | `src/lib/summaries.ts`, `prisma/migrations/` |
| **Auth & session security** | JWTs carrying a DB-backed session id (`jti`), per-device revocation, logout-everywhere, instant rejection on REST and WS handshakes alike | `src/lib/jwt.ts`, `src/lib/auth.ts`, `src/proxy.ts` |
| **Testing culture** | 108-assertion smoke suite (API + raw WS), a two-node delivery proof, and Playwright E2E driving two real browsers, including a full WebRTC call on fake media devices | `scripts/smoke.mjs`, `scripts/multinode-check.mjs`, `tests/e2e/` |
| **Ops** | Multi-stage Dockerfile (non-root), compose with health-gated services and an optional scale profile, GitHub Actions CI that boots the prod server and runs the whole suite | `Dockerfile`, `docker-compose.yml`, `.github/workflows/ci.yml` |

## Features

- **Real-time messaging**. Per-conversation rooms, ack-correlated sends, cursor-paginated history, reconnect gap-fill
- **Direct messages and group chats**. Deduplicated DMs; named groups with owner-side member management
- **Reply-to, reactions, edit and delete-for-everyone**. Tombstones are redacted everywhere, including search
- **Presence, typing indicators, last-seen, delivery and read ticks**
- **Voice messages and file sharing**. 10 MB uploads with MIME allowlist, image lightbox, inline audio player
- **Disappearing messages**. Per-conversation timers; expired content vanishes from history, search and unread counts
- **Voice and video calls**. Ringing, accept/decline, mute/camera toggles, call timer
- **Web Push notifications**. VAPID plus service worker; offline participants get native notifications
- **Message search**. Global and per-chat, with jump-to-message that loads the surrounding history window
- **Pin, mute and archive** chats; live chat-list ordering; unread badges
- **Device sessions**. Per-device logout, logout-everywhere, session list
- **Profiles and avatars**, group management, delete-chat semantics that match WhatsApp (the peer keeps their copy)
- **Light and dark themes**. Cream editorial light mode, warm charcoal dark mode; persisted, system-aware, no flash on load

## Tech stack

| Layer | Choice |
| --- | --- |
| Frontend | Next.js 16 (App Router), React 19, Tailwind CSS v4, SWR |
| Realtime | Raw WebSockets (`ws`) with a custom JSON envelope protocol |
| Calls | WebRTC (STUN, trickle ICE) signaled over the WS layer |
| Database | PostgreSQL 17 via Docker + Prisma 7 (driver adapters) |
| Auth | jose (JWT HS256) + bcryptjs, DB-backed revocable sessions |
| Scale-out | Redis pub/sub fan-out (optional), S3-compatible media (optional) |

## Getting started

### 1. Start PostgreSQL

```powershell
docker run -d --name firechat-db --restart unless-stopped `
  -e POSTGRES_USER=firechat -e POSTGRES_PASSWORD=firechat -e POSTGRES_DB=firechat `
  -p 5432:5432 -v firechat_pgdata:/var/lib/postgresql/data postgres:17-alpine
```

> Port **5432** is the Docker mapping. If a locally-installed PostgreSQL service occupies it, stop the service first or change both the `-p` flag and `DATABASE_URL`.

### 2. Environment

Copy `.env.example` to `.env`:

```ini
DATABASE_URL="postgresql://firechat:firechat@localhost:5432/firechat?schema=public"
JWT_SECRET="<openssl rand -hex 32>"
PORT=3000
```

Optional: `REDIS_URL` (multi-node), `WEB_PUSH_PUBLIC_KEY`/`WEB_PUSH_PRIVATE_KEY` (push), `S3_*` (media storage).

### 3. Install, migrate, seed

```bash
npm install
npx prisma migrate dev     # apply schema
npx prisma db seed         # demo users + conversations
```

### 4. Run

```bash
npm run dev                # http://localhost:3000
```

The custom server (`server/index.ts`) serves Next.js and the WebSocket endpoint (`/api/ws`) from one process.

### Demo accounts

Seeded users (password: `password123`):

| Username | Email              |
| -------- | ------------------ |
| alice    | alice@firechat.dev |
| bob      | bob@firechat.dev   |
| carol    | carol@firechat.dev |

Open two browsers (or a normal + incognito window), sign in as two different users, and watch messages, typing, presence, ticks and reactions sync live.

## Testing

Three layers, all runnable locally:

| Suite | Command | What it covers |
| --- | --- | --- |
| Smoke (API + realtime) | `node scripts/smoke.mjs` | 108 assertions: auth, messaging, groups, reactions, files, search, call signaling, sessions, rate limits, access control |
| Multi-node proof | `node scripts/multinode-check.mjs` | Cross-node delivery through the Redis fan-out with two app instances |
| Browser E2E | `npm run test:e2e` | Playwright driving two real Chromium contexts: register/logout/login UI flows, live cross-browser messaging, reactions sync, and a full WebRTC voice call using fake media devices |

CI runs all of them on every push/PR (`.github/workflows/ci.yml`): Postgres service, then migrations + seed, lint, typecheck, build, boots the production server, waits for `/api/health`, then the smoke suite.

## WebSocket architecture

Everything Socket.IO normally provides is implemented by hand, deliberately:

**Protocol.** Every frame is a JSON envelope `{ t: type, p: payload, c?: correlationId }`. Requests that need a reply carry `c`; the server answers with a generic `ack` echoing it. Highlights:

| Client → Server | Payload | Notes |
| --- | --- | --- |
| `message.send` | message fields, optional `replyToId` + `c` | persisted, broadcast, pushed to offline users, acked |
| `message.edit` / `message.delete` | `{ messageId, ... }` + `c` | own messages only; deletes redact content |
| `reaction.toggle` | `{ messageId, emoji }` + `c` | add/remove own reaction, broadcast |
| `typing.start/stop` | `{ conversationId }` | server auto-expires after 5 s |
| `receipt.markDelivered` / `receipt.markRead` | `{ conversationId }` | flips senders' ticks / updates `lastReadAt` |
| `call.ring` / `call.accept` / `call.signal` / `call.end` | signaling payloads + `c` | validates a shared DM, relays, 64 KB signal cap |

Server → Client: `ready`, `presence.list`, `presence.update`, `message.new`, `message.updated`, `message.deleted`, `reaction.updated`, `delivery.update`, `conversation.new-message`, `conversation.created`, `typing.update`, `receipt.update`, `call.incoming/accepted/signal/ended`, `ack`, `error`.

**Server** (`src/lib/ws-server.ts`): upgrade-time JWT auth (httpOnly cookie *or* `?token=` for non-browser clients; non-matching upgrades are left untouched so Next's HMR keeps working), connection registry + room map, 30 s ping/pong heartbeats with dead-client termination, typing auto-expiry, disappearing-message sweeper.

**Client** (`src/lib/ws-client.ts`): exponential-backoff reconnect with jitter (500 ms to 30 s), pending-ack correlation with timeouts, automatic room re-join after reconnect, typed subscriptions returning unsubscribe functions.

**Design decisions worth reading about:**

- **Read receipts** use one `lastReadAt` per participant instead of per-message rows: a message counts as seen for anyone whose timestamp is newer. Scales to large groups without row explosion.
- **Auth duality**: browsers rely on the httpOnly cookie riding the WS handshake; scripts authenticate with `Authorization: Bearer` (REST) and `?token=` (WS). Login/register responses include the token for exactly this purpose.
- **Reconnect gap-fill**: on reopen the client fetches `?afterId=<lastSeenId>`, so nothing sent during the outage is lost.

## Security

- bcrypt password hashing; JWTs (HS256) carry a DB-backed session id (`jti`); revocation is instant on REST and WS
- httpOnly SameSite=Lax cookies for browsers; Bearer tokens for scripts
- Security headers via the proxy: CSP, X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy (camera/mic self)
- Rate limits: login 10/min/IP, register 5/min/IP, messages 30/10 s/user
- Uploads: MIME allowlist + 10 MB cap; served only behind authentication; object keys are server-generated UUIDs in date folders

## Performance

- Unread badges for all conversations in a **single SQL round-trip** (`GREATEST`/`COALESCE` over participant thresholds)
- Message search backed by a **pg_trgm GIN index**, so ILIKE uses bitmap index scans; upgrade path to `tsvector` full-text when ranking matters
- Hot paths indexed: `(conversationId, createdAt)` on messages, unique lookup indexes on participants/reactions/subscriptions

## Deployment

### Docker (recommended)

```bash
JWT_SECRET=$(openssl rand -hex 32) docker compose up --build -d
```

PostgreSQL 17 + Redis + MinIO + the app on port 3000. Migrations run at container start; uploads and DB persist in named volumes. `docker compose --profile scale up -d` adds a second app node on :3001.

### Manual

Any long-running Node host (Railway, Render, Fly.io, VPS), not serverless-only platforms, since WebSockets need a persistent process. Behind proxies, forward `Upgrade`/`Connection` headers for `/api/ws`. Set `DATABASE_URL`, `JWT_SECRET`, `NODE_ENV=production`; run `prisma migrate deploy`.

### CI

`.github/workflows/ci.yml` runs on every push/PR: Postgres service, then migrations + seed, lint, typecheck, build, boots the production server, waits for `/api/health`, then the full smoke suite.

## Known limitations

- Presence, typing state and rooms are in-memory per node; delivery already fans out through Redis, but presence itself would need a shared store (e.g. Redis presence keys) for multi-node consistency.
- Web Push requires a secure context (HTTPS or localhost) and VAPID keys in `.env`; the toggle degrades gracefully without them.
- npm audit reports 3 high-severity advisories inside the **Prisma CLI dev dependency** chain (`deepmerge-ts`). Production dependencies are clean; downgrading Prisma to silence them would break the v7 setup.
