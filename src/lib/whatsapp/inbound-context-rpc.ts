import type { SupabaseClient } from '@supabase/supabase-js'
import { contactPhoneVariants } from '@/lib/contacts/dedupe'
import type { InboundConfigRow } from '@/lib/whatsapp/config-cache'
import {
  hasUsableIdentity,
  identityDisplayName,
  type WaIdentity,
} from '@/lib/whatsapp/wa-identity'

// ------------------------------------------------------------
// Client for resolve_inbound_context (migration 058): the receiving
// number's config, the sender's contact and its oldest conversation —
// creating both for a new sender — in one round trip.
//
// Optional by design. Until the migration is applied the call fails
// with "function not found"; that is remembered for a while so the
// webhook doesn't pay a wasted round trip per message, and every
// caller falls back to the per-table queries. Any other failure falls
// back for that one message. WHATSAPP_INBOUND_CONTEXT_RPC=0 turns the
// call off entirely.
// ------------------------------------------------------------

export const INBOUND_CONTEXT_RPC = 'resolve_inbound_context'

/** How long a missing function is remembered before trying again. */
const UNAVAILABLE_RETRY_MS = 10 * 60_000

export interface InboundContextResult {
  config: InboundConfigRow[]
  matched_by: 'wa_user_id' | 'phone' | 'created' | null
  contacts: Record<string, unknown>[]
  conversations: Record<string, unknown>[]
  contact_created: boolean
  conversation_created: boolean
}

let unavailableUntil = 0

export function inboundContextRpcEnabled(now = Date.now()): boolean {
  if (process.env.WHATSAPP_INBOUND_CONTEXT_RPC === '0') return false
  return now >= unavailableUntil
}

export function resetInboundContextRpcAvailability(): void {
  unavailableUntil = 0
}

function isMissingFunction(error: { code?: string; message?: string }): boolean {
  return (
    error.code === 'PGRST202' ||
    error.code === '42883' ||
    /could not find the function/i.test(error.message ?? '')
  )
}

function isResult(value: unknown): value is InboundContextResult {
  const v = value as InboundContextResult | null
  return (
    !!v &&
    Array.isArray(v.config) &&
    Array.isArray(v.contacts) &&
    Array.isArray(v.conversations) &&
    typeof v.contact_created === 'boolean' &&
    typeof v.conversation_created === 'boolean'
  )
}

/**
 * One round trip for config + contact + conversation. Returns null when
 * the function is unavailable or failed; the caller then uses the
 * previous queries, so no inbound message is dropped because of it.
 */
export async function resolveInboundContext(
  db: Pick<SupabaseClient, 'rpc'>,
  phoneNumberId: string,
  identity: WaIdentity,
): Promise<InboundContextResult | null> {
  if (!inboundContextRpcEnabled()) return null
  const usable = hasUsableIdentity(identity)
  try {
    const { data, error } = await db.rpc(INBOUND_CONTEXT_RPC, {
      p_phone_number_id: phoneNumberId,
      p_wa_user_id: usable ? identity.waUserId : null,
      p_phone_variants: usable && identity.phone ? contactPhoneVariants(identity.phone) : [],
      // Exactly the fields the webhook inserted itself before.
      p_new_contact: usable
        ? {
            phone: identity.phone,
            name: identityDisplayName(identity),
            wa_user_id: identity.waUserId,
            wa_parent_user_id: identity.waParentUserId,
            wa_username: identity.waUsername,
          }
        : null,
    })
    if (error) {
      if (isMissingFunction(error)) {
        unavailableUntil = Date.now() + UNAVAILABLE_RETRY_MS
        console.info(
          `[webhook] ${INBOUND_CONTEXT_RPC} not installed (migration 058); using per-table lookups`,
        )
      } else {
        console.error(`[webhook] ${INBOUND_CONTEXT_RPC} failed; using per-table lookups:`, error.message)
      }
      return null
    }
    if (!isResult(data)) {
      console.error(`[webhook] ${INBOUND_CONTEXT_RPC} returned an unexpected shape; using per-table lookups`)
      return null
    }
    return data
  } catch (err) {
    console.error(
      `[webhook] ${INBOUND_CONTEXT_RPC} threw; using per-table lookups:`,
      err instanceof Error ? err.message : err,
    )
    return null
  }
}
