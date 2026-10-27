/**
 * The one number a "Send test message" may go to. Set server-side in
 * WHATSAPP_TEST_RECIPIENT (international format, digits only or with a
 * leading +) — never taken from the request, so the button can't be
 * pointed at an arbitrary contact.
 */
export function resolveTestRecipient(raw: string | undefined): string | null {
  if (!raw) return null
  const digits = raw.trim().replace(/^\+/, '')
  return /^[1-9]\d{7,14}$/.test(digits) ? digits : null
}

export function maskRecipient(digits: string): string {
  return `+${'•'.repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`
}

/**
 * Meta pre-approves `hello_world` (en_US) on every WhatsApp Business
 * Account, so it is the only message that can open a conversation
 * with the test recipient without depending on our own templates.
 */
export const TEST_TEMPLATE = { name: 'hello_world', language: 'en_US' } as const
