import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FakeTables } from '@/lib/flows/fake-db.test-helper'

// Drives POST /api/flows/[id]/test through the real Flows engine, the
// real flow senders and the real Meta payload builders; only the
// database (in-memory) and auth are stubbed. `fetch` fails the test if
// anything tries to reach graph.facebook.com.

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  role: 'admin' as 'admin' | 'agent',
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: vi.fn(async () => {
    if (h.role !== 'admin') throw new Error('forbidden')
    return { accountId: 'acct-1', userId: 'owner-1', role: h.role }
  }),
  toErrorResponse: vi.fn(() => Response.json({ error: 'forbidden' }, { status: 403 })),
}))

vi.mock('@/lib/flows/admin-client', async () => {
  const { createFakeDb } = await import('@/lib/flows/fake-db.test-helper')
  return { supabaseAdmin: () => createFakeDb(h.tables as FakeTables) }
})

import { POST } from './route'
import { FLOW_TEST_CONTACT_PHONE } from '@/lib/flows/test-contact'
import { LEAD_FLOW_CUSTOM_FIELDS, MESSAGES, WELCOME_TEXT, buildLeadFlow } from '@/lib/suraj-solar/lead-flow'

const fetchMock = vi.fn(async () => {
  throw new Error('network access attempted during a simulated test run')
})

function seed(opts: { optedOut?: boolean } = {}) {
  const def = buildLeadFlow({
    fields: Object.fromEntries(LEAD_FLOW_CUSTOM_FIELDS.map(([n], i) => [n, `cf-${i}`])),
  })
  h.tables = {
    flows: [
      {
        id: 'flow-1',
        account_id: 'acct-1',
        user_id: 'owner-1',
        name: def.name,
        status: 'draft',
        trigger_type: def.trigger_type,
        trigger_config: def.trigger_config,
        entry_node_id: def.entry_node_id,
        fallback_policy: def.fallback_policy,
        created_at: '2026-10-01T00:00:00Z',
      },
      { id: 'flow-other', account_id: 'acct-2', status: 'draft' },
    ],
    flow_nodes: def.nodes.map((n, i) => ({ id: `n-${i}`, flow_id: 'flow-1', ...n })),
    flow_runs: [],
    flow_run_events: [],
    messages: [],
    contacts: opts.optedOut
      ? [{ id: 'ct-test', account_id: 'acct-1', phone: FLOW_TEST_CONTACT_PHONE, name: 'Test', opted_out_at: '2026-10-01T00:00:00Z' }]
      : [],
    conversations: [],
  }
}

const call = (id: string, body: unknown) =>
  POST(new Request(`http://localhost/api/flows/${id}/test`, { method: 'POST', body: JSON.stringify(body) }), {
    params: Promise.resolve({ id }),
  })

beforeEach(() => {
  h.role = 'admin'
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  seed()
})
afterEach(() => vi.unstubAllGlobals())

describe('POST /api/flows/[id]/test', () => {
  it('is owner/admin only', async () => {
    h.role = 'agent'
    const res = await call('flow-1', { message: { kind: 'text', text: 'hi' } })
    expect(res.status).toBe(403)
    expect(h.tables.contacts).toEqual([])
  })

  it("refuses another account's flow", async () => {
    const res = await call('flow-other', { message: { kind: 'text', text: 'hi' } })
    expect(res.status).toBe(404)
  })

  it('rejects an empty message', async () => {
    const res = await call('flow-1', { message: { kind: 'text', text: '  ' } })
    expect(res.status).toBe(400)
  })

  it('runs a draft flow for the test contact with genuine, simulated Meta payloads', async () => {
    const res = await call('flow-1', { message: { kind: 'text', text: 'Hi' } })
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(fetchMock).not.toHaveBeenCalled()

    expect(json.sends).toHaveLength(1)
    expect(json.sends[0].kind).toBe('interactive_buttons')
    expect(json.sends[0].payload).toMatchObject({
      messaging_product: 'whatsapp',
      to: FLOW_TEST_CONTACT_PHONE.replace('+', ''),
      type: 'interactive',
      interactive: { type: 'button', body: { text: WELCOME_TEXT } },
    })
    expect(json.run).toMatchObject({ status: 'active', current_node_key: 'welcome' })

    // The draft stays a draft and the execution counter is not bumped.
    expect(h.tables.flows[0].status).toBe('draft')
    const bot = h.tables.messages.filter((m) => m.sender_type === 'bot')
    expect(bot).toHaveLength(1)
    expect(String(bot[0].message_id)).toMatch(/^wamid\.SIMULATED\./)

    const tap = await call('flow-1', {
      message: { kind: 'interactive_reply', reply_id: 'lang_te', reply_title: 'తెలుగు' },
    })
    const tapJson = await tap.json()
    expect(tapJson.sends[0].kind).toBe('interactive_list')
    expect(tapJson.sends[0].payload.interactive.body.text).toBe(MESSAGES.categoryPrompt.te)
    expect(tapJson.run.vars).toMatchObject({ language: 'lang_te', language_label: 'తెలుగు' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('resets the test contact’s active run', async () => {
    await call('flow-1', { message: { kind: 'text', text: 'Hi' } })
    const res = await call('flow-1', { reset: true })
    expect(res.status).toBe(200)
    expect(h.tables.flow_runs[0]).toMatchObject({ status: 'cancelled', end_reason: 'test_reset' })
  })

  it('respects opt-out even in a test run', async () => {
    seed({ optedOut: true })
    const res = await call('flow-1', { message: { kind: 'text', text: 'Hi' } })
    const json = await res.json()
    expect(json.sends).toEqual([])
    expect(h.tables.flow_run_events.some((e) => e.event_type === 'error')).toBe(true)
  })
})
