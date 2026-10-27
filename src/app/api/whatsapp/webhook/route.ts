import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption'
import {
  appSecretStatus,
  envVerifyTokenMatches,
  verifyMetaWebhookSignature,
  verifyTokenMatches,
} from '@/lib/whatsapp/webhook-signature'
import { recordWebhookPost } from '@/lib/whatsapp/webhook-health'
import { readCappedBody } from '@/lib/whatsapp/webhook-body'
import { processWebhook, type WhatsAppWebhookEntry } from '@/lib/whatsapp/inbound-webhook'
import { markLatency, newLatencyTrace } from '@/lib/whatsapp/latency-trace'
import {
  acceptIntoInbox,
  completeInbox,
  webhookInboxEnabled,
} from '@/lib/whatsapp/webhook-inbox'

// The `after()` callback in POST runs within this route's max duration.
// Inbound processing can fan out to per-media Meta verification calls, so
// give it headroom beyond the platform default (Vercel clamps this to the
// plan's ceiling). Tune as needed.
export const maxDuration = 60

// Lazy-initialized to avoid build-time crash when env vars are missing
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

// GET - Webhook verification
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const mode = searchParams.get('hub.mode')
    const challenge = searchParams.get('hub.challenge')
    const verifyToken = searchParams.get('hub.verify_token')

    if (mode !== 'subscribe' || !challenge || !verifyToken) {
      return NextResponse.json(
        { error: 'Missing verification parameters' },
        { status: 403 }
      )
    }

    if (envVerifyTokenMatches(verifyToken)) {
      return new Response(challenge, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })
    }

    // Fetch all whatsapp configs to check verify tokens
    const { data: configs, error: configError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('id, verify_token')

    if (configError || !configs) {
      console.error('Error fetching configs for verification:', configError)
      return NextResponse.json(
        { error: 'Verification failed' },
        { status: 403 }
      )
    }

    // Check if any config's verify_token matches. Also collect the
    // matching row so we can opportunistically upgrade its token to
    // GCM if it was still in the legacy CBC format.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let matchedConfig: any = null
    for (const config of configs) {
      if (!config.verify_token) continue
      try {
        if (verifyTokenMatches(decrypt(config.verify_token), verifyToken)) {
          matchedConfig = config
          break
        }
      } catch {
        // Malformed / wrong-key token row — skip it and keep checking.
      }
    }

    if (matchedConfig) {
      // Fire-and-forget GCM upgrade. Safe to run on every subscribe
      // since it's a no-op once the column is already GCM.
      if (isLegacyFormat(matchedConfig.verify_token)) {
        void supabaseAdmin()
          .from('whatsapp_config')
          .update({ verify_token: encrypt(verifyToken) })
          .eq('id', matchedConfig.id)
          .then(({ error }: { error: unknown }) => {
            if (error) {
              console.warn(
                '[webhook] verify_token GCM upgrade failed:',
                (error as { message?: string })?.message ?? error,
              )
            }
          })
      }
      // Return challenge as plain text
      return new Response(challenge, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })
    }

    return NextResponse.json(
      { error: 'Verification token mismatch' },
      { status: 403 }
    )
  } catch (error) {
    console.error('Error in webhook GET verification:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// POST - Receive messages
export async function POST(request: Request) {
  const trace = newLatencyTrace()
  // Read raw body first so we can HMAC-verify the exact bytes Meta
  // signed. request.json() would re-encode and break the signature.
  const rawBody = await readCappedBody(request)
  if (rawBody === null) {
    console.warn('[webhook] rejected oversized payload')
    recordWebhookPost('too_large')
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
  }
  const signature = request.headers.get('x-hub-signature-256')

  if (!verifyMetaWebhookSignature(rawBody, signature)) {
    // 401 (not 200) — we want Meta's delivery dashboard to show failures
    // loudly if a misconfiguration causes signatures to stop matching,
    // rather than silently eating events.
    console.warn(
      appSecretStatus() === 'placeholder'
        ? '[webhook] rejected request: META_APP_SECRET is a placeholder, so no real Meta signature can match'
        : '[webhook] rejected request with invalid signature',
    )
    recordWebhookPost('invalid_signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }
  markLatency('signature_verified', trace)

  let body: { entry?: WhatsAppWebhookEntry[] }
  try {
    body = JSON.parse(rawBody)
  } catch {
    recordWebhookPost('invalid_json')
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  markLatency('parsed', trace)

  // Durable acceptance (migration 056, opt-in). The event is written
  // before Meta gets its 200; if that write fails we answer 503 so Meta
  // redelivers rather than the event being acknowledged and lost.
  let inboxId: string | null = null
  if (webhookInboxEnabled()) {
    try {
      const accepted = await acceptIntoInbox(supabaseAdmin(), rawBody, body)
      if (!accepted) {
        // The identical delivery is already in the inbox; the sweep owns
        // it if its first processing attempt never finished.
        recordWebhookPost('accepted')
        return NextResponse.json({ status: 'received' }, { status: 200 })
      }
      inboxId = accepted.id
    } catch (error) {
      console.error(
        '[webhook] could not durably accept event; asking Meta to retry:',
        error instanceof Error ? error.message : error
      )
      return NextResponse.json({ error: 'Temporarily unavailable' }, { status: 503 })
    }
  }
  recordWebhookPost('accepted')

  // Process AFTER the response so we ack Meta within their ~20s timeout
  // (a slow ack triggers Meta retries + duplicate inserts), while still
  // guaranteeing the work runs to completion.
  //
  // This MUST use `after()` rather than a detached `processWebhook(body)`
  // promise: on serverless platforms (we run on Vercel) the function can
  // be frozen or terminated the moment the response is sent, so a floating
  // promise's DB writes are not guaranteed to finish. That dropped a
  // non-deterministic *subset* of inbound messages — contacts/conversations
  // were created but the message insert never landed, leaving conversations
  // that show in the inbox with an empty thread, and no logs to explain it
  // (see issue #301). `after()` hands the callback to the runtime, which
  // keeps the function alive until it resolves (within the route's
  // maxDuration).
  after(async () => {
    markLatency('processing_started', trace)
    try {
      await processWebhook(body, trace)
      if (inboxId) await completeInbox(supabaseAdmin(), inboxId, { ok: true })
    } catch (error) {
      console.error('Error processing webhook:', error)
      if (inboxId) await completeInbox(supabaseAdmin(), inboxId, { ok: false, error })
    }
  })

  markLatency('acked', trace)
  return NextResponse.json({ status: 'received' }, { status: 200 })
}
