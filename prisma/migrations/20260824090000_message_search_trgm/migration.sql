-- Accelerate case-insensitive substring search on message content.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS "Message_content_trgm_idx" ON "Message" USING gin ("content" gin_trgm_ops);
