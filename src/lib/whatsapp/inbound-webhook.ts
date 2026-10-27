import { createClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { getMediaUrl } from '@/lib/whatsapp/meta-api'
import { mirrorInboundMedia } from '@/lib/whatsapp/mirror-inbound-media'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import {
  hasUsableIdentity,
  identityDisplayName,
  resolveInboundIdentity,
  type WaContactPayload,
  type WaIdentity,
} from '@/lib/whatsapp/wa-identity'
import {
  findExistingContact,
  isUniqueViolation,
  pickBestPhoneMatch,
} from '@/lib/contacts/dedupe'
import {
  resolveInboundContext,
  type InboundContextResult,
} from '@/lib/whatsapp/inbound-context-rpc'
import { reopenClosedConversation } from '@/lib/conversations/reopen'
import { claimFirstInboundMessage } from '@/lib/conversations/first-inbound'
import { resumeAwaitingReply, runAutomationsForTrigger } from '@/lib/automations/engine'
import {
  dispatchInboundToFlows,
  prefetchActiveFlows,
  prefetchActiveRunReads,
} from '@/lib/flows/engine'
import { engineSendText } from '@/lib/flows/meta-send'
import { applyOptKeyword, loadOptedOutAt } from '@/lib/contacts/opt-out'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import {
  applyBroadcastRecipientStatus,
  flagBroadcastReply,
} from '@/lib/whatsapp/broadcast-recipient-webhook'
import {
  handleTemplateWebhookChange,
  isTemplateWebhookField,
} from '@/lib/whatsapp/template-webhook'
import { applyMessageStatus } from '@/lib/whatsapp/message-status-sync'
import {
  cacheInboundConfig,
  getCachedInboundConfig,
  INBOUND_CONFIG_COLUMNS,
  type InboundConfigRow,
} from '@/lib/whatsapp/config-cache'
import {
  markInboundRecipientVerified,
  runWithInboundSendCredentials,
  setInboundSendGate,
} from '@/lib/whatsapp/inbound-context'
import {
  finishLatencyTrace,
  forkLatencyTrace,
  markLatency,
  newLatencyTrace,
  runWithLatencyTrace,
  type LatencyTrace,
} from '@/lib/whatsapp/latency-trace'

// ------------------------------------------------------------
// Inbound WhatsApp webhook processing: everything that runs after the
// route has verified the signature and acknowledged Meta. Lives outside
// the route file so a recovery sweep can re-run it for an accepted event.
// ------------------------------------------------------------

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

export interface WhatsAppMessage {
  id: string
  /**
   * Sender's phone number. **Optional since Meta's username rollout** —
   * a sender who has adopted a WhatsApp username and has no recent
   * interaction history with this business arrives with no phone number
   * at all, identified only by `from_user_id` (issue #519). See
   * `@/lib/whatsapp/wa-identity`.
   */
  from?: string
  /** Sender's business-scoped user ID (BSUID). */
  from_user_id?: string
  /** Sender's portfolio-level BSUID. */
  from_parent_user_id?: string
  timestamp: string
  type: string
  text?: { body: string }
  image?: { id: string; mime_type: string; caption?: string }
  video?: { id: string; mime_type: string; caption?: string }
  document?: { id: string; mime_type: string; filename?: string; caption?: string }
  audio?: { id: string; mime_type: string }
  sticker?: { id: string; mime_type: string }
  location?: { latitude: number; longitude: number; name?: string; address?: string }
  reaction?: { message_id: string; emoji: string }
  /**
   * Set when the customer taps a button or list row on an interactive
   * message we sent. `button_reply.id` / `list_reply.id` is whatever id
   * we put on the button/row when sending — the Flows engine uses this
   * to advance the per-contact run.
   */
  interactive?: {
    type: 'button_reply' | 'list_reply'
    button_reply?: { id: string; title: string }
    list_reply?: { id: string; title: string; description?: string }
  }
  /**
   * Set when the customer taps a QUICK_REPLY button on a *template*
   * message — a broadcast, or any template send. Meta uses a different
   * envelope from `interactive` above: `type: 'button'`, the label in
   * `button.text`, and the payload configured on the template's button
   * in `button.payload` (Meta's own template editor doesn't ask for a
   * payload and mirrors the label into it).
   */
  button?: { text?: string; payload?: string }
  /** Present when the customer swipe-replies to one of our messages. */
  context?: { id: string }
}

/** One entry of a failed status's `errors` array, as Meta sends it. */
interface MetaStatusError {
  code: number
  title: string
  message?: string
  error_data?: { details?: string }
  href?: string
}

export interface WhatsAppWebhookEntry {
  id: string
  changes: Array<{
    value: {
      messaging_product: string
      metadata: {
        display_phone_number: string
        phone_number_id: string
      }
      contacts?: Array<{
        profile: { name?: string; username?: string }
        /** Absent for a username-only sender — see WhatsAppMessage.from. */
        wa_id?: string
        user_id?: string
        parent_user_id?: string
      }>
      messages?: WhatsAppMessage[]
      statuses?: Array<{
        id: string
        status: string
        timestamp: string
        recipient_id: string
        /**
         * Only present when `status === 'failed'`. Meta's reason for the
         * failure — `code` is a stable numeric error code (e.g. 131049),
         * `title` a short label, `error_data.details` the human-readable
         * explanation. See #535.
         */
        errors?: MetaStatusError[]
      }>
    }
    field: string
  }>
}

async function resolveAccountForPhoneNumber(
  phoneNumberId: string | undefined
): Promise<string | null> {
  if (!phoneNumberId) return null
  const cached = getCachedInboundConfig(phoneNumberId)
  if (cached) return cached.account_id
  const { data, error } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('account_id')
    .eq('phone_number_id', phoneNumberId)

  if (error) {
    console.error('Error resolving account for status update:', phoneNumberId, error)
    return null
  }
  if (!data || data.length !== 1) {
    console.error(
      `Status update for phone_number_id ${phoneNumberId} matched ${data?.length ?? 0} configs; message statuses skipped`
    )
    return null
  }
  return data[0].account_id
}

function metaTimestampToIso(timestamp: string): string | null {
  const seconds = Number.parseInt(timestamp, 10)
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null
}

export async function processWebhook(
  body: { entry?: WhatsAppWebhookEntry[] },
  trace: LatencyTrace = newLatencyTrace()
) {
  if (!body.entry) return

  for (const entry of body.entry) {
    for (const change of entry.changes) {
      // Template-lifecycle events (status / quality / components
      // updates from Meta) come in on a different change.field and
      // have a different value shape — route them through the
      // dedicated handler. Skip the messaging branches below so we
      // don't try to read message-shaped fields off a template event.
      // `entry.id` is the WABA id for template events — the handler
      // needs it to resolve the owning account when the template has
      // no local row yet (#534).
      if (isTemplateWebhookField(change.field)) {
        await handleTemplateWebhookChange(
          {
            field: change.field,
            value: change.value as unknown,
            wabaId: entry.id,
          },
          supabaseAdmin(),
        )
        continue
      }

      const value = change.value

      // Handle status updates
      if (value.statuses) {
        const statusAccountId = await resolveAccountForPhoneNumber(
          value.metadata?.phone_number_id
        )
        for (const status of value.statuses) {
          await handleStatusUpdate(status, statusAccountId)
        }
      }

      // Handle incoming messages
      if (!value.messages || !value.contacts) continue

      const phoneNumberId = value.metadata.phone_number_id
      // Per-table config read, done at most once for this change and only
      // when resolve_inbound_context isn't available.
      let fallbackConfig: InboundConfigRow | null | undefined

      for (let i = 0; i < value.messages.length; i++) {
        const message = value.messages[i]
        const contact = value.contacts[i] || value.contacts[0]

        const messageTrace = forkLatencyTrace(trace, message.id)
        try {
          await runWithLatencyTrace(messageTrace, async () => {
            // Keyed only by Meta's id and filtered to the resolved
            // conversation later, so it can overlap the routing lookups.
            const replyLookup = message.context?.id
              ? lookupMessagesByMetaId(message.context.id).catch((err: unknown) => {
                  console.error(
                    '[webhook] lookupMessagesByMetaId threw:',
                    err instanceof Error ? err.message : err
                  )
                  return []
                })
              : undefined
            // Config + contact + conversation in one round trip when
            // migration 058 is installed; null means "use the per-table
            // queries", never "drop the message".
            const context = await resolveInboundContext(
              supabaseAdmin(),
              phoneNumberId,
              resolveInboundIdentity(message, contact),
            )
            let config: InboundConfigRow | null
            if (context) {
              config = singleInboundConfig(context.config, phoneNumberId)
              if (config) cacheInboundConfig(config)
            } else {
              if (fallbackConfig === undefined) {
                fallbackConfig = await loadInboundConfig(phoneNumberId)
              }
              config = fallbackConfig
            }
            if (!config) return
            markLatency('config_loaded')

            const accessToken = decrypt(config.access_token)
            const sendCredentials = {
              accountId: config.account_id,
              phoneNumberId,
              accessToken,
            }
            await runWithInboundSendCredentials(sendCredentials, () => processMessage(
              message,
              contact,
              // Tenancy — drives every contact / conversation lookup
              // and the engines' active-row dispatch.
              config.account_id,
              // Audit / sender-of-record — used as the user_id on row
              // inserts that need it for NOT NULL FK compliance. Always
              // the admin who saved the WhatsApp config.
              config.user_id,
              accessToken,
              // Default ON: the column is NOT NULL DEFAULT TRUE, but a row
              // read before migration 039 lands would have it undefined,
              // and losing attachments is the failure mode worth avoiding.
              config.mirror_inbound_media !== false,
              context,
              replyLookup,
            ))
          })
        } finally {
          finishLatencyTrace(messageTrace)
        }
      }
    }
  }
}

/**
 * Exactly one config row, or null with the cause logged. ≥2 rows
 * shouldn't happen post-migration 013 (UNIQUE constraint), but a row
 * created before the constraint would still surface here.
 */
function singleInboundConfig(
  rows: InboundConfigRow[] | null,
  phoneNumberId: string
): InboundConfigRow | null {
  if (!rows || rows.length === 0) {
    console.error('No config found for phone_number_id:', phoneNumberId)
    return null
  }
  if (rows.length > 1) {
    console.error(
      `Multiple configs (${rows.length}) found for phone_number_id:`,
      phoneNumberId,
      '— inbound message dropped. Resolve duplicates so each number maps to a single account.',
      'Account owners:',
      rows.map((r) => `${r.account_id} (admin ${r.user_id})`)
    )
    return null
  }
  return rows[0]
}

/** The receiving number's config via the short-lived cache, else one query. */
async function loadInboundConfig(phoneNumberId: string): Promise<InboundConfigRow | null> {
  const cached = getCachedInboundConfig(phoneNumberId)
  if (cached) return cached
  const { data, error } = (await supabaseAdmin()
    .from('whatsapp_config')
    .select(INBOUND_CONFIG_COLUMNS)
    .eq('phone_number_id', phoneNumberId)) as {
    data: InboundConfigRow[] | null
    error: unknown
  }
  if (error) {
    console.error('Error fetching whatsapp_config for phone_number_id:', phoneNumberId, error)
    return null
  }
  const config = singleInboundConfig(data, phoneNumberId)
  if (config) cacheInboundConfig(config)
  return config
}

async function handleStatusUpdate(
  status: {
    id: string
    status: string
    timestamp: string
    recipient_id: string
    errors?: MetaStatusError[]
  },
  accountId: string | null
) {
  // Meta's reason for a failed send (#535). Only read on `failed`; a
  // later non-failed status for the same wamid leaves the error
  // columns alone rather than clearing them, so the reason survives.
  const failure =
    status.status === 'failed' && status.errors?.[0]
      ? {
          code: status.errors[0].code,
          title: status.errors[0].title,
          details: status.errors[0].error_data?.details ?? null,
        }
      : null

  if (failure) {
    console.warn(
      `WhatsApp message ${status.id} failed: [${failure.code}] ${failure.title}` +
        (failure.details ? ` — ${failure.details}` : '')
    )
  }

  const advancedMessages = accountId
    ? await applyMessageStatus(supabaseAdmin(), accountId, {
        wamid: status.id,
        status: status.status,
        failure,
        statusAt: metaTimestampToIso(status.timestamp),
      })
    : []

  // Webhook fan-out for this status change happens at the END of this
  // handler (after the broadcast mirror below), so a slow subscriber
  // endpoint can't delay the broadcast_recipients update.

  // 2) Mirror onto broadcast_recipients via whatsapp_message_id
  //    (added in migration 003). The aggregate trigger on
  //    broadcast_recipients re-derives the parent broadcast's
  //    sent/delivered/read/failed counts automatically.
  await applyBroadcastRecipientStatus(supabaseAdmin(), {
    whatsappMessageId: status.id,
    status: status.status,
    occurredAt: new Date(parseInt(status.timestamp) * 1000).toISOString(),
    failure,
  })

  // 3) Webhook fan-out for messages we store (inbox / API sends).
  //    Runs last so a slow subscriber can't delay the mirrors above.
  if (!accountId) return
  for (const advanced of advancedMessages) {
    await dispatchWebhookEvent(
      supabaseAdmin(),
      accountId,
      'message.status_updated',
      {
        whatsapp_message_id: status.id,
        conversation_id: advanced.conversation_id,
        status: status.status,
      }
    )
  }
}

/**
 * Flip the contact's most recent broadcast recipient row to `replied`
 * when it was sent within the reply window and isn't already replied.
 *
 * Runs on a best-effort basis — failures here must not break the
 * main inbound-message flow, so errors are swallowed with a log.
 */
async function flagBroadcastReplyIfAny(accountId: string, contactId: string) {
  try {
    await flagBroadcastReply(supabaseAdmin(), accountId, contactId)
  } catch (err) {
    console.error('flagBroadcastReplyIfAny failed:', err)
  }
}

/**
 * Resolve a Meta-side message_id into the matching internal UUID, scoped
 * to one conversation. Returns null when we never received the parent
 * (e.g. a swipe-reply to a message older than this CRM install).
 */
async function lookupInternalIdByMetaId(
  metaId: string,
  conversationId: string
): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .eq('message_id', metaId)
    .eq('conversation_id', conversationId)
    .maybeSingle()
  if (error) {
    console.error('[webhook] lookupInternalIdByMetaId failed:', error.message)
    return null
  }
  return data?.id ?? null
}

/**
 * Rows carrying a Meta-side message_id, across conversations. Callers
 * must keep only the row in their own conversation.
 */
async function lookupMessagesByMetaId(
  metaId: string
): Promise<{ id: string; conversation_id: string }[]> {
  const { data, error } = await supabaseAdmin()
    .from('messages')
    .select('id, conversation_id')
    .eq('message_id', metaId)
    .limit(10)
  if (error) {
    console.error('[webhook] lookupMessagesByMetaId failed:', error.message)
    return []
  }
  return data ?? []
}

/**
 * Persist an inbound reaction. WhatsApp reactions are not new messages —
 * they're per-(target, actor) state. We upsert / delete on
 * `message_reactions`, never write a row into `messages`.
 *
 * Best-effort: a missing parent (we never received it) is logged and
 * skipped so the webhook still acks 200 to Meta.
 */
async function handleReaction(
  message: WhatsAppMessage,
  conversationId: string,
  contactId: string
) {
  const reaction = message.reaction
  if (!reaction?.message_id) return

  const targetInternalId = await lookupInternalIdByMetaId(
    reaction.message_id,
    conversationId
  )
  if (!targetInternalId) {
    console.warn(
      '[webhook] reaction target message not found; skipping',
      reaction.message_id
    )
    return
  }

  // Empty emoji = removal (per Meta's Cloud API spec).
  if (!reaction.emoji) {
    const { error: delError } = await supabaseAdmin()
      .from('message_reactions')
      .delete()
      .eq('message_id', targetInternalId)
      .eq('actor_type', 'customer')
      .eq('actor_id', contactId)
    if (delError) {
      console.error('[webhook] reaction delete failed:', delError.message)
    }
    return
  }

  const { error: upsertError } = await supabaseAdmin()
    .from('message_reactions')
    .upsert(
      {
        message_id: targetInternalId,
        conversation_id: conversationId,
        actor_type: 'customer',
        actor_id: contactId,
        emoji: reaction.emoji,
      },
      { onConflict: 'message_id,actor_type,actor_id' }
    )
  if (upsertError) {
    console.error('[webhook] reaction upsert failed:', upsertError.message)
  }
}

async function processMessage(
  message: WhatsAppMessage,
  contact: WaContactPayload | undefined,
  // Tenancy. Resolved from the matched whatsapp_config row; every
  // contact / conversation / message row created downstream is
  // stamped with this so any member of the account can see it.
  accountId: string,
  // Sender-of-record for inserts that need a NOT NULL user_id FK
  // (contacts, conversations). Always the admin who saved the
  // WhatsApp config; the choice is arbitrary post-017 but stable.
  configOwnerUserId: string,
  accessToken: string,
  // Per-account opt-out for the inbound-media mirror (migration 039).
  // See parseMessageContent for what it turns off.
  mirrorMedia: boolean,
  // resolve_inbound_context's result for this message, when available.
  context: InboundContextResult | null = null,
  // The quoted parent's candidate rows, when already being fetched.
  replyLookup?: Promise<{ id: string; conversation_id: string }[]>
) {
  // Phone number OR business-scoped user ID — Meta sends only the
  // latter for a sender who has adopted a WhatsApp username (#519).
  const identity = resolveInboundIdentity(message, contact)
  if (!hasUsableIdentity(identity)) {
    // Neither key present. Creating a row anyway would mean an
    // unreachable contact that can never be matched again, so drop the
    // delivery loudly instead of silently accumulating them.
    console.error(
      '[webhook] inbound message carries neither a phone number nor a BSUID; skipping:',
      message.id
    )
    return
  }

  // The quoted parent of a swipe-reply / button tap. Issued now so it
  // overlaps contact + conversation resolution; scoped to the resolved
  // conversation below.
  const replyContextCandidates = message.context?.id
    ? (replyLookup ?? lookupMessagesByMetaId(message.context.id))
    : Promise.resolve([])
  // Needs only the account, so it overlaps contact + conversation
  // resolution instead of following the first-inbound claim.
  const activeFlows =
    message.type === 'reaction' ? undefined : prefetchActiveFlows(accountId)

  // Find or create contact — already done by resolve_inbound_context
  // when it ran; otherwise (or when its phone candidates are all
  // rejected by pickBestPhoneMatch) the per-table path.
  const fromContext = context ? await contactFromContext(context, identity) : null
  const contactOutcome =
    fromContext?.outcome ??
    (await findOrCreateContact(accountId, configOwnerUserId, identity))
  if (!contactOutcome) return
  const contactRecord = contactOutcome.contact
  markLatency('contact_resolved')

  // The flow runner's active-run reads need only the contact, so they
  // overlap conversation resolution, the message insert and bookkeeping.
  const flowPrefetch =
    message.type === 'reaction'
      ? undefined
      : prefetchActiveRunReads(accountId, contactRecord.id, message.id)
  // Read now, applied once the message is stored. Settled so that a
  // failed lookup blocks automation instead of throwing.
  const readOptedOut = () =>
    loadOptedOutAt(supabaseAdmin(), accountId, contactRecord.id).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    )
  const optedOutRead = message.type === 'reaction' ? undefined : readOptedOut()

  // Find or create conversation. When the function resolved the contact
  // it also returned its oldest conversation, so an absent one is
  // created without a second lookup.
  const convResult =
    fromContext?.conversation ??
    (await findOrCreateConversation(
      accountId,
      configOwnerUserId,
      contactRecord.id,
      contactOutcome.wasCreated || fromContext !== null
    ))
  if (!convResult) return
  const conversation = convResult.conversation
  markLatency('conversation_resolved')

  // Emit conversation.created as soon as the thread is opened — BEFORE
  // the reaction short-circuit below — so a conversation first opened by
  // a reaction still fires the event, and a subscriber always sees the
  // thread open before its first message.received.
  // Started here but awaited later (before message.received, and before
  // the reaction return) so the subscriber lookup isn't on the path to
  // the first auto-reply.
  const conversationCreatedEvent: Promise<unknown> = convResult.created
    ? dispatchWebhookEvent(supabaseAdmin(), accountId, 'conversation.created', {
        conversation_id: conversation.id,
        contact_id: contactRecord.id,
      })
    : Promise.resolve()

  // Reactions short-circuit here — they aren't messages. We never insert
  // into `messages`, never bump unread_count, never update last_message_text.
  // Done before parseMessageContent so the media-URL fetch is skipped.
  if (message.type === 'reaction') {
    await conversationCreatedEvent
    await handleReaction(message, conversation.id, contactRecord.id)
    return
  }

  // Parse message content based on type
  const { contentText, mediaUrl, mediaType, interactiveReplyId } =
    await parseMessageContent(
      message,
      accessToken,
      mirrorMedia ? { accountId } : null
    )

  // Resolve swipe-reply context if present. A missing parent is fine —
  // we just store NULL and the UI renders the message without a quote.
  let replyToInternalId: string | null = null
  if (message.context?.id) {
    replyToInternalId =
      (await replyContextCandidates).find(
        (row) => row.conversation_id === conversation.id
      )?.id ?? null
    if (!replyToInternalId) {
      console.warn(
        '[webhook] reply context parent not found:',
        message.context.id
      )
    }
  }

  // Insert message — field names MUST match the messages table schema
  // (see supabase/migrations/001_initial_schema.sql):
  //   conversation_id, sender_type, content_type, content_text,
  //   media_url, media_type, template_name, message_id, status,
  //   created_at

  // The messages.content_type CHECK constraint (widened in migration 010
  // to add 'interactive' for button/list taps) allows:
  //   text, image, document, audio, video, location, template, interactive
  // Map incoming WhatsApp types that aren't in that list to the closest
  // allowed value so the INSERT doesn't fail with a constraint error.
  const ALLOWED_CONTENT_TYPES = new Set([
    'text', 'image', 'document', 'audio', 'video',
    'location', 'template', 'interactive',
  ])
  const contentType = ALLOWED_CONTENT_TYPES.has(message.type)
    ? message.type
    : message.type === 'sticker'
      ? 'image'         // stickers are images
      : message.type === 'button'
        ? 'interactive' // template quick-reply tap (issue #478)
        : 'text'        // reaction, unknown → text fallback

  const receivedAt = new Date(parseInt(message.timestamp) * 1000).toISOString()

  // Idempotent insert. Meta retries webhook deliveries (a slow ack, a
  // transient 5xx), and each retry replays the exact same message.id. The
  // unique index on (conversation_id, message_id) added in migration 037
  // makes a replay conflict; `ignoreDuplicates` turns that into an ON
  // CONFLICT DO NOTHING, and the `.select()` then returns the inserted row
  // ONLY on a genuine first insert — an empty result means this delivery
  // was a replay. This is the single idempotency boundary that must sit
  // BEFORE the unread bump and all downstream fan-out below (issue #367).
  const { data: insertedRows, error: msgError } = await supabaseAdmin()
    .from('messages')
    .upsert(
      {
        conversation_id: conversation.id,
        sender_type: 'customer',
        content_type: contentType,
        content_text: contentText,
        media_url: mediaUrl,
        // Meta's MIME type for the attachment (migration 039). Was
        // discarded before, which forced the download path to guess an
        // extension from the fetched blob — impossible to do until the
        // bytes had already been fetched successfully.
        media_type: mediaType,
        message_id: message.id,
        status: 'delivered',
        created_at: receivedAt,
        reply_to_message_id: replyToInternalId,
        // Only populated for content_type='interactive'. Migration 010 added
        // the column; null for every other content_type so existing inserts
        // behave identically.
        interactive_reply_id: interactiveReplyId,
      },
      { onConflict: 'conversation_id,message_id', ignoreDuplicates: true }
    )
    .select('id')

  if (msgError) {
    console.error('Error inserting message:', msgError)
    await conversationCreatedEvent
    return
  }

  // Replayed delivery: the message already exists, so acknowledge it as a
  // no-op. Returning here is what keeps a retry from double-bumping unread,
  // re-advancing flows, re-firing automations, re-invoking AI handling, and
  // re-dispatching public webhooks (issue #367).
  if (!insertedRows || insertedRows.length === 0) {
    console.info(
      '[webhook] duplicate inbound message ignored (idempotent replay):',
      message.id
    )
    await conversationCreatedEvent
    return
  }
  markLatency('message_persisted')

  // The bookkeeping writes below are independent of each other, so they
  // run as one parallel round trip, overlapping the opt-out decision and
  // the flow's reply claim. Every automated send for this message waits
  // for them before calling Meta (the inbound send gate), so the bot's
  // own conversation-preview update still lands after the unread bump;
  // an entry-flow lookup waits for the first-inbound claim.
  const bookkeeping = Promise.all([
      claimFirstInboundMessage(supabaseAdmin(), conversation, receivedAt),
      // The unread bump is done DB-side (migration 037's
      // bump_conversation_on_inbound) rather than as a read-modify-write of
      // the snapshot loaded above: two inbound messages for the same
      // conversation can process concurrently, and computing `snapshot + 1`
      // in the app let both reads see the same value and write the same
      // increment, losing one (issue #369). The RPC increments in a single
      // UPDATE and refreshes the last-message summary in the same statement.
      supabaseAdmin().rpc('bump_conversation_on_inbound', {
        p_conversation_id: conversation.id,
        p_last_message_text: contentText || `[${message.type}]`,
      }) as Promise<{ error: unknown }>,
      // A customer writing again re-opens the thread (issue #409). Kept as a
      // separate conditional statement rather than a `status` field on the
      // update above so the write can be gated on the row's CURRENT status
      // in SQL — see the helper for why that matters.
      reopenClosedConversation(supabaseAdmin(), conversation),
      // If this contact was a recent broadcast recipient, flag the reply
      // so the broadcast's `replied_count` advances (via the aggregate
      // trigger installed in migration 003).
      flagBroadcastReplyIfAny(accountId, contactRecord.id),
    ])
  setInboundSendGate(bookkeeping.then(() => undefined, () => undefined))
  bookkeeping.then(() => markLatency('bookkeeping_done'), () => {})

  const inboundText = contentText ?? message.text?.body ?? ''
  const optedOutAt = await (optedOutRead ?? readOptedOut())

  // Opt-out / opt-in keywords (STOP, ఆపు, बंद … / START). The keyword
  // message itself never reaches flows, automations or AI, and nothing
  // automated runs for an opted-out contact. A failed opt-out lookup
  // blocks automation rather than risk messaging someone who said stop.
  let automationBlocked = false
  try {
    if (!optedOutAt.ok) throw optedOutAt.error
    const opt = await applyOptKeyword(supabaseAdmin(), {
      accountId,
      contactId: contactRecord.id,
      currentOptedOutAt: optedOutAt.value,
      text: interactiveReplyId ? null : inboundText,
    })
    automationBlocked = opt.optedOut || opt.change !== null
    if (opt.confirmation) {
      await engineSendText({
        accountId,
        userId: configOwnerUserId,
        conversationId: conversation.id,
        contactId: contactRecord.id,
        text: opt.confirmation,
        complianceNotice: true,
      }).catch((err) =>
        console.error('[webhook] opt-out confirmation send failed:', err)
      )
    }
  } catch (err) {
    console.error('[webhook] opt-out check failed; skipping automation:', err)
    automationBlocked = true
  }
  if (!automationBlocked) {
    markInboundRecipientVerified(accountId, {
      contactId: contactRecord.id,
      conversationId: conversation.id,
      contact: {
        id: contactRecord.id,
        phone: contactRecord.phone ?? null,
        wa_user_id: contactRecord.wa_user_id ?? null,
      },
    })
  }

  // ============================================================
  // Flow runner dispatch.
  //
  // If the runner consumes the message (it either advanced an active
  // run or started a new one), we suppress the `new_message_received`
  // + `keyword_match` automation triggers for this inbound. Customer
  // is navigating the bot menu, not sending a fresh trigger word
  // that should fork into automations.
  //
  // The relationship-level triggers (`new_contact_created`,
  // `first_inbound_message`) still fire even when consumed — those
  // are about WHO is messaging, not what they said.
  //
  // Awaited (not fire-and-forget) because we need the `consumed`
  // result before deciding whether to dispatch automations. The
  // runner has its own try/catch and never throws. Accounts with
  // no active flows take the runner's early-exit "no_match" path
  // basically for free (one indexed SELECT for the active run).
  // ============================================================
  const flowResult = automationBlocked
    ? { consumed: false }
    : await dispatchInboundToFlows({
        accountId,
        userId: configOwnerUserId,
        contactId: contactRecord.id,
        conversationId: conversation.id,
        message:
          interactiveReplyId
            ? {
                kind: 'interactive_reply',
                reply_id: interactiveReplyId,
                reply_title: contentText ?? '',
                meta_message_id: message.id,
              }
            : {
                kind: 'text',
                text: inboundText,
                meta_message_id: message.id,
              },
        isFirstInboundMessage: bookkeeping.then(([isFirst]) => isFirst),
        prefetch: flowPrefetch,
        activeFlows,
      })
  const [isFirstInboundMessage, { error: convError }] = await bookkeeping
  if (convError) {
    console.error('Error updating conversation:', convError)
  }
  const flowConsumed = flowResult.consumed

  // Fire any automations that react to this webhook event. All dispatches
  // run here (not earlier) so the contact, conversation, and inbound
  // message all exist before any step — including send_message — runs.
  // Fire-and-forget: a slow or failing automation must not block the
  // webhook's 200 OK response to Meta.

  // An automation parked at a "wait for reply" Send Buttons / Send List
  // step takes this message as its reply — a tap or typed text — and
  // continues from the step after the send. Like a Flow consuming the
  // message, that suppresses the content-level triggers and AI reply
  // below so the customer doesn't get a second bot answering. Runs
  // BEFORE the trigger dispatch so the message that parks a run can
  // never also resume it. Flows still win: only checked if no flow
  // consumed the message. Never throws.
  const automationConsumed = flowConsumed || automationBlocked
    ? false
    : await resumeAwaitingReply({
        accountId,
        contactId: contactRecord.id,
        context: {
          message_text: inboundText,
          conversation_id: conversation.id,
          interactive_reply_id: interactiveReplyId ?? undefined,
        },
      })
  const contentConsumed = flowConsumed || automationConsumed

  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
    | 'interactive_reply'
  )[] = []
  // Content-level triggers are suppressed when a flow or a waiting
  // automation consumed the message — see the comment blocks above.
  if (!contentConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match')
    // Interactive tap → fire the interactive_reply trigger too (only
    // meaningful when a button/list reply actually arrived). Enables
    // automation-only chained menus; when a Flow owns the menu it will
    // have consumed the reply and this is skipped.
    if (interactiveReplyId) {
      automationTriggers.push('interactive_reply')
    }
  }
  // new_contact_created fires only when the webhook just auto-created the
  // contact row. first_inbound_message fires whenever this is the contact's
  // first-ever customer-sent message — a superset that also catches
  // manually-imported contacts sending for the first time. We dispatch both
  // so users can pick whichever semantic they want; an automation that
  // listens to only one trigger runs only when that trigger matches.
  if (contactOutcome.wasCreated) automationTriggers.unshift('new_contact_created')
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message')
  // Awaited — not fire-and-forget. We're inside the route's `after()`
  // block, which only keeps the function alive for promises it can see, so
  // a detached dispatch can be frozen part-way through: the log row is
  // inserted, then the steps never run. That is issue #301's failure mode
  // recurring one level down, and it's what issue #409 reported as runs
  // logging zero steps. `runAutomationsForTrigger` owns its own try/catch
  // and never throws; the `.catch` is belt-and-braces so one trigger
  // type's failure can't skip the rest of the loop.
  for (const triggerType of automationBlocked ? [] : automationTriggers) {
    await runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId: contactRecord.id,
      context: {
        message_text: inboundText,
        conversation_id: conversation.id,
        // Only set on interactive taps; drives the interactive_reply
        // trigger's exact-id match.
        interactive_reply_id: interactiveReplyId ?? undefined,
      },
    }).catch((err) => console.error('[automations] dispatch failed:', err))
  }

  // AI auto-reply. Runs only for plain-text inbound the deterministic
  // flow runner did NOT consume (flows win over the LLM), and only when
  // the account has enabled it. Awaited inside `after()` (same reason as
  // the webhook dispatch below); `dispatchInboundToAiReply` owns its
  // eligibility gates + try/catch and never throws.
  if (!automationBlocked && !contentConsumed && !interactiveReplyId && inboundText.trim()) {
    await dispatchInboundToAiReply({
      accountId,
      conversationId: conversation.id,
      contactId: contactRecord.id,
      configOwnerUserId,
      // Lets the bot show "typing…" (and mark the message read) while
      // the reply is generated.
      inboundMessageId: message.id,
    })
  }

  // message.received webhook (public API). Awaited — not fire-and-forget
  // — because we're inside the route's `after()` block, which only keeps
  // the function alive for promises it can see; a detached promise could
  // be frozen before it delivers. `dispatchWebhookEvent` early-exits
  // when the account has no matching endpoint and never throws.
  // (conversation.created is emitted earlier, right after the thread is
  // opened.)
  await conversationCreatedEvent
  await dispatchWebhookEvent(supabaseAdmin(), accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contactRecord.id,
    whatsapp_message_id: message.id,
    content_type: contentType,
    text: contentText,
  })
}

async function parseMessageContent(
  message: WhatsAppMessage,
  accessToken: string,
  // Tenancy + opt-out for the media mirror. Null disables mirroring
  // entirely, which is what the account-level toggle does.
  mirror: { accountId: string } | null
): Promise<{
  contentText: string | null
  mediaUrl: string | null
  mediaType: string | null
  /**
   * For interactive button / list replies: the stable id of the tapped
   * option (whatever we put on the button when sending). Used by the
   * Flows engine to advance the per-contact run; persisted to
   * `messages.interactive_reply_id` so the inbox bubble can render the
   * tap with the right affordance. Null for everything else.
   */
  interactiveReplyId: string | null
}> {
  // getMediaUrl signature is (mediaId, accessToken) — earlier code had
  // the args swapped, so every verification hit an invalid Meta URL and
  // fell through to the catch block, leaving mediaUrl as null. That's
  // why images showed up as empty bubbles in the inbox.
  //
  // Beyond verifying, this is where inbound media gets COPIED into the
  // `chat-media` bucket (issue #466). Meta deletes media ~30 days after
  // receipt, so the `/api/whatsapp/media/<id>` proxy URL we used to
  // store is a pointer with an expiry date on it — every inbound
  // attachment silently became "Photo unavailable" a month later.
  // Mirroring stores a durable public URL instead.
  //
  // The mirror is strictly best-effort. `mirrorInboundMedia` swallows
  // its own failures and returns null, and we fall back to the proxy
  // URL — a webhook that throws would have Meta retry the delivery and
  // re-run everything downstream, which is a far worse outcome than an
  // attachment that expires.
  const verifyAndBuildUrl = async (
    mediaId: string,
    fileName?: string | null
  ): Promise<string | null> => {
    try {
      const info = await getMediaUrl({ mediaId, accessToken })

      if (mirror) {
        const mirrored = await mirrorInboundMedia({
          storage: supabaseAdmin().storage,
          accountId: mirror.accountId,
          mediaId,
          downloadUrl: info.url,
          accessToken,
          mimeType: info.mimeType,
          fileSize: info.fileSize,
          fileName,
          messageTimestamp: message.timestamp,
        })
        if (mirrored) return mirrored
      }

      return `/api/whatsapp/media/${mediaId}`
    } catch (error) {
      console.error(
        `Failed to verify media ${mediaId} with Meta:`,
        error instanceof Error ? error.message : error
      )
      return null
    }
  }

  // Default shape — each case overrides only the fields it cares about.
  // Keeps the new `interactiveReplyId` field DRY across every return site.
  const empty = {
    contentText: null,
    mediaUrl: null,
    mediaType: null,
    interactiveReplyId: null,
  }

  switch (message.type) {
    case 'text':
      return { ...empty, contentText: message.text?.body || null }

    case 'image':
      if (message.image?.id) {
        return {
          ...empty,
          contentText: message.image.caption || null,
          mediaUrl: await verifyAndBuildUrl(message.image.id),
          mediaType: message.image.mime_type,
        }
      }
      return empty

    case 'video':
      if (message.video?.id) {
        return {
          ...empty,
          contentText: message.video.caption || null,
          mediaUrl: await verifyAndBuildUrl(message.video.id),
          mediaType: message.video.mime_type,
        }
      }
      return empty

    case 'document':
      if (message.document?.id) {
        return {
          ...empty,
          contentText:
            message.document.caption || message.document.filename || null,
          // The sender's own filename becomes the mirrored object's
          // name, so saving the attachment yields `invoice.pdf` even
          // when a caption displaced the filename in content_text.
          mediaUrl: await verifyAndBuildUrl(
            message.document.id,
            message.document.filename
          ),
          mediaType: message.document.mime_type,
        }
      }
      return empty

    case 'audio':
      if (message.audio?.id) {
        return {
          ...empty,
          mediaUrl: await verifyAndBuildUrl(message.audio.id),
          mediaType: message.audio.mime_type,
        }
      }
      return empty

    case 'sticker':
      // Stickers are images under the hood. Treat them as such so the
      // MessageBubble renders the <img>. The caller maps the DB
      // content_type to 'image' for the CHECK constraint.
      if (message.sticker?.id) {
        return {
          ...empty,
          mediaUrl: await verifyAndBuildUrl(message.sticker.id),
          mediaType: message.sticker.mime_type,
        }
      }
      return empty

    case 'location':
      if (message.location) {
        const loc = message.location
        const locationText = [loc.name, loc.address, `${loc.latitude},${loc.longitude}`]
          .filter(Boolean)
          .join(' - ')
        return { ...empty, contentText: locationText }
      }
      return empty

    case 'reaction':
      return { ...empty, contentText: message.reaction?.emoji || null }

    case 'interactive': {
      // The customer tapped a reply button or a list row on a message
      // we previously sent. Meta delivers `interactive.button_reply` for
      // 3-button messages and `interactive.list_reply` for list messages.
      // Use the human-readable title as contentText so the inbox bubble
      // renders the tap legibly ("Existing customer"), and stash the
      // stable id separately so the Flows engine can route on it.
      const reply =
        message.interactive?.button_reply ?? message.interactive?.list_reply
      if (reply?.id) {
        return {
          ...empty,
          contentText: reply.title || reply.id,
          interactiveReplyId: reply.id,
        }
      }
      return { ...empty, contentText: '[Interactive reply]' }
    }

    case 'button': {
      // Quick-reply tap on a TEMPLATE message. Meta delivers these under
      // their own `button` envelope rather than `interactive` above, so
      // without this case they fell through to `default` and landed in
      // the inbox as "[Unsupported message type: button]" with a null
      // interactiveReplyId — which also meant the Flows engine and the
      // `interactive_reply` automation trigger never saw the tap, so
      // nothing chained off a broadcast reply (issue #478).
      //
      // `payload` is the stable value (the analogue of
      // `button_reply.id`); `text` is the visible label. Prefer the
      // payload for routing and the label for display, each falling
      // back to the other since a template may carry only one.
      const payload = message.button?.payload || null
      const label = message.button?.text || null
      return {
        ...empty,
        contentText: label || payload,
        interactiveReplyId: payload || label,
      }
    }

    default:
      return {
        ...empty,
        contentText: `[Unsupported message type: ${message.type}]`,
      }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any

interface ContactOutcome {
  contact: ContactRow
  /** True when this call created the row; drives new_contact_created
   *  automation dispatch in processMessage. */
  wasCreated: boolean
}

/**
 * Look a contact up by BSUID. Exact match on the column backing
 * migration 040's unique index — no fuzzy matching, because a BSUID is
 * an opaque identifier with exactly one correct spelling.
 */
async function findContactByWaUserId(
  accountId: string,
  waUserId: string
): Promise<ContactRow | null> {
  const { data, error } = await supabaseAdmin()
    .from('contacts')
    .select('*')
    .eq('account_id', accountId)
    .eq('wa_user_id', waUserId)
    .maybeSingle()

  if (error) {
    console.error('[webhook] BSUID contact lookup failed:', error.message)
    return null
  }
  return data ?? null
}

/**
 * Fields worth writing back onto a contact we just matched, given what
 * this delivery told us. Returns null when nothing changed, so the
 * common case costs no UPDATE.
 *
 * The BSUID backfill is the important one: it stamps the id onto a
 * contact we have only ever known by phone, so the NEXT message from
 * that person — which may well arrive with no phone number at all —
 * still resolves to this same row instead of forking a new one.
 * Likewise a phone backfill upgrades a BSUID-only contact the moment
 * Meta discloses the number, making them reachable by every existing
 * phone-based code path.
 */
function contactIdentityPatch(
  existing: ContactRow,
  identity: WaIdentity
): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {}

  // Only ever from a label Meta actually supplied. `identityDisplayName`
  // falls back to the phone number / BSUID, which is the right choice
  // for a brand-new row but would clobber an agent's hand-edited name
  // on every inbound message from a contact with no WhatsApp profile
  // name.
  const name = identity.name || identity.waUsername
  if (name && name !== existing.name) patch.name = name

  if (identity.waUserId && identity.waUserId !== existing.wa_user_id) {
    patch.wa_user_id = identity.waUserId
  }
  if (
    identity.waParentUserId &&
    identity.waParentUserId !== existing.wa_parent_user_id
  ) {
    patch.wa_parent_user_id = identity.waParentUserId
  }
  if (identity.waUsername && identity.waUsername !== existing.wa_username) {
    patch.wa_username = identity.waUsername
  }
  // Only ever fills a blank. An existing number is left alone — the
  // send path's variant retry already owns correcting it, and Meta's
  // formatting differences are not a reason to rewrite it.
  if (identity.phone && !normalizePhone(existing.phone ?? '')) {
    patch.phone = identity.phone
  }

  return Object.keys(patch).length > 0 ? patch : null
}

/** Write back identity fields this delivery revealed; the matched row otherwise. */
async function applyIdentityPatch(
  existingContact: ContactRow,
  identity: WaIdentity
): Promise<ContactRow> {
  const patch = contactIdentityPatch(existingContact, identity)
  if (!patch) return existingContact
  const { data: updated, error: updateError } = await supabaseAdmin()
    .from('contacts')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', existingContact.id)
    .select()
    .maybeSingle()

  if (updateError) {
    // A BSUID backfill can lose a race with a concurrent delivery
    // that already claimed it for another row. Not fatal — the
    // message still belongs to the contact we matched.
    console.error(
      '[webhook] contact identity backfill failed:',
      updateError.message
    )
    return existingContact
  }
  return updated ?? existingContact
}

type ConversationRow = Record<string, unknown> & { id: string; contact_id: string }

/**
 * The contact (and its oldest conversation, if any) from
 * resolve_inbound_context, applying the same matching rules as
 * findOrCreateContact. Null when the per-table path must decide —
 * phone candidates that pickBestPhoneMatch rejects, or nothing matched
 * and nothing was created.
 */
async function contactFromContext(
  context: InboundContextResult,
  identity: WaIdentity
): Promise<{
  outcome: ContactOutcome
  conversation: { conversation: ConversationRow; created: boolean } | null
} | null> {
  const contacts = context.contacts as ContactRow[]
  let contact: ContactRow | null = null
  let wasCreated = false
  if (context.matched_by === 'created' && context.contact_created) {
    contact = contacts[0] ?? null
    wasCreated = true
  } else if (context.matched_by === 'wa_user_id') {
    contact = contacts[0] ?? null
  } else if (context.matched_by === 'phone' && identity.phone) {
    contact = pickBestPhoneMatch(contacts, identity.phone)
  }
  if (!contact) return null
  if (!wasCreated) contact = await applyIdentityPatch(contact, identity)

  const conversation = (context.conversations as ConversationRow[]).find(
    (c) => c.contact_id === contact.id
  )
  return {
    outcome: { contact, wasCreated },
    conversation: conversation
      ? { conversation, created: wasCreated && context.conversation_created }
      : null,
  }
}

async function findOrCreateContact(
  accountId: string,
  configOwnerUserId: string,
  identity: WaIdentity
): Promise<ContactOutcome | null> {
  // BSUID first when we have one. It's stable per (user, business
  // portfolio) and, unlike the phone number, Meta will keep sending it
  // — so it's the key that survives a customer adopting a username.
  let existingContact: ContactRow | null = identity.waUserId
    ? await findContactByWaUserId(accountId, identity.waUserId)
    : null

  // Fall back to the phone. The same helper backs the manual contact form
  // and CSV import, so all three paths agree on what "same number"
  // means (issue #212).
  if (!existingContact && identity.phone) {
    existingContact = await findExistingContact(
      supabaseAdmin(),
      accountId,
      identity.phone,
    )
  }

  if (existingContact) {
    return {
      contact: await applyIdentityPatch(existingContact, identity),
      wasCreated: false,
    }
  }

  // Create new contact. account_id is the tenancy column;
  // user_id is the NOT NULL FK audit column (no inbound message
  // has a single "user who created" it — we attribute to the
  // WhatsApp config owner as a stable default).
  //
  // `phone` stays NOT NULL in the schema, so a BSUID-only sender is
  // stored with '' — which migration 022's partial unique index
  // tolerates, and migration 040's BSUID index is what keeps them
  // unique instead.
  const { data: newContact, error: createError } = await supabaseAdmin()
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone: identity.phone,
      name: identityDisplayName(identity),
      wa_user_id: identity.waUserId,
      wa_parent_user_id: identity.waParentUserId,
      wa_username: identity.waUsername,
    })
    .select()
    .single()

  if (createError) {
    // Lost a race: a concurrent inbound delivery (or another path)
    // created this contact between our lookup and insert, and a unique
    // index (022's phone, or 040's BSUID) rejected the duplicate.
    // Re-resolve the existing row instead of dropping the message.
    if (isUniqueViolation(createError)) {
      const raced = identity.waUserId
        ? await findContactByWaUserId(accountId, identity.waUserId)
        : null
      if (raced) return { contact: raced, wasCreated: false }
      if (identity.phone) {
        const racedByPhone = await findExistingContact(
          supabaseAdmin(),
          accountId,
          identity.phone
        )
        if (racedByPhone) return { contact: racedByPhone, wasCreated: false }
      }
    }
    console.error('Error creating contact:', createError)
    return null
  }

  return { contact: newContact, wasCreated: true }
}

async function findOrCreateConversation(
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
  // True when it is already known that no conversation exists: a
  // contact inserted by this delivery, or one resolve_inbound_context
  // just looked up. A concurrent creator is still caught by the unique
  // index in createConversation.
  noExistingConversation = false,
) {
  if (noExistingConversation) {
    return createConversation(accountId, configOwnerUserId, contactId)
  }
  // Look for an existing conversation in this account, oldest-first.
  //
  // We deliberately do NOT use `.single()` here. `.single()` errors on
  // *both* 0 rows and ≥2 rows, and the old code treated any error as
  // "none found" and inserted a new row. So once two conversations
  // existed for a contact (from a race — Meta retries a delivery, or a
  // batch fans out to concurrent runs), every subsequent inbound
  // message errored on the lookup and created yet another conversation,
  // snowballing into a wall of duplicate chats (issue #363).
  //
  // Ordering oldest-first and taking one row makes the lookup resolve to
  // the same canonical survivor the dedup migration (036) keeps, so any
  // pre-existing duplicates converge instead of compounding.
  const { data: existingRows, error: findError } = await supabaseAdmin()
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1)

  if (findError) {
    console.error('Error finding conversation:', findError)
    return null
  }

  if (existingRows && existingRows.length > 0) {
    return { conversation: existingRows[0], created: false }
  }
  return createConversation(accountId, configOwnerUserId, contactId)
}

async function createConversation(
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
) {
  // Create new conversation. Same tenancy + audit split as
  // findOrCreateContact above.
  const { data: newConv, error: createError } = await supabaseAdmin()
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
    })
    .select()
    .single()

  if (createError) {
    // Lost a race: a concurrent inbound delivery created the
    // conversation between our lookup and insert, and the unique index
    // (migration 036) rejected the duplicate. Re-resolve the winning
    // row instead of dropping the message — mirrors findOrCreateContact.
    if (isUniqueViolation(createError)) {
      const { data: raced } = await supabaseAdmin()
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1)
      if (raced && raced.length > 0) {
        return { conversation: raced[0], created: false }
      }
    }
    console.error('Error creating conversation:', createError)
    return null
  }

  return { conversation: newConv, created: true }
}
