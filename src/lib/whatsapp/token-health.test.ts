import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import { MetaApiError } from './meta-api'
import { describeTokenLifetime, isMetaAuthError, markTokenRejected } from './token-health'

const SECRET_TOKEN = 'EAAG-secret-token-value'
const NOW = Date.parse('2026-10-18T00:00:00Z')

function metaError(code: number | null, subcode: number | null = null) {
  return new MetaApiError(`(#${code}) Error validating access token: ${SECRET_TOKEN}`, {
    code,
    subcode,
    httpStatus: 401,
  })
}

function fakeDb(updateError: { message: string } | null = null) {
  const updates: Record<string, unknown>[] = []
  const filters: [string, unknown][] = []
  const b: Record<string, unknown> = {}
  b.update = vi.fn((patch: Record<string, unknown>) => {
    updates.push(patch)
    return b
  })
  b.eq = vi.fn((col: string, val: unknown) => {
    filters.push([col, val])
    return b
  })
  b.then = (resolve: (v: unknown) => unknown) => resolve({ error: updateError })
  const db = { from: vi.fn(() => b) } as unknown as SupabaseClient
  return { db, updates, filters }
}

afterEach(() => vi.restoreAllMocks())

describe('isMetaAuthError', () => {
  it.each([
    [190, 463],
    [190, 460],
    [190, null],
    [102, null],
  ])('treats code %s/%s as a rejected token', (code, subcode) => {
    expect(isMetaAuthError(metaError(code, subcode))).toBe(true)
  })

  it('ignores other Meta errors and plain errors', () => {
    expect(isMetaAuthError(metaError(100))).toBe(false)
    expect(isMetaAuthError(metaError(131030))).toBe(false)
    expect(isMetaAuthError(metaError(null))).toBe(false)
    expect(isMetaAuthError(new Error('network down'))).toBe(false)
    expect(isMetaAuthError(null)).toBe(false)
  })
})

describe('describeTokenLifetime', () => {
  it('reports a never-expiring System User token as long-lived', () => {
    expect(
      describeTokenLifetime({ type: 'SYSTEM_USER', expires_at: 0, is_valid: true, scopes: [] }, NOW),
    ).toEqual({ kind: 'system_user', expiresAt: null, neverExpires: true, shortLived: false })
  })

  it('reports a System User token with a distant expiry as long-lived', () => {
    const in60Days = Math.floor(NOW / 1000) + 60 * 24 * 3600
    const out = describeTokenLifetime({ type: 'SYSTEM_USER', expires_at: in60Days, is_valid: true, scopes: [] }, NOW)
    expect(out).toMatchObject({ kind: 'system_user', neverExpires: false, shortLived: false })
    expect(out.expiresAt).toBe(new Date(in60Days * 1000).toISOString())
  })

  it('flags any token expiring within a week', () => {
    const in2Days = Math.floor(NOW / 1000) + 2 * 24 * 3600
    expect(
      describeTokenLifetime({ type: 'SYSTEM_USER', expires_at: in2Days, is_valid: true, scopes: [] }, NOW).shortLived,
    ).toBe(true)
  })

  it('flags a user (API Setup / Graph Explorer) token as short-lived', () => {
    const in1Day = Math.floor(NOW / 1000) + 24 * 3600
    expect(
      describeTokenLifetime({ type: 'USER', expires_at: in1Day, is_valid: true, scopes: [] }, NOW),
    ).toMatchObject({ kind: 'user', shortLived: true, neverExpires: false })
  })

  it('returns an unknown, non-alarming result when the token could not be inspected', () => {
    expect(describeTokenLifetime(null)).toEqual({
      kind: 'unknown',
      expiresAt: null,
      neverExpires: false,
      shortLived: false,
    })
  })
})

describe('markTokenRejected', () => {
  it('marks a connected account disconnected on an expired token, logging no token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { db, updates, filters } = fakeDb()

    const rejected = await markTokenRejected(db, 'acct-1', metaError(190, 463), 'agent send')

    expect(rejected).toBe(true)
    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({ status: 'disconnected' })
    expect(filters).toEqual([
      ['account_id', 'acct-1'],
      ['status', 'connected'],
    ])
    const logged = warn.mock.calls.flat().join(' ')
    expect(logged).toContain('190/463')
    expect(logged).not.toContain(SECRET_TOKEN)
  })

  it('leaves the connection alone for a non-auth failure', async () => {
    const { db, updates } = fakeDb()
    expect(await markTokenRejected(db, 'acct-1', metaError(131030), 'agent send')).toBe(false)
    expect(await markTokenRejected(db, 'acct-1', new Error('timeout'), 'agent send')).toBe(false)
    expect(updates).toHaveLength(0)
  })

  it('still reports the rejection when the status write fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { db } = fakeDb({ message: 'db unavailable' })

    expect(await markTokenRejected(db, 'acct-1', metaError(190, 463), 'broadcast')).toBe(true)
    expect(error).toHaveBeenCalled()
  })
})
