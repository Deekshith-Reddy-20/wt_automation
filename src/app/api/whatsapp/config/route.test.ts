import { beforeEach, describe, expect, it, vi } from 'vitest'

let callerRole = 'admin'
let signedIn = true

const configInserts: Record<string, unknown>[] = []
const configUpdates: Record<string, unknown>[] = []
let configDeletes = 0

const STORED_CONFIG = {
  id: 'cfg-1',
  phone_number_id: '111222333',
  waba_id: '444555666',
  access_token: 'enc-token',
  status: 'connected' as string,
  registered_at: null,
  verify_token: null,
  last_registration_error: null as string | null,
}

let storedConfig: typeof STORED_CONFIG | null = null

function makeSupabaseMock() {
  function builder(table: string) {
    const result = () => {
      switch (table) {
        case 'profiles':
          return {
            data: { account_id: 'acct-1', account_role: callerRole },
            error: null,
          }
        case 'accounts':
          return { data: { id: 'acct-1', name: 'Acme' }, error: null }
        case 'whatsapp_config':
          return { data: storedConfig, error: null }
        default:
          return { data: null, error: null }
      }
    }

    const b: Record<string, unknown> = {}
    const chain = () => b
    for (const m of ['select', 'eq', 'neq']) b[m] = vi.fn(chain)
    b.insert = vi.fn((row: Record<string, unknown>) => {
      if (table === 'whatsapp_config') configInserts.push(row)
      return b
    })
    b.update = vi.fn((patch: Record<string, unknown>) => {
      if (table === 'whatsapp_config') configUpdates.push(patch)
      return b
    })
    b.delete = vi.fn(() => {
      if (table === 'whatsapp_config') configDeletes += 1
      return b
    })
    b.single = vi.fn(async () => result())
    b.maybeSingle = vi.fn(async () => result())
    b.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null })
    return b
  }

  return {
    auth: {
      getUser: vi.fn(async () =>
        signedIn
          ? { data: { user: { id: 'user-1' } }, error: null }
          : { data: { user: null }, error: { message: 'no session' } },
      ),
    },
    from: vi.fn((table: string) => builder(table)),
  }
}

let supabaseMock = makeSupabaseMock()

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => supabaseMock),
}))

const serviceRole = vi.hoisted(() => ({
  lookups: 0,
  updates: [] as { patch: Record<string, unknown>; filters: [string, unknown][] }[],
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(() => {
      serviceRole.lookups += 1
      const b: Record<string, unknown> = {}
      let current: (typeof serviceRole.updates)[number] | null = null
      b.select = vi.fn(() => b)
      b.neq = vi.fn(() => b)
      b.eq = vi.fn((col: string, val: unknown) => {
        current?.filters.push([col, val])
        return b
      })
      b.update = vi.fn((patch: Record<string, unknown>) => {
        current = { patch, filters: [] }
        serviceRole.updates.push(current)
        return b
      })
      b.maybeSingle = vi.fn(async () => ({ data: null, error: null }))
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null })
      return b
    }),
  })),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn(() => 'plaintext-token'),
  encrypt: vi.fn(() => 'enc-token'),
}))

const meta = vi.hoisted(() => ({
  verifyPhoneNumber: vi.fn(
    async (): Promise<{ id: string; display_phone_number: string }> => ({
      id: '111222333',
      display_phone_number: '+1 555 0100',
    }),
  ),
  listWabaPhoneNumbers: vi.fn(async () => [{ id: '111222333' }]),
  registerPhoneNumber: vi.fn(async () => ({ success: true })),
  subscribeWabaToApp: vi.fn(async () => ({ success: true })),
  getSubscribedApps: vi.fn(async () => []),
  getTokenInfo: vi.fn(
    async (): Promise<{ type: string | null; expires_at: number | null; is_valid: boolean; scopes: string[] }> => ({
      type: 'SYSTEM_USER',
      expires_at: 0,
      is_valid: true,
      scopes: [],
    }),
  ),
}))
vi.mock('@/lib/whatsapp/meta-api', () => meta)

const LEAKED = 'EAAG-should-never-appear'

function metaError(code: number, subcode: number | null) {
  return Object.assign(new Error(`Error validating access token ${LEAKED}`), {
    name: 'MetaApiError',
    code,
    subcode,
    type: 'OAuthException',
    fbtraceId: 'trace-1',
    httpStatus: 401,
    details: null,
  })
}

import { DELETE, GET, POST } from './route'
import { __resetRateLimitForTests } from '@/lib/rate-limit'

function saveConfig() {
  return POST(
    new Request('http://localhost/api/whatsapp/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone_number_id: '111222333',
        waba_id: '444555666',
        access_token: 'caller-supplied-token',
        pin: '123456',
      }),
    }),
  )
}

function metaCallCount() {
  return (
    meta.verifyPhoneNumber.mock.calls.length +
    meta.listWabaPhoneNumbers.mock.calls.length +
    meta.registerPhoneNumber.mock.calls.length +
    meta.subscribeWabaToApp.mock.calls.length +
    meta.getSubscribedApps.mock.calls.length
  )
}

beforeEach(() => {
  __resetRateLimitForTests()
  callerRole = 'admin'
  signedIn = true
  storedConfig = null
  configInserts.length = 0
  configUpdates.length = 0
  configDeletes = 0
  serviceRole.lookups = 0
  serviceRole.updates.length = 0
  supabaseMock = makeSupabaseMock()
  for (const fn of Object.values(meta)) fn.mockClear()
})

describe('POST /api/whatsapp/config', () => {
  it.each(['viewer', 'agent'])('refuses the %s role before any Meta call', async (role) => {
    callerRole = role

    const res = await saveConfig()

    expect(res.status).toBe(403)
    expect(metaCallCount()).toBe(0)
    expect(serviceRole.lookups).toBe(0)
    expect(configInserts).toHaveLength(0)
    expect(configUpdates).toHaveLength(0)
  })

  it('answers 401 without a session and calls nothing', async () => {
    signedIn = false

    const res = await saveConfig()

    expect(res.status).toBe(401)
    expect(metaCallCount()).toBe(0)
    expect(serviceRole.lookups).toBe(0)
  })

  it.each(['admin', 'owner'])('lets the %s role verify, register, subscribe and save', async (role) => {
    callerRole = role

    const res = await saveConfig()
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({ success: true, saved: true, registered: true })
    expect(meta.verifyPhoneNumber).toHaveBeenCalledTimes(1)
    expect(meta.listWabaPhoneNumbers).toHaveBeenCalledTimes(1)
    expect(meta.registerPhoneNumber).toHaveBeenCalledTimes(1)
    expect(meta.subscribeWabaToApp).toHaveBeenCalledTimes(1)
    expect(configInserts).toHaveLength(1)
    expect(configInserts[0]).toMatchObject({ account_id: 'acct-1', user_id: 'user-1' })
  })
})

describe('DELETE /api/whatsapp/config', () => {
  it.each(['viewer', 'agent'])('refuses the %s role and deletes nothing', async (role) => {
    callerRole = role
    storedConfig = STORED_CONFIG

    const res = await DELETE()

    expect(res.status).toBe(403)
    expect(configDeletes).toBe(0)
  })

  it('lets an admin reset the configuration', async () => {
    storedConfig = STORED_CONFIG

    const res = await DELETE()

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
    expect(configDeletes).toBe(1)
  })
})

describe('GET /api/whatsapp/config', () => {
  it('stays readable for a viewer and never returns the token', async () => {
    callerRole = 'viewer'
    storedConfig = STORED_CONFIG

    const res = await GET()
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.connected).toBe(true)
    expect(JSON.stringify(body)).not.toContain('plaintext-token')
    expect(JSON.stringify(body)).not.toContain('enc-token')
  })

  it('reports a missing token without calling Meta', async () => {
    storedConfig = null

    const body = await (await GET()).json()

    expect(body).toMatchObject({ connected: false, reason: 'no_config' })
    expect(metaCallCount()).toBe(0)
    expect(serviceRole.updates).toHaveLength(0)
  })

  it('marks an expired token (190/463) disconnected and says so, without leaking it', async () => {
    storedConfig = STORED_CONFIG
    meta.verifyPhoneNumber.mockRejectedValueOnce(metaError(190, 463))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await GET()
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({ connected: false, reason: 'meta_api_error', token_rejected: true })
    expect(body.meta).toMatchObject({ code: 190, subcode: 463 })
    expect(serviceRole.updates).toHaveLength(1)
    expect(serviceRole.updates[0].patch).toMatchObject({ status: 'disconnected' })
    expect(serviceRole.updates[0].filters).toContainEqual(['account_id', 'acct-1'])
    const logged = [...warn.mock.calls, ...error.mock.calls].flat().map(String).join(' ')
    expect(logged).not.toContain('plaintext-token')
    expect(JSON.stringify(body)).not.toContain('plaintext-token')
    warn.mockRestore()
    error.mockRestore()
  })

  it('leaves the status alone when Meta fails for a non-token reason', async () => {
    storedConfig = STORED_CONFIG
    meta.verifyPhoneNumber.mockRejectedValueOnce(metaError(100, 33))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const body = await (await GET()).json()

    expect(body).toMatchObject({ connected: false, reason: 'meta_api_error', token_rejected: false })
    expect(serviceRole.updates).toHaveLength(0)
    error.mockRestore()
  })

  it('restores a connection that was disconnected by a rejected token once the token works', async () => {
    storedConfig = { ...STORED_CONFIG, status: 'disconnected' }

    const body = await (await GET()).json()

    expect(body.connected).toBe(true)
    expect(serviceRole.updates).toHaveLength(1)
    expect(serviceRole.updates[0].patch).toMatchObject({ status: 'connected' })
    expect(serviceRole.updates[0].filters).toContainEqual(['status', 'disconnected'])
  })

  it('does not restore a connection that is disconnected because registration failed', async () => {
    storedConfig = { ...STORED_CONFIG, status: 'disconnected', last_registration_error: 'PIN mismatch' }

    const body = await (await GET()).json()

    expect(body.connected).toBe(true)
    expect(serviceRole.updates).toHaveLength(0)
  })
})

describe('POST /api/whatsapp/config token lifetime', () => {
  it('reports a never-expiring System User token without a warning', async () => {
    const body = await (await saveConfig()).json()

    expect(meta.getTokenInfo).toHaveBeenCalledTimes(1)
    expect(body.token).toEqual({ kind: 'system_user', expiresAt: null, neverExpires: true, shortLived: false })
  })

  it('saves but flags a short-lived user token', async () => {
    const expires = Math.floor(Date.now() / 1000) + 3600
    meta.getTokenInfo.mockResolvedValueOnce({ type: 'USER', expires_at: expires, is_valid: true, scopes: [] })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const res = await saveConfig()
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.saved).toBe(true)
    expect(body.token).toMatchObject({ kind: 'user', shortLived: true })
    expect(configInserts).toHaveLength(1)
    expect(warn.mock.calls.flat().join(' ')).not.toContain('caller-supplied-token')
    warn.mockRestore()
  })

  it('still saves when the token type cannot be inspected', async () => {
    meta.getTokenInfo.mockRejectedValueOnce(new Error('debug_token unavailable'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const body = await (await saveConfig()).json()

    expect(body.saved).toBe(true)
    expect(body.token).toMatchObject({ kind: 'unknown', shortLived: false })
    warn.mockRestore()
  })

  it('refuses to save a token Meta rejects', async () => {
    meta.verifyPhoneNumber.mockRejectedValueOnce(metaError(190, 463))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await saveConfig()

    expect(res.status).toBe(400)
    expect(configInserts).toHaveLength(0)
    expect(configUpdates).toHaveLength(0)
    error.mockRestore()
  })
})
