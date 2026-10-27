import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import { createFakeDb } from '@/lib/flows/fake-db.test-helper'
import {
  ContactOptedOutError,
  applyOptKeyword,
  assertAutomatedSendAllowed,
  classifyOptKeyword,
  loadOptedOutAt,
} from './opt-out'

describe('classifyOptKeyword', () => {
  it.each([
    ['STOP', 'opt_out'],
    ['  Stop! ', 'opt_out'],
    ['unsubscribe', 'opt_out'],
    ['ఆపండి', 'opt_out'],
    ['बंद करो', 'opt_out'],
    ['START', 'opt_in'],
    ['opt in', 'opt_in'],
  ])('%s → %s', (text, expected) => {
    expect(classifyOptKeyword(text)).toBe(expected)
  })

  it('only matches the whole message', () => {
    expect(classifyOptKeyword('please stop the installation next week')).toBeNull()
    expect(classifyOptKeyword('start over')).toBeNull()
    expect(classifyOptKeyword('')).toBeNull()
    expect(classifyOptKeyword(null)).toBeNull()
  })
})

describe('assertAutomatedSendAllowed', () => {
  it('blocks opted-out contacts only', () => {
    expect(() => assertAutomatedSendAllowed({ opted_out_at: '2026-10-17T00:00:00Z' })).toThrow(ContactOptedOutError)
    expect(() => assertAutomatedSendAllowed({ opted_out_at: null })).not.toThrow()
  })
})

function db(tables: Record<string, Record<string, unknown>[]>) {
  return createFakeDb(tables) as unknown as SupabaseClient
}

describe('applyOptKeyword', () => {
  const base = () => ({
    contacts: [{ id: 'ct-1', account_id: 'acct-1', opted_out_at: null as string | null }],
    flow_runs: [
      { id: 'run-1', account_id: 'acct-1', contact_id: 'ct-1', status: 'active' },
      { id: 'run-2', account_id: 'acct-1', contact_id: 'ct-2', status: 'active' },
    ],
    automation_pending_executions: [
      { id: 'pe-1', account_id: 'acct-1', contact_id: 'ct-1', status: 'awaiting_reply' },
      { id: 'pe-2', account_id: 'acct-1', contact_id: 'ct-1', status: 'completed' },
    ],
  })

  it('opts out, stops active runs and pending automations, and confirms once', async () => {
    const tables = base()
    const out = await applyOptKeyword(db(tables), { accountId: 'acct-1', contactId: 'ct-1', currentOptedOutAt: null, text: 'STOP' })
    expect(out).toMatchObject({ change: 'opted_out', optedOut: true })
    expect(out.confirmation).toContain('START')
    expect(tables.contacts[0].opted_out_at).toEqual(expect.any(String))
    expect(tables.flow_runs[0]).toMatchObject({ status: 'cancelled', end_reason: 'contact_opted_out' })
    expect(tables.flow_runs[1].status).toBe('active')
    expect(tables.automation_pending_executions.map((p) => p.status)).toEqual(['expired', 'completed'])

    const again = await applyOptKeyword(db(tables), {
      accountId: 'acct-1',
      contactId: 'ct-1',
      currentOptedOutAt: tables.contacts[0].opted_out_at,
      text: 'stop',
    })
    expect(again).toEqual({ change: null, optedOut: true, confirmation: null })
  })

  it('opts back in on START', async () => {
    const tables = base()
    tables.contacts[0].opted_out_at = '2026-10-01T00:00:00Z'
    const out = await applyOptKeyword(db(tables), {
      accountId: 'acct-1',
      contactId: 'ct-1',
      currentOptedOutAt: '2026-10-01T00:00:00Z',
      text: 'START',
    })
    expect(out).toMatchObject({ change: 'opted_in', optedOut: false })
    expect(tables.contacts[0].opted_out_at).toBeNull()
  })

  it('keeps an opted-out contact blocked for ordinary messages', async () => {
    const out = await applyOptKeyword(db(base()), {
      accountId: 'acct-1',
      contactId: 'ct-1',
      currentOptedOutAt: '2026-10-01T00:00:00Z',
      text: 'what is the price?',
    })
    expect(out).toEqual({ change: null, optedOut: true, confirmation: null })
  })
})

describe('loadOptedOutAt', () => {
  const erroring = (error: { code?: string; message: string }) =>
    ({
      from: () => {
        const b = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: null, error }) }
        return b
      },
    }) as unknown as SupabaseClient

  it('reads the column', async () => {
    const value = await loadOptedOutAt(
      db({ contacts: [{ id: 'ct-1', account_id: 'acct-1', opted_out_at: '2026-10-01T00:00:00Z' }] }),
      'acct-1',
      'ct-1',
    )
    expect(value).toBe('2026-10-01T00:00:00Z')
  })

  it('treats a database without migration 055 as "nobody opted out"', async () => {
    await expect(loadOptedOutAt(erroring({ code: '42703', message: 'column does not exist' }), 'a', 'c')).resolves.toBeNull()
  })

  it('fails closed on any other error', async () => {
    await expect(loadOptedOutAt(erroring({ code: '57014', message: 'timeout' }), 'a', 'c')).rejects.toThrow(/Opt-out lookup failed/)
  })
})
