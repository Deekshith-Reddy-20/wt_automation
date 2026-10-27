import {
  isMetaSendSimulated,
  sendInteractiveButtons,
  sendInteractiveList,
  sendMediaMessage,
  sendTextMessage,
  type InteractiveButton,
  type InteractiveListSection,
  type MediaKind,
} from '@/lib/whatsapp/meta-api'
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  inboundSendCredentialsFor,
  inboundSendGate,
  inboundVerifiedRecipient,
} from '@/lib/whatsapp/inbound-context'
import { markTokenRejected } from '@/lib/whatsapp/token-health'
import {
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'
import { resolveContactSendTarget } from '@/lib/whatsapp/wa-identity'
import { assertConversationInAccount } from '@/lib/whatsapp/conversation-scope'
import { supabaseAdmin } from './admin-client'
import { getT } from '@/lib/i18n/translate'
import { assertContactAcceptsAutomation } from '@/lib/contacts/opt-out'

const t = getT('LibErrors')

// ------------------------------------------------------------
// Flows-side Meta sender (interactive variants).
//
// Mirrors src/lib/automations/meta-send.ts (engineSendText /
// engineSendTemplate) but emits interactive button + list messages.
// Kept separate from the automations file so the two engines don't
// fight over each other's shape — once both stabilize, the
// phone-variant retry + DB persistence are obvious extraction
// candidates into a shared base.
//
// PR #1 ships this in isolation: callers don't exist yet. PR #2
// brings the flow runner online and wires it up. Shipping it now
// keeps the foundation PR self-contained and unit-testable.
// ------------------------------------------------------------

/**
 * Resolve the account's Meta sending credentials: the phone number id
 * plus the DECRYPTED access token from `whatsapp_config`. The single
 * home for that decrypt step — callers outside this file (the AI
 * auto-reply's typing indicator) reuse it rather than growing a copy.
 */
export async function loadAccountMetaCredentials(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
): Promise<{ phoneNumberId: string; accessToken: string }> {
  // Test runs never reach Meta, so the stored token is not decrypted.
  if (isMetaSendSimulated()) {
    return { phoneNumberId: 'SIMULATED', accessToken: 'SIMULATED' }
  }
  const scoped = inboundSendCredentialsFor(accountId)
  if (scoped) return scoped
  const { data: config, error: configErr } = await db
    .from('whatsapp_config')
    .select('phone_number_id, access_token')
    .eq('account_id', accountId)
    .single()
  if (configErr || !config) {
    throw new Error(t('send.notConfigured'))
  }
  return {
    phoneNumberId: config.phone_number_id,
    accessToken: decrypt(config.access_token),
  }
}

interface ContactSendRow {
  id: string
  phone: string | null
  wa_user_id: string | null
}

/**
 * Everything a flow send must establish before calling Meta: the contact
 * (scoped to the account), that it accepts automated messages, that the
 * conversation belongs to the account, where to send, and the account's
 * credentials. The lookups are independent, so they run as one parallel
 * round trip; failures are then reported in the same precedence as when
 * they ran one after another, so callers see identical errors.
 */
async function loadSendPreconditions(
  db: ReturnType<typeof supabaseAdmin>,
  args: {
    accountId: string
    contactId: string
    conversationId: string
    complianceNotice?: boolean
  },
) {
  await inboundSendGate()
  // Within one inbound message the webhook has already verified this
  // exact contact + conversation; see markInboundRecipientVerified.
  const verified = inboundVerifiedRecipient(args.accountId, args.contactId, args.conversationId)
  if (verified) {
    const sendTarget = resolveContactSendTarget(verified)
    if (!sendTarget) {
      throw new Error(t('send.noWhatsAppAddress', { phone: verified.phone || t('send.none') }))
    }
    return { contact: verified, sendTarget, ...(await loadAccountMetaCredentials(db, args.accountId)) }
  }

  const [contactRes, optOut, scope, credentials] = await Promise.allSettled([
    db
      .from('contacts')
      .select('id, phone, wa_user_id')
      .eq('id', args.contactId)
      .eq('account_id', args.accountId)
      .maybeSingle(),
    args.complianceNotice
      ? Promise.resolve()
      : assertContactAcceptsAutomation(db, args.accountId, args.contactId),
    // Same for the conversation the message lands in — see
    // conversation-scope.ts (GHSA-m4fx-g6pr-hrw8).
    assertConversationInAccount(db, args.conversationId, args.accountId),
    loadAccountMetaCredentials(db, args.accountId),
  ])

  const contact =
    contactRes.status === 'fulfilled' && !contactRes.value.error
      ? (contactRes.value.data as ContactSendRow | null)
      : null
  if (!contact) {
    throw new Error(t('send.contactNotFound'))
  }
  if (optOut.status === 'rejected') throw optOut.reason
  if (scope.status === 'rejected') throw scope.reason

  // Phone number, or the business-scoped user ID when Meta has never
  // given us a number for this customer (issue #519).
  const sendTarget = resolveContactSendTarget(contact)
  if (!sendTarget) {
    throw new Error(
      t('send.noWhatsAppAddress', { phone: contact.phone || t('send.none') })
    )
  }
  if (credentials.status === 'rejected') throw credentials.reason

  return { contact, sendTarget, ...credentials.value }
}

export interface EngineSendResult {
  whatsapp_message_id: string
  /** messages.id of the stored outbound row. */
  message_row_id?: string | null
}

interface SendTextEngineArgs {
  /** Account-level tenancy key. Drives contact + whatsapp_config
   *  lookups so a flow authored by user A still sends through the
   *  WhatsApp number user B saved on the same account. */
  accountId: string
  /** Original author of the flow — used for INSERT audit columns
   *  and for resolving the agent's identity in logs. Not consulted
   *  for tenancy. */
  userId: string
  conversationId: string
  contactId: string
  text: string
  /** Marks the persisted message row `ai_generated = true` so the inbox
   *  badges it as an AI reply. Only the auto-reply bot sets this;
   *  deterministic Flow/automation sends leave it false. */
  aiGenerated?: boolean
  /** Opt-out / opt-in acknowledgement: the one automated message an
   *  opted-out contact may still receive. */
  complianceNotice?: boolean
}

/**
 * Send a plain-text WhatsApp message from the Flows engine.
 *
 * Used by the runner's `send_message` and `collect_input` nodes —
 * both prompt the customer with text and either auto-advance (the
 * send_message case) or suspend awaiting a text reply (collect_input).
 *
 * Wraps the same phone-variant retry + DB persistence pattern as the
 * interactive senders; the duplication will be DRY'd into a shared
 * `engineSendBase` once the v2 features (templates with variables,
 * media sends) settle.
 */
export async function engineSendText(
  args: SendTextEngineArgs,
): Promise<EngineSendResult> {
  const db = supabaseAdmin()

  const { contact, sendTarget, phoneNumberId, accessToken } =
    await loadSendPreconditions(db, args)
  const sanitized = sendTarget.target

  const attempt = async (phone: string): Promise<string> => {
    const r = await sendTextMessage({
      phoneNumberId,
      accessToken,
      to: phone,
      text: args.text,
    })
    return r.messageId
  }

  const variants = sendTarget.isPhone ? phoneVariants(sanitized) : [sanitized]
  let workingPhone = sanitized
  let waMessageId = ''
  let lastError: unknown = null
  for (const v of variants) {
    try {
      waMessageId = await attempt(v)
      workingPhone = v
      lastError = null
      break
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!isRecipientNotAllowedError(msg)) {
        await markTokenRejected(db, args.accountId, err, 'flow send')
        throw err
      }
      lastError = err
    }
  }
  if (lastError) throw lastError

  if (sendTarget.isPhone && workingPhone !== sanitized) {
    await db.from('contacts').update({ phone: workingPhone }).eq('id', contact.id)
  }

  const message_row_id = await persistBotMessage(db, args, args.text, {
    content_type: 'text',
    content_text: args.text,
    message_id: waMessageId,
    ai_generated: args.aiGenerated ?? false,
  })
  return { whatsapp_message_id: waMessageId, message_row_id }
}

/**
 * Store a message Meta has accepted and refresh the conversation preview.
 * The two writes touch different rows, so they share one round trip.
 * Returns the new messages.id.
 */
async function persistBotMessage(
  db: ReturnType<typeof supabaseAdmin>,
  target: { accountId: string; conversationId: string },
  preview: string,
  row: Record<string, unknown>,
): Promise<string | null> {
  const now = new Date().toISOString()
  const [inserted] = await Promise.all([
    db
      .from('messages')
      .insert({ conversation_id: target.conversationId, sender_type: 'bot', status: 'sent', ...row })
      .select('id')
      .single(),
    db
      .from('conversations')
      .update({ last_message_text: preview, last_message_at: now, updated_at: now })
      .eq('id', target.conversationId)
      .eq('account_id', target.accountId),
  ])
  if (inserted.error) {
    throw new Error(t('send.dbInsertFailed', { message: inserted.error.message }))
  }
  return (inserted.data as { id: string } | null)?.id ?? null
}

interface SendMediaEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  kind: MediaKind
  /** Public URL Meta fetches at send time. */
  link: string
  caption?: string
  /** Document-only; ignored by Meta for image/video. */
  filename?: string
}

/**
 * Send an image / video / document from the Flows engine.
 *
 * Used by the runner's `send_media` node. Auto-advances after the
 * send lands (same suspend semantics as send_message). Same
 * phone-variant retry + DB persistence as the text/interactive
 * senders; persists the outgoing message with `content_type` matching
 * the media kind so the inbox renders the right preview.
 */
export async function engineSendMedia(
  args: SendMediaEngineArgs,
): Promise<EngineSendResult> {
  const db = supabaseAdmin()

  const { contact, sendTarget, phoneNumberId, accessToken } =
    await loadSendPreconditions(db, args)
  const sanitized = sendTarget.target

  const attempt = async (phone: string): Promise<string> => {
    const r = await sendMediaMessage({
      phoneNumberId,
      accessToken,
      to: phone,
      kind: args.kind,
      link: args.link,
      caption: args.caption,
      filename: args.filename,
    })
    return r.messageId
  }

  const variants = sendTarget.isPhone ? phoneVariants(sanitized) : [sanitized]
  let workingPhone = sanitized
  let waMessageId = ''
  let lastError: unknown = null
  for (const v of variants) {
    try {
      waMessageId = await attempt(v)
      workingPhone = v
      lastError = null
      break
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!isRecipientNotAllowedError(msg)) {
        await markTokenRejected(db, args.accountId, err, 'flow send')
        throw err
      }
      lastError = err
    }
  }
  if (lastError) throw lastError

  if (sendTarget.isPhone && workingPhone !== sanitized) {
    await db.from('contacts').update({ phone: workingPhone }).eq('id', contact.id)
  }

  // content_type='image'|'video'|'document' — these are already in the
  // messages_content_type_check constraint (migration 001 + 010).
  // content_text carries the caption (or empty) so the conversation
  // list preview shows something meaningful when the user glances at it.
  const preview = args.caption?.trim() || `[${args.kind}]`
  const message_row_id = await persistBotMessage(db, args, preview, {
    content_type: args.kind,
    content_text: args.caption ?? null,
    message_id: waMessageId,
  })
  return { whatsapp_message_id: waMessageId, message_row_id }
}

interface SendInteractiveButtonsEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  bodyText: string
  buttons: InteractiveButton[]
  headerText?: string
  footerText?: string
}

interface SendInteractiveListEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  bodyText: string
  buttonLabel: string
  sections: InteractiveListSection[]
  headerText?: string
  footerText?: string
}

/**
 * Send an interactive-button WhatsApp message from the Flows engine.
 *
 * Persists the outgoing message to `messages` with
 * `content_type='interactive'` and `sender_type='bot'` so the inbox
 * surfaces it with the "Button reply" affordance and the conversation
 * thread reflects the bot's prompt.
 *
 * Returns the Meta message id so the caller (engine) can stash it on
 * the `flow_runs.last_prompt_message_id` field for later reference.
 */
export async function engineSendInteractiveButtons(
  args: SendInteractiveButtonsEngineArgs,
): Promise<EngineSendResult> {
  return sendInteractiveViaMeta({ ...args, kind: 'buttons' })
}

/**
 * Send an interactive-list WhatsApp message from the Flows engine.
 * Used when the flow needs more than 3 options (Meta's button cap).
 */
export async function engineSendInteractiveList(
  args: SendInteractiveListEngineArgs,
): Promise<EngineSendResult> {
  return sendInteractiveViaMeta({ ...args, kind: 'list' })
}

type SendInput =
  | (SendInteractiveButtonsEngineArgs & { kind: 'buttons' })
  | (SendInteractiveListEngineArgs & { kind: 'list' })

async function sendInteractiveViaMeta(
  input: SendInput,
): Promise<EngineSendResult> {
  const db = supabaseAdmin()

  // Scope the contact + whatsapp_config lookups by account_id —
  // same defense-in-depth rationale as automations/meta-send.ts.
  // Migration 017 moved both tables to account-scoped tenancy.
  const { contact, sendTarget, phoneNumberId, accessToken } =
    await loadSendPreconditions(db, {
      accountId: input.accountId,
      contactId: input.contactId,
      conversationId: input.conversationId,
    })
  const sanitized = sendTarget.target

  const attempt = async (phone: string): Promise<string> => {
    if (input.kind === 'buttons') {
      const r = await sendInteractiveButtons({
        phoneNumberId,
        accessToken,
        to: phone,
        bodyText: input.bodyText,
        buttons: input.buttons,
        headerText: input.headerText,
        footerText: input.footerText,
      })
      return r.messageId
    }
    const r = await sendInteractiveList({
      phoneNumberId,
      accessToken,
      to: phone,
      bodyText: input.bodyText,
      buttonLabel: input.buttonLabel,
      sections: input.sections,
      headerText: input.headerText,
      footerText: input.footerText,
    })
    return r.messageId
  }

  // Same phone-variant retry as automations/meta-send.ts. Numbers
  // registered with/without a trunk 0 + Meta's sandbox quirks all
  // need this to reliably land a message.
  const variants = sendTarget.isPhone ? phoneVariants(sanitized) : [sanitized]
  let workingPhone = sanitized
  let waMessageId = ''
  let lastError: unknown = null
  for (const v of variants) {
    try {
      waMessageId = await attempt(v)
      workingPhone = v
      lastError = null
      break
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!isRecipientNotAllowedError(msg)) {
        await markTokenRejected(db, input.accountId, err, 'flow send')
        throw err
      }
      lastError = err
    }
  }
  if (lastError) throw lastError

  if (sendTarget.isPhone && workingPhone !== sanitized) {
    await db.from('contacts').update({ phone: workingPhone }).eq('id', contact.id)
  }

  // Persist the bot's prompt to the messages table so it appears in
  // the inbox. content_type='interactive' is supported as of
  // migration 010; sender_type='bot' distinguishes flow sends from
  // manual agent sends (the conversation list preview will pick up
  // last_message_text as a sensible summary).
  //
  // We do NOT set interactive_reply_id here — that column is reserved
  // for the customer's tap on this message, populated by the webhook
  // when their reply arrives. We DO persist the structured payload so
  // the inbox thread re-renders the buttons/rows the bot sent (round-
  // trip), matching the composer + automation send paths.
  const interactivePayload: InteractiveMessagePayload =
    input.kind === 'buttons'
      ? {
          kind: 'buttons',
          body: input.bodyText,
          header: input.headerText,
          footer: input.footerText,
          buttons: input.buttons,
        }
      : {
          kind: 'list',
          body: input.bodyText,
          header: input.headerText,
          footer: input.footerText,
          button_label: input.buttonLabel,
          sections: input.sections,
        }

  const message_row_id = await persistBotMessage(db, input, input.bodyText, {
    content_type: 'interactive',
    content_text: input.bodyText,
    interactive_payload: interactivePayload,
    message_id: waMessageId,
  })
  return { whatsapp_message_id: waMessageId, message_row_id }
}
