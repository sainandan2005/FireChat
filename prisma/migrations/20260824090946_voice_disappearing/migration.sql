-- DropIndex
DROP INDEX "Message_content_trgm_idx";

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "disappearingSeconds" INTEGER;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "duration" INTEGER,
ADD COLUMN     "expiresAt" TIMESTAMP(3);
