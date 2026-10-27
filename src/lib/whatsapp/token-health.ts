import type { SupabaseClient } from '@supabase/supabase-js'

import type { MetaApiError, MetaTokenInfo } from './meta-api'
import { invalidateWhatsAppConfigCache } from './config-cache'

/**
 * Graph error codes meaning the access token itself is unusable: 190
 * (expired — subcode 463 — revoked, password changed, app removed) and
 * 102 (session invalid). Retrying with the same token can never succeed.
 */
const AUTH_ERROR_CODES = new Set([190, 102])

// Matched by name, not instanceof, so callers whose tests mock meta-api
// still classify errors correctly.
export function isMetaAuthError(err: unknown): err is MetaApiError {
  if (!(err instanceof Error) || err.name !== 'MetaApiError') return false
  const code = (err as MetaApiError).code
  return typeof code === 'number' && AUTH_ERROR_CODES.has(code)
}

const SHORT_LIVED_MS = 7 * 24 * 60 * 60 * 1000

export interface TokenLifetime {
  /** SYSTEM_USER tokens are the long-lived kind Meta recommends for servers. */
  kind: 'system_user' | 'user' | 'other' | 'unknown'
  /** ISO timestamp; null when Meta reports no expiry or did not say. */
  expiresAt: string | null
  neverExpires: boolean
  /** A user token, or any token expiring within 7 days. */
  shortLived: boolean
}

export function describeTokenLifetime(info: MetaTokenInfo | null, now = Date.now()): TokenLifetime {
  if (!info) return { kind: 'unknown', expiresAt: null, neverExpires: false, shortLived: false }
  const kind =
    info.type === 'SYSTEM_USER' ? 'system_user' : info.type === 'USER' ? 'user' : info.type ? 'other' : 'unknown'
  const neverExpires = info.expires_at === 0
  const expiresAtMs = info.expires_at ? info.expires_at * 1000 : null
  return {
    kind,
    expiresAt: expiresAtMs ? new Date(expiresAtMs).toISOString() : null,
    neverExpires,
    shortLived: kind === 'user' || (expiresAtMs !== null && expiresAtMs - now < SHORT_LIVED_MS),
  }
}

/**
 * When Meta rejects the stored token, flip the account's connection to
 * `disconnected` so Settings and the Inbox say so instead of showing a
 * stale "connected". Logs the error code only — never the token. Returns
 * true when `err` was an auth error.
 */
export async function markTokenRejected(
  db: SupabaseClient,
  accountId: string,
  err: unknown,
  source: string,
): Promise<boolean> {
  if (!isMetaAuthError(err)) return false
  invalidateWhatsAppConfigCache(accountId)
  console.warn(
    `[whatsapp] Meta rejected the access token (code ${err.code}/${err.subcode ?? '-'}) during ${source}; ` +
      'marking the connection disconnected. Save a new token in Settings → WhatsApp.',
  )
  try {
    const { error } = await db
      .from('whatsapp_config')
      .update({ status: 'disconnected', updated_at: new Date().toISOString() })
      .eq('account_id', accountId)
      .eq('status', 'connected')
    if (error) console.error('[whatsapp] could not record the rejected token:', error.message)
  } catch (e) {
    console.error('[whatsapp] could not record the rejected token:', e instanceof Error ? e.message : e)
  }
  return true
}
