-- AlterTable
ALTER TABLE "Participant" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "muted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pinnedAt" TIMESTAMP(3);
