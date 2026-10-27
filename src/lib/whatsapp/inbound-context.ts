import { AsyncLocalStorage } from 'node:async_hooks'

// ------------------------------------------------------------
// Request-scoped send credentials for inbound processing.
//
// The webhook has already read (and decrypted) the receiving number's
// whatsapp_config row to route the message. Replies sent while that one
// inbound message is being processed reuse it instead of re-reading the
// same row on every send. The scope is a single inbound message's async
// chain — nothing is retained after it ends or shared across requests,
// and a lookup for any other account falls through to the database.
// ------------------------------------------------------------

export interface InboundSendCredentials {
  accountId: string
  phoneNumberId: string
  accessToken: string
  verifiedRecipient?: VerifiedRecipient
  sendGate?: Promise<void>
}

export interface VerifiedRecipient {
  contactId: string
  conversationId: string
  contact: { id: string; phone: string | null; wa_user_id: string | null }
}

const storage = new AsyncLocalStorage<InboundSendCredentials>()

export function runWithInboundSendCredentials<T>(
  credentials: InboundSendCredentials,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run({ ...credentials }, fn)
}

export function inboundSendCredentialsFor(
  accountId: string,
): { phoneNumberId: string; accessToken: string } | null {
  const scoped = storage.getStore()
  if (!scoped || scoped.accountId !== accountId) return null
  return { phoneNumberId: scoped.phoneNumberId, accessToken: scoped.accessToken }
}

/**
 * Records what this inbound message's processing has just established
 * for its own contact and conversation: the contact row (resolved within
 * the account), that the contact accepts automated messages (opt-out
 * state read and applied for this message), and that the conversation
 * belongs to the account. Only the webhook calls this, after those checks.
 */
export function markInboundRecipientVerified(accountId: string, recipient: VerifiedRecipient): void {
  const scoped = storage.getStore()
  if (scoped && scoped.accountId === accountId) scoped.verifiedRecipient = recipient
}

/**
 * Work that must finish before any automated send for this inbound
 * message reaches Meta (the webhook's bookkeeping writes). Must never
 * reject — the webhook observes the underlying failure itself.
 */
export function setInboundSendGate(gate: Promise<void>): void {
  const scoped = storage.getStore()
  if (scoped) scoped.sendGate = gate
}

export function inboundSendGate(): Promise<void> {
  return storage.getStore()?.sendGate ?? Promise.resolve()
}

/** The verified recipient, only for the exact account + contact + conversation. */
export function inboundVerifiedRecipient(
  accountId: string,
  contactId: string,
  conversationId: string,
): VerifiedRecipient['contact'] | null {
  const scoped = storage.getStore()
  const r = scoped?.verifiedRecipient
  if (!scoped || scoped.accountId !== accountId || !r) return null
  if (r.contactId !== contactId || r.conversationId !== conversationId) return null
  return r.contact
}
