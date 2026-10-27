import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let callerRole = 'admin'
let storedConfig: Record<string, unknown> | null = {
  phone_number_id: '111222333',
  waba_id: '444555666',
  access_token: 'enc-token',
}

function builder(table: string) {
  const result = () =>
    table === 'profiles'
      ? { data: { account_id: 'acct-1', account_role: callerRole }, error: null }
      : table === 'accounts'
        ? { data: { id: 'acct-1', name: 'Suraj Solar' }, error: null }
        : table === 'whatsapp_config'
        ? { data: storedConfig, error: null }
        : { data: null, error: null }
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq']) b[m] = vi.fn(() => b)
  b.single = vi.fn(async () => result())
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

const send = vi.hoisted(() => ({ sendTemplateMessage: vi.fn() }))
vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/whatsapp/meta-api')>()),
  sendTemplateMessage: send.sendTemplateMessage,
}))

import { GET, POST } from './route'
import { MetaApiError } from '@/lib/whatsapp/meta-api'
import { __resetRateLimitForTests } from '@/lib/rate-limit'

const post = (body: unknown) =>
  POST(
    new Request('http://localhost/api/whatsapp/config/test-message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

beforeEach(() => {
  callerRole = 'admin'
  storedConfig = { phone_number_id: '111222333', waba_id: '444555666', access_token: 'enc-token' }
  send.sendTemplateMessage.mockReset()
  send.sendTemplateMessage.mockResolvedValue({ messageId: 'wamid.TEST1' })
  vi.stubEnv('WHATSAPP_TEST_RECIPIENT', '+919876543210')
  __resetRateLimitForTests()
})
afterEach(() => vi.unstubAllEnvs())

describe('POST /api/whatsapp/config/test-message', () => {
  it('refuses non-admins', async () => {
    callerRole = 'agent'
    const res = await post({ confirm: true })
    expect(res.status).toBe(403)
    expect(send.sendTemplateMessage).not.toHaveBeenCalled()
  })

  it('requires an explicit confirmation', async () => {
    const res = await post({})
    expect(res.status).toBe(400)
    expect(send.sendTemplateMessage).not.toHaveBeenCalled()
  })

  it('refuses when no valid test recipient is configured', async () => {
    vi.stubEnv('WHATSAPP_TEST_RECIPIENT', 'not-a-number')
    const res = await post({ confirm: true })
    expect(res.status).toBe(400)
    expect((await res.json()).reason).toBe('missing_test_recipient')
    expect(send.sendTemplateMessage).not.toHaveBeenCalled()
  })

  it('sends hello_world only to the configured recipient and never echoes the token', async () => {
    const res = await post({ confirm: true, to: '15550000000' })
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toEqual({ accepted: true, message_id: 'wamid.TEST1', recipient: '+••••••••3210' })
    expect(send.sendTemplateMessage).toHaveBeenCalledWith({
      phoneNumberId: '111222333',
      accessToken: 'plaintext-token',
      to: '919876543210',
      templateName: 'hello_world',
      language: 'en_US',
    })
    expect(JSON.stringify(json)).not.toContain('plaintext-token')
  })

  it('reports an expired token as an actionable error', async () => {
    send.sendTemplateMessage.mockRejectedValue(
      new MetaApiError('Session has expired', { code: 190, subcode: 463, httpStatus: 401 }),
    )
    const res = await post({ confirm: true })
    const json = await res.json()
    expect(res.status).toBe(400)
    expect(json.accepted).toBe(false)
    expect(json.error).toMatch(/expired/i)
    expect(json.meta).toMatchObject({ code: 190, subcode: 463, step: 'send_test' })
  })
})

describe('GET /api/whatsapp/config/test-message', () => {
  it('reports the recipient masked, without sending', async () => {
    const json = await (await GET()).json()
    expect(json).toMatchObject({ configured: true, recipient: '+••••••••3210' })
    expect(send.sendTemplateMessage).not.toHaveBeenCalled()
  })
})
