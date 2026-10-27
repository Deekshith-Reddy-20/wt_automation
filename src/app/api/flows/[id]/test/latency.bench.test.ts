import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeDb } from '@/lib/whatsapp/latency-bench/fake-supabase'

// ============================================================
// Builder "Test flow" tap latency (MOCKED).
//
// Runs the real POST /api/flows/[id]/test route and the real Suraj Solar
// lead flow against the in-memory Supabase that charges one simulated
// round trip per query. Meta sends are simulated by the route itself, so
// nothing leaves the process. requireRole is modelled as its two round
// trips (auth.getUser + profiles). The Next.js proxy, browser and
// network are not included.
//
//   LATENCY_BENCH=1 npx vitest run "src/app/api/flows/[id]/test/latency.bench.test.ts"
// ============================================================

const BENCH = process.env.LATENCY_BENCH === '1'
const EVENTS = BENCH ? 100 : 6

const h = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://fake.supabase.local'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role'
  return {
    db: null as unknown as { client: () => unknown; roundTrip: () => Promise<void> },
    accountFor: new Map<string, string>(),
  }
})

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (t: string) => (h.db.client() as { from: (t: string) => unknown }).from(t),
    rpc: (n: string, a: Record<string, unknown>) =>
      (h.db.client() as { rpc: (n: string, a: Record<string, unknown>) => unknown }).rpc(n, a),
  }),
}))
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: () => 'plain-token',
  encrypt: (v: string) => v,
  isLegacyFormat: () => false,
}))
vi.mock('@/lib/auth/account', () => ({
  requireRole: vi.fn(async () => {
    await h.db.roundTrip()
    await h.db.roundTrip()
    const accountId = h.accountFor.get(currentFlow.id)!
    return { accountId, userId: `user-${accountId}`, role: 'admin' }
  }),
  toErrorResponse: vi.fn(() => Response.json({ error: 'forbidden' }, { status: 403 })),
}))
vi.mock('@/lib/ai/auto-reply', () => ({ dispatchInboundToAiReply: vi.fn(async () => {}) }))

import { POST } from './route'
import { FLOW_TEST_CONTACT_PHONE } from '@/lib/flows/test-contact'
import {
  LANGS,
  LEAD_FLOW_CUSTOM_FIELDS,
  MESSAGES,
  WELCOME_TEXT,
  buildLeadFlow,
  languageReplyId,
} from '@/lib/suraj-solar/lead-flow'

function prng(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = prng(7)
const dbLatency = () => (BENCH ? 155 + 45 * rand() ** 1.3 : 2)

const LEAD_FLOW = buildLeadFlow({
  fields: Object.fromEntries(LEAD_FLOW_CUSTOM_FIELDS.map(([name], i) => [name, `cf-${i}`])),
})

// Each simulated account owns one flow; the requireRole mock picks the
// account from the flow being tested.
const currentFlow = { id: '' }

let db: FakeDb

function seedAccounts(count: number, parked: boolean) {
  db = new FakeDb({ latency: dbLatency })
  h.db = db
  h.accountFor.clear()
  for (let i = 0; i < count; i++) {
    const account = `acc-${i}`
    const flowId = `flow-${i}`
    h.accountFor.set(flowId, account)
    db.seed('flows', [
      {
        id: flowId,
        account_id: account,
        user_id: `user-${account}`,
        name: LEAD_FLOW.name,
        status: 'draft',
        trigger_type: LEAD_FLOW.trigger_type,
        trigger_config: LEAD_FLOW.trigger_config,
        entry_node_id: LEAD_FLOW.entry_node_id,
        fallback_policy: LEAD_FLOW.fallback_policy,
        execution_count: 0,
      },
    ])
    db.seed('flow_nodes', LEAD_FLOW.nodes.map((n) => ({ ...n, flow_id: flowId })))
    db.seed('contacts', [
      { id: `ct-${i}`, account_id: account, user_id: `user-${account}`, phone: FLOW_TEST_CONTACT_PHONE, name: 'Test' },
    ])
    db.seed('conversations', [
      { id: `cv-${i}`, account_id: account, user_id: `user-${account}`, contact_id: `ct-${i}`, status: 'open' },
    ])
    if (parked) {
      db.seed('flow_runs', [
        {
          id: `run-${i}`,
          flow_id: flowId,
          account_id: account,
          user_id: `user-${account}`,
          contact_id: `ct-${i}`,
          conversation_id: `cv-${i}`,
          status: 'active',
          current_node_key: 'welcome',
          vars: {},
          started_at: new Date(Date.now() - 60_000).toISOString(),
        },
      ])
    }
  }
  db.queries = 0
}

// Taps run one at a time, as a single builder user clicks them.
async function tap(i: number, message: unknown) {
  const flowId = `flow-${i}`
  currentFlow.id = flowId
  const started = performance.now()
  const res = await POST(
    new Request(`http://localhost/api/flows/${flowId}/test`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),
    { params: Promise.resolve({ id: flowId }) },
  )
  const ms = Math.round((performance.now() - started) * 10) / 10
  return { res, ms, body: (await res.json()) as Record<string, unknown> }
}

function stats(values: number[]) {
  const s = [...values].sort((a, b) => a - b)
  const at = (p: number) => s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]
  return {
    p50: at(50),
    p95: at(95),
    max: s[s.length - 1],
    under_1s_pct: Math.round((s.filter((v) => v < 1000).length / s.length) * 1000) / 10,
  }
}

const report: Record<string, unknown> = {
  mocked: true,
  mode: BENCH ? 'bench' : 'quick',
  label: process.env.LATENCY_BENCH_LABEL ?? 'unlabelled',
  model: {
    supabase_rtt_ms: BENCH ? '155–200 (p50≈173), measured-RTT-shaped' : '2',
    meta_send: 'simulated in-process by the route (no Graph API call)',
    auth: 'requireRole = 2 round trips; proxy middleware not included',
  },
  scenarios: {},
}

beforeEach(() => {
  vi.stubGlobal('fetch', async () => {
    throw new Error('network access attempted during a simulated test run')
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const TIMEOUT = BENCH ? 600_000 : 30_000

describe('builder Test flow route latency (mocked Supabase, simulated Meta)', () => {
  it('language button tap → category list in that language', async () => {
    seedAccounts(EVENTS, true)
    const timings: number[] = []
    for (let i = 0; i < EVENTS; i++) {
      const lang = LANGS[i % LANGS.length]
      const { res, ms, body } = await tap(i, { kind: 'interactive_reply', reply_id: languageReplyId(lang) })
      expect(res.status).toBe(200)
      const sends = body.sends as { payload: { interactive?: { body?: { text?: string } } } }[]
      expect(sends).toHaveLength(1)
      expect(sends[0].payload.interactive?.body?.text).toBe(MESSAGES.categoryPrompt[lang])
      expect((body.run as { current_node_key: string }).current_node_key).toBe(`${lang}_category`)
      expect((body.events as unknown[]).length).toBeGreaterThan(0)
      timings.push(ms)
    }
    ;(report.scenarios as Record<string, unknown>).test_route_language_tap = {
      events: EVENTS,
      db_round_trips_per_tap: Math.round((db.queries / EVENTS) * 10) / 10,
      total_route_ms: stats(timings),
    }
  }, TIMEOUT)

  it('first message → language welcome', async () => {
    seedAccounts(EVENTS, false)
    const timings: number[] = []
    for (let i = 0; i < EVENTS; i++) {
      const { res, ms, body } = await tap(i, { kind: 'text', text: 'Hi' })
      expect(res.status).toBe(200)
      const sends = body.sends as { payload: { interactive?: { body?: { text?: string } } } }[]
      expect(sends).toHaveLength(1)
      expect(sends[0].payload.interactive?.body?.text).toBe(WELCOME_TEXT)
      timings.push(ms)
    }
    ;(report.scenarios as Record<string, unknown>).test_route_first_message = {
      events: EVENTS,
      db_round_trips_per_tap: Math.round((db.queries / EVENTS) * 10) / 10,
      total_route_ms: stats(timings),
    }
  }, TIMEOUT)

  it('writes the report', () => {
    const dir = process.env.LATENCY_BENCH_OUT ?? join(tmpdir(), 'wacrm-latency')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${report.label}-test-route-${report.mode}.json`), JSON.stringify(report, null, 2))
  })
})
