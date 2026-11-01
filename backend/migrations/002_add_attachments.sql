ALTER TABLE todos
  ADD COLUMN attachment_key TEXT UNIQUE,
  ADD COLUMN attachment_name TEXT,
  ADD COLUMN attachment_type TEXT,
  ADD COLUMN attachment_size INTEGER CHECK (attachment_size BETWEEN 1 AND 5242880),
  ADD CONSTRAINT attachment_metadata_complete CHECK (
    (attachment_key IS NULL AND attachment_name IS NULL AND attachment_type IS NULL AND attachment_size IS NULL)
    OR (attachment_key IS NOT NULL AND attachment_name IS NOT NULL AND attachment_type IS NOT NULL AND attachment_size IS NOT NULL)
  );

-- Durable cleanup outbox: files are retried after a temporary storage outage.
CREATE TABLE attachment_cleanup (
  key TEXT PRIMARY KEY,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attempts INTEGER NOT NULL DEFAULT 0
);
