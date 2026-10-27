import crypto from 'node:crypto'

/**
 * Verify the HMAC-SHA256 signature Meta attaches to webhook POSTs.
 *
 * Meta signs the raw request body with your App Secret and sends the
 * result in the `x-hub-signature-256: sha256=<hex>` header. Without
 * verification, anyone who knows our webhook URL can POST fabricated
 * status updates and drift broadcast counts arbitrarily.
 *
 * Reference:
 *   https://developers.facebook.com/docs/graph-api/webhooks/getting-started#verify-payloads
 *
 * Contract:
 *   `META_APP_SECRET` is **required**. If it's missing we fail closed —
 *   every request is rejected until the operator configures the
 *   secret. A previous version fell open with a warning log, which is
 *   unsafe for a public template: anyone who forgets the env var would
 *   be running a fully spoofable webhook.
 *
 *   It may hold **several** secrets separated by commas (issue #500).
 *   Each Meta App signs with its own secret, so one deployment that
 *   receives webhooks from WABAs living under different Meta Apps needs
 *   to accept any of them. A request is valid when its signature
 *   matches ANY configured secret; each candidate is compared in
 *   constant time. See docs/multi-waba.md.
 */

/**
 * Split `META_APP_SECRET` into its candidate secrets: comma-separated,
 * whitespace trimmed, empties dropped. Exported for tests and for
 * anything else that wants to know how many apps are configured.
 */
export function parseAppSecrets(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter((s) => process.env.NODE_ENV !== 'production' || !isPlaceholderAppSecret(s))
}

const PLACEHOLDER_SECRET = /^(local-dev-|your[-_]|placeholder|changeme|replace[-_]?me|xxx)/i

/**
 * Setup scripts write a `local-dev-…` secret so signed test webhooks can
 * be verified locally. Meta never signs with it, so real deliveries all
 * fail with 401 — production ignores such values (fail closed) and the
 * settings diagnostics flag them.
 */
export function isPlaceholderAppSecret(secret: string): boolean {
  return PLACEHOLDER_SECRET.test(secret.trim())
}

export type AppSecretStatus = 'ok' | 'placeholder' | 'missing'

export function appSecretStatus(raw: string | undefined = process.env.META_APP_SECRET): AppSecretStatus {
  const all = (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (all.length === 0) return 'missing'
  return all.every(isPlaceholderAppSecret) ? 'placeholder' : 'ok'
}

function signatureMatches(rawBody: string, signatureHeader: string, secret: string): boolean {
  const expected =
    'sha256=' +
    crypto.createHmac('sha256', secret).update(rawBody).digest('hex')

  const a = Buffer.from(signatureHeader)
  const b = Buffer.from(expected)
  // Bail if lengths differ — timingSafeEqual throws otherwise.
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

export function verifyMetaWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
): boolean {
  const secrets = parseAppSecrets(process.env.META_APP_SECRET)
  if (secrets.length === 0) {
    console.error(
      '[webhook] META_APP_SECRET is not set — rejecting request. ' +
        'Configure the env var (Meta → App Settings → Basic → App Secret) ' +
        'to enable signature verification.',
    )
    return false
  }

  if (!signatureHeader) return false
  if (!signatureHeader.startsWith('sha256=')) return false

  // Deliberately no early return inside the loop's compare: every
  // candidate is checked with timingSafeEqual, and the loop cost is
  // proportional to the number of configured apps (public knowledge
  // from the operator's point of view), not to the secret contents.
  let ok = false
  for (const secret of secrets) {
    if (signatureMatches(rawBody, signatureHeader, secret)) ok = true
  }
  return ok
}

export function verifyTokenMatches(stored: string, presented: string): boolean {
  const a = crypto.createHash('sha256').update(stored).digest()
  const b = crypto.createHash('sha256').update(presented).digest()
  return crypto.timingSafeEqual(a, b)
}

/**
 * Optional deployment-wide verify token (`WHATSAPP_VERIFY_TOKEN`),
 * accepted in addition to the per-account tokens saved in
 * `whatsapp_config`. Unset or blank never matches.
 */
export function envVerifyTokenMatches(presented: string): boolean {
  const configured = process.env.WHATSAPP_VERIFY_TOKEN?.trim()
  if (!configured) return false
  return verifyTokenMatches(configured, presented)
}
