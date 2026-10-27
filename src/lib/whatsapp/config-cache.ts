// ------------------------------------------------------------
// Short-lived cache of the inbound routing config, keyed by the
// receiving phone_number_id.
//
// Every inbound webhook needs the same row before anything else can
// start, so reading it once per message puts a full database round
// trip in front of every reply. This keeps the row for a few seconds.
//
// Invalidation:
//   - in-process on every server-side write (save, disconnect, token
//     re-encryption, token rejected by Meta) — see the callers of
//     invalidateWhatsAppConfigCache;
//   - by TTL everywhere else: other server instances, and the
//     media-mirror toggle, which the settings page writes from the
//     browser. A change is therefore visible to all instances within
//     WHATSAPP_CONFIG_CACHE_TTL_MS (default 30 s; 0 disables).
//
// Only a successful single-row read is cached; errors, a missing row
// and duplicate rows always go to the database. The access token stays
// encrypted in memory. No customer data is ever stored here.
// ------------------------------------------------------------

export interface InboundConfigRow {
  account_id: string
  user_id: string
  phone_number_id: string
  /** Encrypted, exactly as stored. */
  access_token: string
  mirror_inbound_media: boolean | null
}

export const INBOUND_CONFIG_COLUMNS =
  'account_id, user_id, phone_number_id, access_token, mirror_inbound_media'

const DEFAULT_TTL_MS = 30_000

interface Entry {
  row: InboundConfigRow
  expiresAt: number
}

const entries = new Map<string, Entry>()

export function whatsAppConfigCacheTtlMs(): number {
  const raw = process.env.WHATSAPP_CONFIG_CACHE_TTL_MS
  if (raw !== undefined && raw !== '') {
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? n : 0
  }
  // Unit tests swap the config between cases; they opt in explicitly.
  return process.env.VITEST ? 0 : DEFAULT_TTL_MS
}

export function getCachedInboundConfig(
  phoneNumberId: string,
  now = Date.now(),
): InboundConfigRow | null {
  const entry = entries.get(phoneNumberId)
  if (!entry) return null
  if (entry.expiresAt <= now) {
    entries.delete(phoneNumberId)
    return null
  }
  return entry.row
}

export function cacheInboundConfig(row: InboundConfigRow, now = Date.now()): void {
  const ttl = whatsAppConfigCacheTtlMs()
  if (ttl <= 0 || !row.phone_number_id) return
  entries.set(row.phone_number_id, { row, expiresAt: now + ttl })
}

/** Drop cached rows for an account (or everything when no account is given). */
export function invalidateWhatsAppConfigCache(accountId?: string): void {
  if (!accountId) {
    entries.clear()
    return
  }
  for (const [key, entry] of entries) {
    if (entry.row.account_id === accountId) entries.delete(key)
  }
}
