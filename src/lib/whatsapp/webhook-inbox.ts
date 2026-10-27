import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

// ------------------------------------------------------------
// Durable inbox for inbound webhooks (migration 056).
//
// Off unless WHATSAPP_WEBHOOK_INBOX=1, so nothing changes until the
// migration has been applied and the flag set. When on, the route
// accepts an event into the inbox BEFORE answering Meta, and a failed
// write answers 503 so Meta redelivers instead of the event being lost.
// ------------------------------------------------------------

const TABLE = 'whatsapp_webhook_inbox'

/** Rows older than this and not done are treated as abandoned. */
export const INBOX_STALE_AFTER_MS = 5 * 60_000
export const INBOX_MAX_ATTEMPTS = 5
export const INBOX_RETENTION_DAYS = 7

export function webhookInboxEnabled(): boolean {
  return process.env.WHATSAPP_WEBHOOK_INBOX === '1'
}

export function inboxDedupeKey(rawBody: string): string {
  return createHash('sha256').update(rawBody).digest('hex')
}

/**
 * Durably record a verified delivery. Returns the row id, or null when
 * the identical delivery was already accepted (a Meta retry). Throws when
 * the write fails — the caller must not acknowledge Meta in that case.
 */
export async function acceptIntoInbox(
  db: SupabaseClient,
  rawBody: string,
  payload: unknown,
): Promise<{ id: string } | null> {
  const { data, error } = await db
    .from(TABLE)
    .upsert(
      { dedupe_key: inboxDedupeKey(rawBody), payload },
      { onConflict: 'dedupe_key', ignoreDuplicates: true },
    )
    .select('id')
  if (error) throw new Error(`webhook inbox write failed: ${error.message}`)
  const rows = (data ?? []) as { id: string }[]
  return rows[0] ?? null
}

/** Error text stored on the row: bounded, and never the payload itself. */
function describeFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.slice(0, 300)
}

export async function completeInbox(
  db: SupabaseClient,
  id: string,
  outcome: { ok: true } | { ok: false; error: unknown },
): Promise<void> {
  const { error } = await db
    .from(TABLE)
    .update(
      outcome.ok
        ? { status: 'done', processed_at: new Date().toISOString(), last_error: null }
        : { status: 'failed', last_error: describeFailure(outcome.error) },
    )
    .eq('id', id)
  if (error) console.error('[webhook-inbox] status update failed:', error.message)
}

export interface ClaimedInboxRow {
  id: string
  payload: unknown
  attempts: number
}

/**
 * Claim abandoned rows for reprocessing. Each claim is a conditional
 * UPDATE on the attempts counter, so two overlapping sweeps can't both
 * take the same row.
 */
export async function claimStaleInbox(
  db: SupabaseClient,
  { now = new Date(), limit = 20 }: { now?: Date; limit?: number } = {},
): Promise<ClaimedInboxRow[]> {
  const cutoff = new Date(now.getTime() - INBOX_STALE_AFTER_MS).toISOString()
  const { data, error } = await db
    .from(TABLE)
    .select('id, payload, attempts')
    .in('status', ['pending', 'processing', 'failed'])
    .lt('received_at', cutoff)
    .lt('attempts', INBOX_MAX_ATTEMPTS)
    .order('received_at', { ascending: true })
    .limit(limit)
  if (error) throw new Error(`webhook inbox scan failed: ${error.message}`)

  const claimed: ClaimedInboxRow[] = []
  for (const row of (data ?? []) as ClaimedInboxRow[]) {
    const { data: won } = await db
      .from(TABLE)
      .update({ status: 'processing', attempts: row.attempts + 1 })
      .eq('id', row.id)
      .eq('attempts', row.attempts)
      .select('id')
    if (Array.isArray(won) && won.length === 1) {
      claimed.push({ ...row, attempts: row.attempts + 1 })
    }
  }
  return claimed
}

/** Drop processed rows past retention. Returns how many were removed. */
export async function pruneInbox(db: SupabaseClient, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - INBOX_RETENTION_DAYS * 86_400_000).toISOString()
  const { data, error } = await db
    .from(TABLE)
    .delete()
    .eq('status', 'done')
    .lt('processed_at', cutoff)
    .select('id')
  if (error) {
    console.error('[webhook-inbox] prune failed:', error.message)
    return 0
  }
  return (data ?? []).length
}
