import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let storedConfig: Record<string, unknown>
let callerRole = 'owner'
const configUpdates: Record<string, unknown>[] = []
let messageRows: Record<string, Record<string, unknown> | null>

function builder(table: string) {
  const filters: string[] = []
  const result = () => {
    if (table === 'profiles') return { data: { account_id: 'acct-1', account_role: callerRole }, error: null }
    if (table === 'whatsapp_config') return { data: storedConfig, error: null }
    if (table === 'messages') {
      const key = filters.includes('status=failed') ? 'failed' : filters.includes('sender_type=customer') ? 'inbound' : 'outbound'
      return { data: messageRows[key], error: null }
    }
    return { data: null, error: null }
  }
  const b: Record<string, unknown> = {}
  b.select = vi.fn(() => b)
  b.eq = vi.fn((col: string, val: unknown) => {
    filters.push(`${col}=${val}`)
    return b
  })
  for (const m of ['neq', 'order', 'limit']) b[m] = vi.fn(() => b)
  b.update = vi.fn((patch: Record<string, unknown>) => {
    configUpdates.push(patch)
    return { eq: vi.fn(async () => ({ error: null })) }
  })
  b.maybeSingle = vi.fn(async () => result())
  return b
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } }, error: null })) },
    from: vi.fn((table: string) => builder(table)),
  })),
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: vi.fn(() => 'plaintext-token') }))

const meta = vi.hoisted(() => ({
  getPhoneRegistrationStatus: vi.fn(),
  getSubscribedApps: vi.fn(),
  getTokenInfo: vi.fn(),
}))
vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/whatsapp/meta-api')>()),
  ...meta,
}))

import { GET } from './route'
import { MetaApiError } from '@/lib/whatsapp/meta-api'
import { __resetRateLimitForTests } from '@/lib/rate-limit'
import { __resetWebhookHealthForTests, recordWebhookPost } from '@/lib/whatsapp/webhook-health'

afterEach(() => vi.unstubAllEnvs())

beforeEach(() => {
  callerRole = 'owner'
  vi.stubEnv('META_APP_SECRET', '0123456789abcdef0123456789abcdef')
  __resetWebhookHealthForTests()
  meta.getTokenInfo.mockReset()
  meta.getTokenInfo.mockResolvedValue({ type: 'SYSTEM_USER', expires_at: 0, is_valid: true, scopes: [] })
  storedConfig = {
    phone_number_id: '111222333',
    waba_id: '444555666',
    access_token: 'enc-token',
    registered_at: null,
    subscribed_apps_at: '2026-10-17T09:51:59Z',
  }
  configUpdates.length = 0
  messageRows = { inbound: null, outbound: null, failed: null }
  meta.getPhoneRegistrationStatus.mockReset()
  meta.getSubscribedApps.mockReset()
  meta.getSubscribedApps.mockResolvedValue([{ whatsapp_business_api_data: { id: 'app-1' } }])
  __resetRateLimitForTests()
})

describe('GET /api/whatsapp/config/verify-registration', () => {
  it('marks the number registered only when Meta reports CLOUD_API, and records it', async () => {
    meta.getPhoneRegistrationStatus.mockResolvedValue({ platform_type: 'CLOUD_API', status: 'CONNECTED' })
    const json = await (await GET()).json()
    expect(json.live).toBe(true)
    expect(json.checks.registered_with_cloud_api).toBe(true)
    expect(json.phone_status).toEqual({ platform_type: 'CLOUD_API', status: 'CONNECTED' })
    expect(configUpdates).toHaveLength(1)
    expect(configUpdates[0].registered_at).toEqual(expect.any(String))
    expect(json.registered_at).toBe(configUpdates[0].registered_at)
  })

  it('clears a stale local registration when Meta says the number is not on the Cloud API', async () => {
    storedConfig.registered_at = '2026-10-01T00:00:00Z'
    meta.getPhoneRegistrationStatus.mockResolvedValue({ platform_type: 'NOT_APPLICABLE', status: 'PENDING' })
    const json = await (await GET()).json()
    expect(json.live).toBe(false)
    expect(json.checks.registered_with_cloud_api).toBe(false)
    expect(configUpdates).toEqual([{ registered_at: null }])
    expect(json.registered_at).toBeNull()
    expect(json.errors.join(' ')).toMatch(/NOT_APPLICABLE/)
  })

  it('explains an expired token, marks the connection disconnected and leaves the registration untouched', async () => {
    const expired = new MetaApiError('Session has expired', { code: 190, subcode: 463, httpStatus: 401 })
    meta.getPhoneRegistrationStatus.mockRejectedValue(expired)
    meta.getSubscribedApps.mockRejectedValue(expired)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const json = await (await GET()).json()
    expect(json.live).toBe(false)
    expect(json.checks.phone_metadata_ok).toBe(false)
    expect(json.checks.registered_with_cloud_api).toBeNull()
    expect(configUpdates).toHaveLength(1)
    expect(configUpdates[0]).toMatchObject({ status: 'disconnected' })
    expect(configUpdates[0]).not.toHaveProperty('registered_at')
    expect(warn.mock.calls.flat().join(' ')).not.toContain('plaintext-token')
    warn.mockRestore()
    expect(json.errors.join(' ')).toMatch(/expired/i)
    expect(JSON.stringify(json)).not.toContain('plaintext-token')
  })

  it('stays "verification pending" with valid credentials until Meta actually delivers something', async () => {
    meta.getPhoneRegistrationStatus.mockResolvedValue({ platform_type: 'CLOUD_API', status: 'CONNECTED' })
    let json = await (await GET()).json()
    expect(json.health).toEqual({ state: 'verification_pending', reasons: ['no_webhook_delivery_seen'] })

    recordWebhookPost('accepted')
    json = await (await GET()).json()
    expect(json.health.state).toBe('connected')
  })

  it('flags a placeholder app secret as missing configuration', async () => {
    vi.stubEnv('META_APP_SECRET', 'local-dev-0123456789abcdef0123456789abcdef0123456789ab')
    meta.getPhoneRegistrationStatus.mockResolvedValue({ platform_type: 'CLOUD_API', status: 'CONNECTED' })
    const json = await (await GET()).json()
    expect(json.health).toEqual({ state: 'missing_configuration', reasons: ['app_secret_placeholder'] })
    expect(json.errors.join(' ')).toMatch(/placeholder/i)
    expect(json.webhook.app_secret).toBe('placeholder')
    expect(JSON.stringify(json)).not.toContain('local-dev-0123')
  })

  it('reports rejected webhook signatures, but only to admins', async () => {
    meta.getPhoneRegistrationStatus.mockResolvedValue({ platform_type: 'CLOUD_API', status: 'CONNECTED' })
    recordWebhookPost('invalid_signature')
    let json = await (await GET()).json()
    expect(json.health.state).toBe('webhook_delivery_failed')
    expect(json.webhook.last_post.outcome).toBe('invalid_signature')

    callerRole = 'agent'
    json = await (await GET()).json()
    expect(json.webhook).toBeNull()
  })

  it('warns when the access token is short-lived', async () => {
    meta.getPhoneRegistrationStatus.mockResolvedValue({ platform_type: 'CLOUD_API', status: 'CONNECTED' })
    const inAnHour = Math.floor(Date.now() / 1000) + 3600
    meta.getTokenInfo.mockResolvedValue({ type: 'USER', expires_at: inAnHour, is_valid: true, scopes: [] })
    const json = await (await GET()).json()
    expect(json.token).toEqual({ type: 'USER', expires_at: inAnHour, is_valid: true })
    expect(json.errors.join(' ')).toMatch(/expires/i)
  })

  it('reports the CRM\'s own evidence of inbound and outbound traffic', async () => {
    meta.getPhoneRegistrationStatus.mockResolvedValue({ platform_type: 'CLOUD_API', status: 'CONNECTED' })
    messageRows = {
      inbound: { created_at: '2026-10-17T10:00:00Z' },
      outbound: { created_at: '2026-10-17T10:00:02Z', status: 'failed' },
      failed: { created_at: '2026-10-17T10:00:02Z', error_code: 131047, error_title: 'Re-engagement message' },
    }
    const json = await (await GET()).json()
    expect(json.activity).toEqual({
      last_inbound_at: '2026-10-17T10:00:00Z',
      last_outbound_at: '2026-10-17T10:00:02Z',
      last_outbound_status: 'failed',
      last_failure: { at: '2026-10-17T10:00:02Z', code: 131047, title: 'Re-engagement message' },
    })
  })
})
