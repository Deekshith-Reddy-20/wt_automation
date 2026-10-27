import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * WhatsApp opt-out ("STOP") handling.
 *
 * A customer who sends one of OPT_OUT_KEYWORDS as their whole message
 * gets `contacts.opted_out_at` set (migration 055). From then on every
 * automated sender — flows, automations, AI auto-reply — refuses to
 * message them (`assertAutomatedSendAllowed`) and broadcasts skip them.
 * Agents can still reply by hand. Sending an OPT_IN keyword clears it.
 *
 * Matching is whole-message only (after normalisation) so "stop the
 * installation next week" is a normal message, not an opt-out.
 */

export const OPT_OUT_KEYWORDS = [
  'stop',
  'stop all',
  'unsubscribe',
  'opt out',
  'optout',
  'cancel messages',
  'ఆపు',
  'ఆపండి',
  'సందేశాలు ఆపండి',
  'बंद',
  'बंद करो',
  'बंद करें',
  'रोकें',
  'मैसेज बंद करें',
] as const

export const OPT_IN_KEYWORDS = ['start', 'unstop', 'subscribe', 'opt in', 'optin'] as const

export function normalizeKeyword(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, ' ')
    .trim()
}

const OPT_OUT_SET = new Set(OPT_OUT_KEYWORDS.map(normalizeKeyword))
const OPT_IN_SET = new Set(OPT_IN_KEYWORDS.map(normalizeKeyword))

export function classifyOptKeyword(text: string | null | undefined): 'opt_out' | 'opt_in' | null {
  if (!text) return null
  const normalized = normalizeKeyword(text)
  if (!normalized) return null
  if (OPT_OUT_SET.has(normalized)) return 'opt_out'
  if (OPT_IN_SET.has(normalized)) return 'opt_in'
  return null
}

export class ContactOptedOutError extends Error {
  constructor() {
    super('Contact has opted out of automated WhatsApp messages')
    this.name = 'ContactOptedOutError'
  }
}

/** Throws when an automated sender targets an opted-out contact. */
export function assertAutomatedSendAllowed(contact: { opted_out_at?: string | null }): void {
  if (contact.opted_out_at) throw new ContactOptedOutError()
}

// Postgres "undefined column" / PostgREST "column not in schema cache".
const MISSING_COLUMN_CODES = new Set(['42703', 'PGRST204'])

/**
 * Reads `contacts.opted_out_at`. Before migration 055 is applied the
 * column doesn't exist and nobody can have opted out, so that case
 * reads as null; any other lookup failure throws (fail closed).
 */
export async function loadOptedOutAt(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
): Promise<string | null> {
  const { data, error } = await db
    .from('contacts')
    .select('opted_out_at')
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) {
    if (error.code && MISSING_COLUMN_CODES.has(error.code)) return null
    throw new Error(`Opt-out lookup failed: ${error.message}`)
  }
  return (data as { opted_out_at?: string | null } | null)?.opted_out_at ?? null
}

export async function assertContactAcceptsAutomation(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
): Promise<void> {
  assertAutomatedSendAllowed({ opted_out_at: await loadOptedOutAt(db, accountId, contactId) })
}

export const OPT_OUT_CONFIRMATION =
  'ఇకపై మీకు మా నుంచి ఆటోమేటిక్ మెసేజ్‌లు రావు. మళ్ళీ కావాలంటే START అని పంపండి.\n' +
  'You will not get automated messages from us anymore. Reply START to subscribe again.\n' +
  'अब आपको हमारी तरफ़ से ऑटोमैटिक मैसेज नहीं आएंगे। फिर से पाने के लिए START भेजें।'

export const OPT_IN_CONFIRMATION =
  'మీరు మళ్ళీ సబ్‌స్క్రైబ్ అయ్యారు. ఆప్షన్లు చూడటానికి ఎప్పుడైనా "menu" అని పంపండి.\n' +
  'You are subscribed again. Send "menu" anytime to see the options.\n' +
  'आप फिर से सब्सक्राइब हो गए हैं। ऑप्शन देखने के लिए कभी भी "menu" भेजें।'

export interface OptKeywordOutcome {
  /** What this message changed, if anything. */
  change: 'opted_out' | 'opted_in' | null
  /** Opt-out state after this message — gates automated dispatch. */
  optedOut: boolean
  /** Confirmation to send the customer, when the state changed. */
  confirmation: string | null
}

/**
 * Apply an opt-out / opt-in keyword for an inbound message. Opting out
 * also ends the contact's active flow runs and pending / awaiting-reply
 * automation executions so nothing already queued fires afterwards.
 */
export async function applyOptKeyword(
  db: SupabaseClient,
  args: {
    accountId: string
    contactId: string
    currentOptedOutAt: string | null | undefined
    text: string | null | undefined
  },
): Promise<OptKeywordOutcome> {
  const wasOptedOut = Boolean(args.currentOptedOutAt)
  const keyword = classifyOptKeyword(args.text)
  const now = new Date().toISOString()

  if (keyword === 'opt_out' && !wasOptedOut) {
    const { error } = await db
      .from('contacts')
      .update({ opted_out_at: now, updated_at: now })
      .eq('id', args.contactId)
      .eq('account_id', args.accountId)
    if (error) {
      console.error('[opt-out] could not record opt-out:', error.message)
      return { change: null, optedOut: wasOptedOut, confirmation: null }
    }
    await db
      .from('flow_runs')
      .update({ status: 'cancelled', ended_at: now, end_reason: 'contact_opted_out' })
      .eq('account_id', args.accountId)
      .eq('contact_id', args.contactId)
      .eq('status', 'active')
    await db
      .from('automation_pending_executions')
      .update({ status: 'expired' })
      .eq('account_id', args.accountId)
      .eq('contact_id', args.contactId)
      .in('status', ['pending', 'awaiting_reply'])
    return { change: 'opted_out', optedOut: true, confirmation: OPT_OUT_CONFIRMATION }
  }

  if (keyword === 'opt_in' && wasOptedOut) {
    const { error } = await db
      .from('contacts')
      .update({ opted_out_at: null, updated_at: now })
      .eq('id', args.contactId)
      .eq('account_id', args.accountId)
    if (error) {
      console.error('[opt-out] could not record opt-in:', error.message)
      return { change: null, optedOut: wasOptedOut, confirmation: null }
    }
    return { change: 'opted_in', optedOut: false, confirmation: OPT_IN_CONFIRMATION }
  }

  return { change: null, optedOut: wasOptedOut, confirmation: null }
}
