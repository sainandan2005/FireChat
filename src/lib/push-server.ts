import "dotenv/config";
import webpush from "web-push";
import { prisma } from "./prisma";

interface PushPayload {
  title: string;
  body: string;
  conversationId: string;
}

const configured = (() => {
  const publicKey = process.env.WEB_PUSH_PUBLIC_KEY;
  const privateKey = process.env.WEB_PUSH_PRIVATE_KEY;
  if (!publicKey || !privateKey) return false;
  webpush.setVapidDetails("mailto:dev@firechat.local", publicKey, privateKey);
  return true;
})();

export function getVapidPublicKey(): string | null {
  return configured ? (process.env.WEB_PUSH_PUBLIC_KEY as string) : null;
}

/** Sends a push to every device of a user; silently drops stale endpoints. */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<void> {
  if (!configured) return;

  const subscriptions = await prisma.pushSubscription.findMany({
    where: { userId },
  });
  if (subscriptions.length === 0) return;

  await Promise.allSettled(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          JSON.stringify(payload)
        );
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
        }
      }
    })
  );
}
