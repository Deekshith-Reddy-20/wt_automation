import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { processWebhook, type WhatsAppWebhookEntry } from '@/lib/whatsapp/inbound-webhook'
import {
  claimStaleInbox,
  completeInbox,
  pruneInbox,
  webhookInboxEnabled,
} from '@/lib/whatsapp/webhook-inbox'

/**
 * Re-run inbound webhook events that were durably accepted but never
 * finished processing (migration 056; only active with
 * WHATSAPP_WEBHOOK_INBOX=1). Reprocessing is safe to repeat: the
 * messages upsert on Meta's message id turns an already-stored message
 * into a no-op, so a retry can never send a second auto-reply.
 *
 * Auth: same `AUTOMATION_CRON_SECRET` / `x-cron-secret` header as the
 * other cron endpoints. Schedule every few minutes.
 */
export const maxDuration = 60

export async function GET(request: Request) {
  if (!webhookInboxEnabled()) {
    return NextResponse.json({ error: 'webhook inbox not enabled' }, { status: 404 })
  }
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const suppliedBuf = Buffer.from(request.headers.get('x-cron-secret') ?? '')
  const expectedBuf = Buffer.from(expected)
  if (suppliedBuf.length !== expectedBuf.length || !timingSafeEqual(suppliedBuf, expectedBuf)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  let rows
  try {
    rows = await claimStaleInbox(db)
  } catch (error) {
    console.error('[webhook-sweep]', error instanceof Error ? error.message : error)
    return NextResponse.json({ error: 'scan failed' }, { status: 500 })
  }

  let done = 0
  let failed = 0
  for (const row of rows) {
    try {
      await processWebhook(row.payload as { entry?: WhatsAppWebhookEntry[] })
      await completeInbox(db, row.id, { ok: true })
      done++
    } catch (error) {
      await completeInbox(db, row.id, { ok: false, error })
      failed++
    }
  }
  const pruned = await pruneInbox(db)
  return NextResponse.json({ reprocessed: done, failed, pruned })
}
