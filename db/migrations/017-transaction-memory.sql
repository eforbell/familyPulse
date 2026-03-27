-- 017-transaction-memory.sql — local notes, attachment metadata, and retained transaction memory

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS source_removed BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS source_removed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_transactions_source_removed
  ON transactions(source_removed);

CREATE TABLE IF NOT EXISTS transaction_notes (
  transaction_id INT PRIMARY KEY REFERENCES transactions(id) ON DELETE CASCADE,
  note           TEXT NOT NULL,
  created_by     INT REFERENCES family_members(id) ON DELETE SET NULL,
  updated_by     INT REFERENCES family_members(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_transaction_notes_updated_at
  ON transaction_notes(updated_at DESC);

CREATE TABLE IF NOT EXISTS transaction_attachments (
  id                SERIAL PRIMARY KEY,
  transaction_id    INT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  original_filename TEXT NOT NULL,
  stored_filename   TEXT NOT NULL UNIQUE,
  mime_type         TEXT NOT NULL,
  byte_size         BIGINT NOT NULL CHECK (byte_size >= 0),
  uploaded_by       INT REFERENCES family_members(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_transaction_attachments_transaction
  ON transaction_attachments(transaction_id, created_at DESC);
