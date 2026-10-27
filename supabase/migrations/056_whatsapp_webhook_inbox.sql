-- ============================================================
-- 056 — Durable inbox for inbound WhatsApp webhooks.
--
-- DRAFT FOR REVIEW. Not applied. Additive only: one new table, one
-- partial index, RLS enabled with no policies (service role only).
--
-- Why: the webhook acknowledges Meta with 200 and then processes the
-- event in `after()`. If the process dies between the 200 and the
-- message insert (crash, redeploy, platform timeout), the event is lost
-- and Meta will not redeliver it — it already got its 200. With
-- WHATSAPP_WEBHOOK_INBOX=1 the route first writes the verified payload
-- here (one INSERT), only then answers 200, and marks the row done when
-- processing finishes. GET /api/whatsapp/webhook/sweep (cron, guarded by
-- AUTOMATION_CRON_SECRET) re-runs rows left pending/failed.
--
-- Idempotency: `dedupe_key` is the SHA-256 of the exact signed body, so a
-- Meta retry of the same delivery is not stored twice. Per-message
-- idempotency is unchanged — the messages upsert on Meta's message id.
--
-- Data handling: `payload` holds the same customer data the messages /
-- contacts tables already store (phone numbers, message text). Rows are
-- deleted by the sweep 7 days after they are processed.
-- ============================================================

CREATE TABLE IF NOT EXISTS whatsapp_webhook_inbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key TEXT NOT NULL UNIQUE,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  attempts INT NOT NULL DEFAULT 1,
  last_error TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

-- The sweep only ever scans unfinished rows.
CREATE INDEX IF NOT EXISTS idx_whatsapp_webhook_inbox_unfinished
  ON whatsapp_webhook_inbox (received_at)
  WHERE status IN ('pending', 'processing', 'failed');

-- No policies: only the service-role client (webhook route + sweep) can
-- read or write. Browser clients see nothing.
ALTER TABLE whatsapp_webhook_inbox ENABLE ROW LEVEL SECURITY;
