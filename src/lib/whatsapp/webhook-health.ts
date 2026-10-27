/**
 * Last webhook POST this server process saw, for the settings
 * diagnostics. In memory on purpose: rejected requests can't be tied to
 * an account (they're unauthenticated), and this only has to answer
 * "has Meta reached this server, and did we accept it?". Resets on
 * restart and is per instance.
 */

export type WebhookPostOutcome = 'accepted' | 'invalid_signature' | 'invalid_json' | 'too_large'

export interface WebhookHealth {
  since: string
  last_post: { at: string; outcome: WebhookPostOutcome } | null
  last_accepted_at: string | null
  counts: Record<WebhookPostOutcome, number>
}

const state: WebhookHealth = {
  since: new Date().toISOString(),
  last_post: null,
  last_accepted_at: null,
  counts: { accepted: 0, invalid_signature: 0, invalid_json: 0, too_large: 0 },
}

export function recordWebhookPost(outcome: WebhookPostOutcome, now: Date = new Date()): void {
  const at = now.toISOString()
  state.last_post = { at, outcome }
  state.counts[outcome] += 1
  if (outcome === 'accepted') state.last_accepted_at = at
}

export function getWebhookHealth(): WebhookHealth {
  return { ...state, counts: { ...state.counts } }
}

export function __resetWebhookHealthForTests(): void {
  state.since = new Date().toISOString()
  state.last_post = null
  state.last_accepted_at = null
  state.counts = { accepted: 0, invalid_signature: 0, invalid_json: 0, too_large: 0 }
}
