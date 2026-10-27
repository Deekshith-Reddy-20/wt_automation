import { afterEach, describe, expect, it, vi } from 'vitest'

import { deriveIntegrationHealth, type IntegrationHealthInput } from './integration-health'
import { appSecretStatus, isPlaceholderAppSecret, parseAppSecrets, verifyMetaWebhookSignature } from './webhook-signature'
import { __resetWebhookHealthForTests, getWebhookHealth, recordWebhookPost } from './webhook-health'
import crypto from 'node:crypto'

const healthy: IntegrationHealthInput = {
  appSecret: 'ok',
  tokenValid: true,
  registeredWithCloudApi: true,
  wabaSubscribed: true,
  lastWebhookOutcome: 'accepted',
  webhookAccepted: true,
  lastInboundAt: '2026-10-17T10:00:00Z',
  lastOutboundStatus: 'delivered',
}

describe('deriveIntegrationHealth', () => {
  it('is connected only with every check passing and delivery evidence', () => {
    expect(deriveIntegrationHealth(healthy)).toEqual({ state: 'connected', reasons: [] })
    expect(
      deriveIntegrationHealth({ ...healthy, lastWebhookOutcome: null, webhookAccepted: false, lastInboundAt: null }).state,
    ).toBe('verification_pending')
  })

  it('lists every missing piece of configuration', () => {
    expect(
      deriveIntegrationHealth({ ...healthy, appSecret: 'placeholder', tokenValid: false, wabaSubscribed: false }),
    ).toEqual({
      state: 'missing_configuration',
      reasons: ['app_secret_placeholder', 'access_token_invalid', 'waba_not_subscribed'],
    })
  })

  it('reports rejected webhooks and failed sends', () => {
    expect(deriveIntegrationHealth({ ...healthy, lastWebhookOutcome: 'invalid_signature' }).state).toBe(
      'webhook_delivery_failed',
    )
    expect(deriveIntegrationHealth({ ...healthy, lastOutboundStatus: 'failed' }).state).toBe('message_send_failed')
  })
})

describe('app secret placeholders', () => {
  afterEach(() => vi.unstubAllEnvs())
  const placeholder = 'local-dev-0123456789abcdef0123456789abcdef0123456789ab'
  const sign = (body: string, secret: string) =>
    'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')

  it('recognises setup placeholders but not real 32-hex secrets', () => {
    expect(isPlaceholderAppSecret(placeholder)).toBe(true)
    expect(isPlaceholderAppSecret('your-app-secret')).toBe(true)
    expect(isPlaceholderAppSecret('0123456789abcdef0123456789abcdef')).toBe(false)
    expect(appSecretStatus('')).toBe('missing')
    expect(appSecretStatus(placeholder)).toBe('placeholder')
    expect(appSecretStatus(`${placeholder},0123456789abcdef0123456789abcdef`)).toBe('ok')
  })

  it('never accepts a placeholder-signed request in production', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('META_APP_SECRET', placeholder)
    expect(parseAppSecrets(placeholder)).toEqual([])
    expect(verifyMetaWebhookSignature('{}', sign('{}', placeholder))).toBe(false)
  })

  it('still verifies locally signed test webhooks in development', () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('META_APP_SECRET', placeholder)
    expect(verifyMetaWebhookSignature('{}', sign('{}', placeholder))).toBe(true)
    expect(verifyMetaWebhookSignature('{}', sign('{}', 'another-secret'))).toBe(false)
  })
})

describe('webhook health record', () => {
  it('tracks the latest outcome and the last accepted delivery', () => {
    __resetWebhookHealthForTests()
    recordWebhookPost('accepted', new Date('2026-10-17T10:00:00Z'))
    recordWebhookPost('invalid_signature', new Date('2026-10-17T10:05:00Z'))
    const h = getWebhookHealth()
    expect(h.last_post).toEqual({ at: '2026-10-17T10:05:00.000Z', outcome: 'invalid_signature' })
    expect(h.last_accepted_at).toBe('2026-10-17T10:00:00.000Z')
    expect(h.counts).toMatchObject({ accepted: 1, invalid_signature: 1 })
  })
})
