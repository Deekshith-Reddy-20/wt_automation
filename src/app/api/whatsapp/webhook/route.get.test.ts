import crypto from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Meta's subscription handshake (GET) and its separation from event
// delivery (POST). Uses the real token/signature helpers; only the
// database and the post-response processing are stubbed.

const h = vi.hoisted(() => ({
  configs: [] as { id: string; verify_token: string | null }[],
  configError: null as { message: string } | null,
  configQueries: 0,
  afterCallbacks: [] as (() => unknown)[],
}))

vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: (cb: () => unknown) => {
    h.afterCallbacks.push(cb)
  },
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      select: () => {
        h.configQueries++
        return Promise.resolve({ data: h.configs, error: h.configError })
      },
    }),
  }),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => v.replace(/^enc:/, ''),
  encrypt: (v: string) => `enc:${v}`,
  isLegacyFormat: () => false,
}))

import { GET, POST } from './route'
import { __resetWebhookHealthForTests, getWebhookHealth } from '@/lib/whatsapp/webhook-health'

const URL_BASE = 'https://example.ngrok-free.dev/api/whatsapp/webhook'

function verifyRequest(params: Record<string, string>) {
  return new Request(`${URL_BASE}?${new URLSearchParams(params)}`)
}

const handshake = (token: string) =>
  verifyRequest({
    'hub.mode': 'subscribe',
    'hub.challenge': '397227898',
    'hub.verify_token': token,
  })

beforeEach(() => {
  h.configs = [{ id: 'cfg-1', verify_token: 'enc:account-token-123' }]
  h.configError = null
  h.configQueries = 0
  h.afterCallbacks = []
  delete process.env.WHATSAPP_VERIFY_TOKEN
  process.env.META_APP_SECRET = 'test-app-secret'
})

afterEach(() => {
  delete process.env.WHATSAPP_VERIFY_TOKEN
})

describe('GET /api/whatsapp/webhook — Meta verification handshake', () => {
  it('echoes the exact challenge as plain text for WHATSAPP_VERIFY_TOKEN', async () => {
    process.env.WHATSAPP_VERIFY_TOKEN = 'env-token-abc'

    const res = await GET(handshake('env-token-abc'))

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/plain')
    expect(await res.text()).toBe('397227898')
    expect(h.configQueries).toBe(0)
  })

  it('echoes the challenge for a token saved in WhatsApp settings', async () => {
    const res = await GET(handshake('account-token-123'))

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('397227898')
  })

  it('still accepts the account token when WHATSAPP_VERIFY_TOKEN is also set', async () => {
    process.env.WHATSAPP_VERIFY_TOKEN = 'env-token-abc'

    const res = await GET(handshake('account-token-123'))

    expect(res.status).toBe(200)
  })

  it('rejects a wrong token with 403 and never echoes the challenge', async () => {
    process.env.WHATSAPP_VERIFY_TOKEN = 'env-token-abc'

    const res = await GET(handshake('wrong'))

    expect(res.status).toBe(403)
    expect(await res.text()).not.toContain('397227898')
  })

  it('ignores a blank WHATSAPP_VERIFY_TOKEN', async () => {
    process.env.WHATSAPP_VERIFY_TOKEN = '   '

    expect((await GET(handshake(''))).status).toBe(403)
    expect((await GET(handshake('   '))).status).toBe(403)
  })

  it.each([
    ['no parameters', {}],
    ['missing token', { 'hub.mode': 'subscribe', 'hub.challenge': '1' }],
    ['missing challenge', { 'hub.mode': 'subscribe', 'hub.verify_token': 'account-token-123' }],
    ['wrong mode', { 'hub.mode': 'unsubscribe', 'hub.challenge': '1', 'hub.verify_token': 'account-token-123' }],
  ])('returns 403 for %s', async (_label, params) => {
    const res = await GET(verifyRequest(params as Record<string, string>))

    expect(res.status).toBe(403)
  })

  it('returns 403 (not 500) when the config lookup fails', async () => {
    h.configs = null as unknown as typeof h.configs
    h.configError = { message: 'db down' }

    expect((await GET(handshake('account-token-123'))).status).toBe(403)
  })
})

describe('POST /api/whatsapp/webhook — event delivery stays separate', () => {
  const statusEvent = JSON.stringify({
    entry: [
      {
        id: 'waba-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '1', phone_number_id: 'pn-1' },
              statuses: [{ id: 'wamid.1', status: 'delivered', timestamp: '1700000000', recipient_id: '1' }],
            },
          },
        ],
      },
    ],
  })
  const sign = (body: string) =>
    'sha256=' + crypto.createHmac('sha256', 'test-app-secret').update(body).digest('hex')

  it('rejects an unsigned POST with 401 even when it carries hub.* params', async () => {
    process.env.WHATSAPP_VERIFY_TOKEN = 'env-token-abc'
    const req = new Request(
      `${URL_BASE}?hub.mode=subscribe&hub.challenge=1&hub.verify_token=env-token-abc`,
      { method: 'POST', body: statusEvent },
    )

    const res = await POST(req)

    expect(res.status).toBe(401)
    expect(h.afterCallbacks).toHaveLength(0)
  })

  it('rejects an inbound message signed with the wrong secret, before any processing', async () => {
    const inbound = JSON.stringify({
      entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'pn-1' }, messages: [{ id: 'wamid.X', from: '1', timestamp: '1', type: 'text', text: { body: 'hi' } }] } }] }],
    })
    const forged = 'sha256=' + crypto.createHmac('sha256', 'not-the-app-secret').update(inbound).digest('hex')

    const res = await POST(
      new Request(URL_BASE, { method: 'POST', headers: { 'x-hub-signature-256': forged }, body: inbound }),
    )

    expect(res.status).toBe(401)
    expect(h.afterCallbacks).toHaveLength(0)
    expect(getWebhookHealth().last_post?.outcome).toBe('invalid_signature')
  })

  it('records an accepted delivery for the health panel', async () => {
    __resetWebhookHealthForTests()
    await POST(
      new Request(URL_BASE, { method: 'POST', headers: { 'x-hub-signature-256': sign(statusEvent) }, body: statusEvent }),
    )
    expect(getWebhookHealth().last_post?.outcome).toBe('accepted')
    expect(getWebhookHealth().last_accepted_at).not.toBeNull()
  })

  it('acks a correctly signed event with JSON and defers processing', async () => {
    const res = await POST(
      new Request(URL_BASE, {
        method: 'POST',
        headers: { 'x-hub-signature-256': sign(statusEvent) },
        body: statusEvent,
      }),
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'received' })
    expect(h.afterCallbacks).toHaveLength(1)
  })
})
