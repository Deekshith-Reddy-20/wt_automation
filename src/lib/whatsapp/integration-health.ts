import type { AppSecretStatus } from './webhook-signature'
import type { WebhookPostOutcome } from './webhook-health'

export type IntegrationHealthState =
  | 'connected'
  | 'missing_configuration'
  | 'verification_pending'
  | 'webhook_delivery_failed'
  | 'message_send_failed'

export interface IntegrationHealthInput {
  appSecret: AppSecretStatus
  tokenValid: boolean | null
  registeredWithCloudApi: boolean | null
  wabaSubscribed: boolean | null
  lastWebhookOutcome: WebhookPostOutcome | null
  webhookAccepted: boolean
  lastInboundAt: string | null
  lastOutboundStatus: string | null
}

/**
 * One overall state for the WhatsApp integration. "connected" needs
 * every check to pass AND evidence that Meta actually delivered an event
 * (an accepted webhook POST or a stored inbound message) — valid
 * credentials alone only reach "verification_pending".
 */
export function deriveIntegrationHealth(i: IntegrationHealthInput): {
  state: IntegrationHealthState
  reasons: string[]
} {
  const missing: string[] = []
  if (i.appSecret === 'missing') missing.push('app_secret_missing')
  if (i.appSecret === 'placeholder') missing.push('app_secret_placeholder')
  if (i.tokenValid === false) missing.push('access_token_invalid')
  if (i.registeredWithCloudApi === false) missing.push('number_not_registered')
  if (i.wabaSubscribed === false) missing.push('waba_not_subscribed')
  if (missing.length > 0) return { state: 'missing_configuration', reasons: missing }

  if (i.lastWebhookOutcome === 'invalid_signature') {
    return { state: 'webhook_delivery_failed', reasons: ['last_webhook_signature_rejected'] }
  }
  if (i.lastOutboundStatus === 'failed') {
    return { state: 'message_send_failed', reasons: ['last_outbound_failed'] }
  }
  if (!i.webhookAccepted && !i.lastInboundAt) {
    return { state: 'verification_pending', reasons: ['no_webhook_delivery_seen'] }
  }
  return { state: 'connected', reasons: [] }
}
