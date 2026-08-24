-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "replyToId" TEXT;

-- AlterTable
ALTER TABLE "Participant" ADD COLUMN     "lastDeliveredAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "lastSeenAt" TIMESTAMP(3);

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_replyToId_fkey" FOREIGN KEY ("replyToId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;
