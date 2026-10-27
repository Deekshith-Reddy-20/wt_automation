import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  role: 'admin' as 'admin' | 'agent',
  userSeq: 0,
  inserts: [] as Record<string, unknown>[],
  filters: [] as unknown[][],
  insertError: null as { code?: string; message: string } | null,
}))

vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>()
  return {
    ...actual,
    requireRole: vi.fn(async () => {
      if (h.role !== 'admin') throw new actual.ForbiddenError()
      return { accountId: 'acct-1', userId: `admin-${h.userSeq}`, role: 'admin', supabase: fakeSupabase() }
    }),
  }
})

function fakeSupabase() {
  return {
    from: () => {
      const q = {
        insert(payload: Record<string, unknown>) {
          h.inserts.push(payload)
          return q
        },
        select() {
          return q
        },
        eq(...args: unknown[]) {
          h.filters.push(['eq', ...args])
          return q
        },
        is(...args: unknown[]) {
          h.filters.push(['is', ...args])
          return q
        },
        or(...args: unknown[]) {
          h.filters.push(['or', ...args])
          return q
        },
        gt(...args: unknown[]) {
          h.filters.push(['gt', ...args])
          return q
        },
        order() {
          return Promise.resolve({ data: [], error: null })
        },
        single() {
          if (h.insertError) return Promise.resolve({ data: null, error: h.insertError })
          const row = h.inserts.at(-1)!
          return Promise.resolve({
            data: { id: 'inv-1', role: row.role, label: row.label, expires_at: row.expires_at, created_at: '2026-01-01T00:00:00.000Z' },
            error: null,
          })
        },
      }
      return q
    },
  }
}

import { GET, POST } from './route'

const NOW = new Date('2026-01-01T00:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

function create(body: unknown, headers: Record<string, string> = { host: 'crm.example' }) {
  return POST(
    new Request('https://crm.example/api/account/invitations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  )
}

beforeEach(() => {
  h.role = 'admin'
  h.userSeq++
  h.inserts = []
  h.filters = []
  h.insertError = null
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('POST /api/account/invitations — invite link host', () => {
  it('NEXT_PUBLIC_SITE_URL wins over request headers', async () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://crm.surajsolar.example/')
    const res = await create({ role: 'agent' }, { host: 'other.example' })
    expect((await res.json()).url).toMatch(/^https:\/\/crm\.surajsolar\.example\/join\//)
  })

  it('uses an allow-listed forwarded host', async () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '')
    vi.stubEnv('ALLOWED_INVITE_HOSTS', 'crm.example')
    const res = await create({ role: 'agent' }, { host: 'internal:3000', 'x-forwarded-host': 'crm.example' })
    expect((await res.json()).url).toMatch(/^https:\/\/crm\.example\/join\//)
  })

  it('a host outside ALLOWED_INVITE_HOSTS creates nothing and never links to a third-party domain', async () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '')
    vi.stubEnv('ALLOWED_INVITE_HOSTS', 'crm.example')
    const res = await create({ role: 'agent' }, { host: 'phishing.example' })
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.url).toBeUndefined()
    expect(body.error).toMatch(/NEXT_PUBLIC_SITE_URL/)
    expect(h.inserts).toHaveLength(0)
  })
})

describe('POST /api/account/invitations — expiry', () => {
  it('"Never expires" stores a NULL expiry and reports it', async () => {
    const res = await create({ role: 'agent', neverExpires: true })
    expect(res.status).toBe(201)
    expect(h.inserts[0].expires_at).toBeNull()
    const body = await res.json()
    expect(body).toMatchObject({ expiresInDays: null, neverExpires: true })
    expect(body.invitation.expires_at).toBeNull()
    expect(body.url).toMatch(/^https:\/\/crm\.example\/join\/[A-Za-z0-9_-]{43}$/)
  })

  it.each([1, 7, 30])('%i-day links keep a timestamp exactly that far ahead', async (days) => {
    const res = await create({ role: 'viewer', expiresInDays: days })
    expect(res.status).toBe(201)
    expect(h.inserts[0].expires_at).toBe(new Date(NOW.getTime() + days * DAY).toISOString())
    expect(await res.json()).toMatchObject({ expiresInDays: days, neverExpires: false })
  })

  it('keeps the 7-day default when no expiry is sent', async () => {
    const res = await create({ role: 'agent' })
    expect(h.inserts[0].expires_at).toBe(new Date(NOW.getTime() + 7 * DAY).toISOString())
    expect(await res.json()).toMatchObject({ expiresInDays: 7, neverExpires: false })
  })

  it.each([['true'], [1], [null], [false]])('only a literal true opts out of expiry (neverExpires=%j)', async (value) => {
    await create({ role: 'agent', neverExpires: value, expiresInDays: 30 })
    expect(h.inserts[0].expires_at).toBe(new Date(NOW.getTime() + 30 * DAY).toISOString())
  })

  it('a database without migration 057 gets an actionable 409, not a fake success', async () => {
    h.insertError = { code: '23502', message: 'null value in column "expires_at" violates not-null constraint' }
    const res = await create({ role: 'agent', neverExpires: true })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/057/)
  })

  it('other insert failures stay a 500', async () => {
    h.insertError = { code: '42501', message: 'permission denied' }
    const res = await create({ role: 'agent', expiresInDays: 7 })
    expect(res.status).toBe(500)
    expect((await res.json()).url).toBeUndefined()
  })
})

describe('POST /api/account/invitations — permissions', () => {
  it('non-admins are refused before anything is written', async () => {
    h.role = 'agent'
    const res = await create({ role: 'agent', neverExpires: true })
    expect(res.status).toBe(403)
    expect(h.inserts).toHaveLength(0)
  })

  it('owner invites are still rejected', async () => {
    const res = await create({ role: 'owner', neverExpires: true })
    expect(res.status).toBe(400)
    expect(h.inserts).toHaveLength(0)
  })
})

describe('GET /api/account/invitations', () => {
  it('lists unaccepted invites that are unexpired or never expire', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    expect(h.filters).toContainEqual(['eq', 'account_id', 'acct-1'])
    expect(h.filters).toContainEqual(['is', 'accepted_at', null])
    expect(h.filters).toContainEqual(['or', `expires_at.is.null,expires_at.gt."${NOW.toISOString()}"`])
    expect(h.filters.some(([op]) => op === 'gt')).toBe(false)
  })

  it('requires admin', async () => {
    h.role = 'agent'
    expect((await GET()).status).toBe(403)
  })
})
