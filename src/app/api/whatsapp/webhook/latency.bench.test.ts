import { createHmac } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeDb } from '@/lib/whatsapp/latency-bench/fake-supabase'

// ============================================================
// Inbound → first-reply latency benchmark + scenario suite (MOCKED).
//
// Runs the real webhook route, flow engine, flow sender and Meta client
// against an in-memory Supabase that charges one simulated round trip
// per query, and a mocked Graph API. Nothing leaves the process.
//
//   npm test                         → fast correctness pass (2 ms/query)
//   LATENCY_BENCH=1 npx vitest run src/app/api/whatsapp/webhook/latency.bench.test.ts
//                                    → 100 events/scenario with the
//                                      latency model below; report JSON
//                                      written to $LATENCY_BENCH_OUT or
//                                      the OS temp dir.
//
// Latency model (bench mode): sampled from stage timings of real inbound
// webhooks handled by the dev server on this machine — per Supabase
// query p50 180 / p90 197 / p95 206 / max 285 ms; Meta send p50 1244 /
// max ≈ 1700 ms. Only `outbound_api_ms` depends on the Meta model.
// Set WHATSAPP_CONFIG_CACHE_TTL_MS to benchmark with the config cache.
// ============================================================

const BENCH = process.env.LATENCY_BENCH === '1'
const EVENTS = BENCH ? 100 : 6
const APP_SECRET = 'bench-app-secret-0123456789abcdef'

const h = vi.hoisted(() => {
  process.env.META_APP_SECRET = 'bench-app-secret-0123456789abcdef'
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://fake.supabase.local'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role'
  return {
    db: null as unknown as { client: () => unknown },
    after: [] as (() => Promise<void> | void)[],
  }
})

vi.mock('next/server', () => ({
  after: (cb: () => Promise<void> | void) => {
    h.after.push(cb)
  },
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) =>
      new Response(JSON.stringify(body), { status: init?.status ?? 200 }),
  },
}))
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
// No LLM work before the welcome — and none in the benchmark at all.
vi.mock('@/lib/ai/auto-reply', () => ({ dispatchInboundToAiReply: vi.fn(async () => {}) }))

import {
  CATEGORIES,
  CATEGORY_QUESTIONS,
  LANGS,
  LEAD_FLOW_CUSTOM_FIELDS,
  LEAD_FLOW_TAGS,
  MESSAGES,
  WELCOME_TEXT,
  buildLeadFlow,
  languageReplyId,
} from '@/lib/suraj-solar/lead-flow'
import { POST } from './route'
import { GET as SWEEP } from './sweep/route'
import { onLatencyTrace, summarizeLatency, type LatencySummary } from '@/lib/whatsapp/latency-trace'
import { invalidateWhatsAppConfigCache } from '@/lib/whatsapp/config-cache'
import { resetInboundContextRpcAvailability } from '@/lib/whatsapp/inbound-context-rpc'

/** LATENCY_BENCH_RPC=1 benchmarks with migration 058's function installed. */
const RPC_INSTALLED = process.env.LATENCY_BENCH_RPC === '1'

// ---------- deterministic latency model ----------
function prng(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = prng(42)
/** Inverse-CDF sampling through measured quantile points. */
function quantileSampler(points: [number, number][]) {
  return () => {
    const u = rand()
    for (let i = 1; i < points.length; i++) {
      const [q1, v1] = points[i]
      if (u <= q1) {
        const [q0, v0] = points[i - 1]
        return v0 + ((u - q0) / (q1 - q0)) * (v1 - v0)
      }
    }
    return points[points.length - 1][1]
  }
}
// Measured from 69 sequential Supabase queries in 23 real inbound
// webhooks (dev server on this machine → hosted Supabase).
const measuredDbRtt = quantileSampler([[0, 156], [0.5, 180], [0.9, 197], [0.95, 206], [1, 285]])
// Measured Meta send round trips from the same 19 real replies.
const measuredMetaRtt = quantileSampler([[0, 802], [0.5, 1244], [0.95, 1696], [1, 1700]])
const dbLatency = (scale = 1) => () => (BENCH ? measuredDbRtt() * scale : 2 * scale)
const metaLatency = () => (BENCH ? measuredMetaRtt() : 3)

// ---------- mocked Graph API ----------
type MetaMode = 'ok' | 'rate_limit' | 'timeout' | 'slow'
interface MetaCall {
  to: string
  type: string
  body: string
  buttonIds: string[]
  rowIds: string[]
}
let metaMode: MetaMode = 'ok'
let metaCalls: MetaCall[] = []
let outCounter = 0
const SLOW_META_MS = BENCH ? 2500 : 60

async function fakeFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const href = String(url)
  if (!href.startsWith('https://graph.facebook.com/') || !href.endsWith('/messages')) {
    throw new Error(`benchmark: unexpected outbound request to ${href}`)
  }
  const body = JSON.parse(String(init?.body ?? '{}'))
  metaCalls.push({
    to: body.to,
    type: body.type,
    body: body.interactive?.body?.text ?? body.text?.body ?? '',
    buttonIds: (body.interactive?.action?.buttons ?? []).map(
      (b: { reply: { id: string } }) => b.reply.id,
    ),
    rowIds: (body.interactive?.action?.sections ?? []).flatMap(
      (s: { rows: { id: string }[] }) => s.rows.map((r) => r.id),
    ),
  })
  await new Promise((r) => setTimeout(r, metaMode === 'slow' ? SLOW_META_MS : metaLatency()))
  if (metaMode === 'timeout') {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
  }
  if (metaMode === 'rate_limit') {
    return new Response(
      JSON.stringify({ error: { message: 'Rate limit hit', code: 130429, type: 'OAuthException' } }),
      { status: 429 },
    )
  }
  return new Response(JSON.stringify({ messages: [{ id: `wamid.out.${++outCounter}` }] }), {
    status: 200,
  })
}

// ---------- fixtures ----------
const ACCOUNT = 'acc-bench'
const PHONE_NUMBER_ID = 'pn-bench'

// The real Suraj Solar qualification flow, exactly as the seed script builds
// it — including the New Enquiry / Hot Lead tag nodes.
const TAG_IDS = {
  [LEAD_FLOW_TAGS.newEnquiry]: '00000000-0000-4000-9000-000000000001',
  [LEAD_FLOW_TAGS.hot]: '00000000-0000-4000-9000-000000000002',
}
const LEAD_FLOW = buildLeadFlow({
  fields: Object.fromEntries(LEAD_FLOW_CUSTOM_FIELDS.map(([name], i) => [name, `cf-${i}`])),
  tags: TAG_IDS,
})
const LEAD_FLOW_NODES = LEAD_FLOW.nodes

function seed(db: FakeDb, opts: { flowStatus: 'active' | 'draft'; automationActive?: boolean }) {
  db.seed('whatsapp_config', [
    {
      account_id: ACCOUNT,
      user_id: 'user-bench',
      phone_number_id: PHONE_NUMBER_ID,
      access_token: 'enc',
      mirror_inbound_media: true,
    },
  ])
  db.seed('flows', [
    {
      id: 'flow-lead',
      account_id: ACCOUNT,
      user_id: 'user-bench',
      name: 'Lead qualification',
      status: opts.flowStatus,
      trigger_type: 'first_inbound_message',
      trigger_config: LEAD_FLOW.trigger_config,
      entry_node_id: LEAD_FLOW.entry_node_id,
      fallback_policy: LEAD_FLOW.fallback_policy,
      execution_count: 0,
    },
  ])
  db.seed(
    'flow_nodes',
    LEAD_FLOW_NODES.map((n) => ({ ...n, flow_id: 'flow-lead' })),
  )
  db.seed(
    'tags',
    Object.entries(TAG_IDS).map(([name, id]) => ({ id, account_id: ACCOUNT, user_id: 'user-bench', name })),
  )
  if (opts.automationActive !== undefined) {
    db.seed('automations', [
      {
        id: 'auto-welcome',
        account_id: ACCOUNT,
        user_id: 'user-bench',
        name: 'Welcome automation',
        trigger_type: 'new_message_received',
        trigger_config: {},
        is_active: opts.automationActive,
        steps: [{ type: 'send_message', config: { text: 'Hello from automation' } }],
      },
    ])
  }
}

const phoneFor = (i: number) => `9198765${String(i).padStart(5, '0')}`

function textPayload(i: number, wamid: string, text = 'Hi') {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-bench',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550000000', phone_number_id: PHONE_NUMBER_ID },
              contacts: [{ wa_id: phoneFor(i), profile: { name: `Lead ${i}` } }],
              messages: [
                {
                  id: wamid,
                  from: phoneFor(i),
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  }
}

function buttonPayload(
  i: number,
  wamid: string,
  replyId: string,
  contextId: string,
  kind: 'button_reply' | 'list_reply' = 'button_reply',
) {
  const p = textPayload(i, wamid)
  const message = p.entry[0].changes[0].value.messages[0] as Record<string, unknown>
  delete message.text
  message.type = 'interactive'
  message.context = { from: '15550000000', id: contextId }
  message.interactive = { type: kind, [kind]: { id: replyId, title: replyId } }
  return p
}

/** Contact + conversation + the bot prompt they are answering + an active run parked on `nodeKey`. */
function seedParkedRuns(count: number, nodeKey: (i: number) => string, vars: (i: number) => Record<string, unknown> = () => ({})) {
  for (let i = 0; i < count; i++) {
    // UUID-shaped: tag writes validate contact ids.
    const contactId = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
    const convId = `cv-${i}`
    db.seed('contacts', [
      { id: contactId, account_id: ACCOUNT, user_id: 'user-bench', phone: phoneFor(i), name: `Lead ${i}` },
    ])
    db.seed('conversations', [
      { id: convId, account_id: ACCOUNT, user_id: 'user-bench', contact_id: contactId, first_inbound_at: new Date().toISOString() },
    ])
    db.seed('messages', [
      { id: `m-prompt-${i}`, conversation_id: convId, sender_type: 'bot', message_id: `wamid.prompt.${i}` },
    ])
    db.seed('flow_runs', [
      {
        id: `run-${i}`,
        flow_id: 'flow-lead',
        account_id: ACCOUNT,
        user_id: 'user-bench',
        contact_id: contactId,
        conversation_id: convId,
        status: 'active',
        current_node_key: nodeKey(i),
        vars: vars(i),
      },
    ])
  }
  db.queries = 0
}
const langFor = (i: number) => LANGS[i % LANGS.length]
const runOf = (i: number) => db.rows('flow_runs').find((r) => r.id === `run-${i}`)!
const callTo = (i: number) => metaCalls.filter((c) => c.to === phoneFor(i))

function sign(raw: string) {
  return 'sha256=' + createHmac('sha256', APP_SECRET).update(raw).digest('hex')
}

async function deliver(
  payload: unknown,
  opts: { badSignature?: boolean; queueDelayMs?: number } = {},
): Promise<Response> {
  const raw = JSON.stringify(payload)
  const res = await POST(
    new Request('http://localhost/api/whatsapp/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': opts.badSignature ? sign(raw + 'tampered') : sign(raw),
      },
      body: raw,
    }),
  )
  const callbacks = h.after.splice(0)
  if (opts.queueDelayMs) await new Promise((r) => setTimeout(r, opts.queueDelayMs))
  await Promise.all(callbacks.map((cb) => cb()))
  return res
}

/** Fire `count` deliveries with staggered arrivals, as Meta would. */
async function burst(count: number, make: (i: number) => Promise<unknown>, gapMs = BENCH ? 20 : 0) {
  await Promise.all(
    Array.from({ length: count }, async (_, i) => {
      if (gapMs) await new Promise((r) => setTimeout(r, i * gapMs))
      return make(i)
    }),
  )
}

// ---------- stats ----------
const KEYS: (keyof Omit<LatencySummary, 'stages'>)[] = [
  'ack_ms',
  'queue_wait_ms',
  'processing_ms',
  'to_outbound_request_ms',
  'outbound_api_ms',
  'to_meta_accepted_ms',
  'after_meta_ms',
  'total_processing_ms',
]
const STAGES = [
  'config_loaded',
  'contact_resolved',
  'conversation_resolved',
  'message_persisted',
  'bookkeeping_done',
  'flow_dispatch_started',
  'flow_run_started',
  'button_id_resolved',
  'flow_step_selected',
  'outbound_request_started',
  'outbound_accepted',
] as const

function pct(sorted: number[], p: number) {
  if (!sorted.length) return null
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}
function stats(values: (number | undefined)[]) {
  const ok = values.filter((v): v is number => typeof v === 'number').sort((a, b) => a - b)
  return {
    p50: pct(ok, 50),
    p95: pct(ok, 95),
    max: ok.length ? ok[ok.length - 1] : null,
    failures: values.length - ok.length,
  }
}

/** Share of measured traces under 1 s (duplicate deliveries count as their own traces). */
function under1s(values: (number | undefined)[]) {
  const measured = values.filter((v): v is number => typeof v === 'number')
  if (!measured.length) return 0
  return Math.round((measured.filter((v) => v < 1000).length / measured.length) * 1000) / 10
}

const report: Record<string, unknown> = {
  mocked: true,
  mode: BENCH ? 'bench' : 'quick',
  label: process.env.LATENCY_BENCH_LABEL ?? 'unlabelled',
  model: {
    resolve_inbound_context_installed: RPC_INSTALLED,
    supabase_rtt_ms: BENCH ? '156–285 (p50 180), sampled from real webhook stage timings' : '2',
    meta_send_ms: BENCH ? '802–1700 (p50 1244), sampled from real Meta send timings' : '3',
    config_cache_ttl_ms: process.env.WHATSAPP_CONFIG_CACHE_TTL_MS ?? '0',
  },
  scenarios: {},
}

function summarize(name: string, summaries: LatencySummary[], db: FakeDb, events: number) {
  const target = summaries.filter(
    (s) => s.to_outbound_request_ms !== undefined && s.to_outbound_request_ms < 1000,
  ).length
  const entry = {
    events,
    traces: summaries.length,
    meta_calls: metaCalls.length,
    db_queries_per_event: Math.round((db.queries / events) * 10) / 10,
    under_1s_to_outbound_request_pct:
      summaries.length ? Math.round((target / events) * 1000) / 10 : 0,
    under_1s_outbound_api_pct: under1s(summaries.map((s) => s.outbound_api_ms)),
    under_1s_total_processing_pct: under1s(summaries.map((s) => s.total_processing_ms)),
    totals: Object.fromEntries(KEYS.map((k) => [k, stats(summaries.map((s) => s[k]))])),
    stage_offsets_ms: Object.fromEntries(
      STAGES.map((st) => [st, stats(summaries.map((s) => s.stages[st]))]),
    ),
  }
  ;(report.scenarios as Record<string, unknown>)[name] = entry
  return entry
}

// ---------- harness ----------
let db: FakeDb
let traces: LatencySummary[] = []
let unsubscribe: () => void = () => {}

function freshDb(scale = 1) {
  db = new FakeDb({ latency: dbLatency(scale) })
  if (RPC_INSTALLED) db.functions.add('resolve_inbound_context')
  h.db = db
  return db
}

beforeEach(() => {
  invalidateWhatsAppConfigCache()
  resetInboundContextRpcAvailability()
  metaMode = 'ok'
  metaCalls = []
  traces = []
  h.after = []
  vi.stubGlobal('fetch', fakeFetch)
  unsubscribe = onLatencyTrace((t) => traces.push(summarizeLatency(t)))
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
  unsubscribe()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const TIMEOUT = BENCH ? 180_000 : 20_000

describe('inbound latency (mocked Supabase + mocked Meta)', () => {
  it('simple text from a new contact → one interactive language welcome each', async () => {
    seed(freshDb(), { flowStatus: 'active' })
    await burst(EVENTS, (i) => deliver(textPayload(i, `wamid.text.${i}`)))
    const s = summarize('simple_text_welcome', traces, db, EVENTS)

    expect(metaCalls).toHaveLength(EVENTS)
    expect(metaCalls.every((c) => c.type === 'interactive')).toBe(true)
    expect(metaCalls.every((c) => c.body === WELCOME_TEXT)).toBe(true)
    expect(metaCalls[0].buttonIds).toEqual(['lang_te', 'lang_en', 'lang_hi'])
    expect(new Set(metaCalls.map((c) => c.to)).size).toBe(EVENTS)
    expect(s.totals.to_outbound_request_ms.failures).toBe(0)

    // Audit rows written concurrently still read back in logical order.
    const runId = db.rows('flow_runs')[0].id
    const timeline = db
      .rows('flow_run_events')
      .filter((e) => e.flow_run_id === runId)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
      .map((e) => `${e.event_type}:${e.node_key}`)
    expect(timeline).toEqual([
      'started:start',
      'node_entered:start',
      'node_entered:welcome',
      'message_sent:welcome',
    ])
  }, TIMEOUT)

  it('co-located Supabase (≈5 ms RTT) — deployment-region sensitivity', async () => {
    seed(freshDb(0.03), { flowStatus: 'active' })
    await burst(EVENTS, (i) => deliver(textPayload(i, `wamid.colo.${i}`)))
    const s = summarize('colocated_supabase_5ms', traces, db, EVENTS)
    expect(metaCalls).toHaveLength(EVENTS)
    expect(s.totals.to_outbound_request_ms.failures).toBe(0)
  }, TIMEOUT)

  it('language button tap is routed by payload id to that language’s next step', async () => {
    seed(freshDb(), { flowStatus: 'active' })
    seedParkedRuns(EVENTS, () => 'welcome')
    await burst(EVENTS, (i) =>
      deliver(buttonPayload(i, `wamid.tap.${i}`, languageReplyId(langFor(i)), `wamid.prompt.${i}`)),
    )
    const s = summarize('language_button_tap', traces, db, EVENTS)

    expect(metaCalls).toHaveLength(EVENTS)
    for (let i = 0; i < EVENTS; i++) {
      const lang = langFor(i)
      const [call] = callTo(i)
      expect(call.body).toBe(MESSAGES.categoryPrompt[lang])
      expect(call.rowIds).toEqual([...CATEGORIES.map((c) => c.id), 'solar_talk_sales'])
      expect(runOf(i).current_node_key).toBe(`${lang}_category`)
      expect((runOf(i).vars as Record<string, unknown>).language).toBe(languageReplyId(lang))
      const prompt = db
        .rows('messages')
        .find((m) => m.sender_type === 'bot' && m.conversation_id === `cv-${i}` && m.id !== `m-prompt-${i}`)
      expect(prompt).toBeDefined()
      expect(runOf(i).last_prompt_message_id).toBe(prompt!.id)
    }
    // The tap is stored quoting the welcome it answered.
    const taps = db.rows('messages').filter((m) => m.sender_type === 'customer')
    expect(taps.every((m) => String(m.reply_to_message_id).startsWith('m-prompt-'))).toBe(true)
    expect(s.totals.to_outbound_request_ms.failures).toBe(0)
    expect(traces.every((t) => t.stages.button_id_resolved !== undefined && t.stages.flow_step_selected !== undefined)).toBe(true)
  }, TIMEOUT)

  it('category tap continues the chosen language’s qualification questions', async () => {
    seed(freshDb(), { flowStatus: 'active' })
    seedParkedRuns(EVENTS, (i) => `${langFor(i)}_category`, (i) => ({ language: languageReplyId(langFor(i)) }))
    const catFor = (i: number) => CATEGORIES[i % CATEGORIES.length]
    await burst(EVENTS, (i) =>
      deliver(buttonPayload(i, `wamid.cat.${i}`, catFor(i).id, `wamid.prompt.${i}`, 'list_reply')),
    )
    const s = summarize('category_list_tap', traces, db, EVENTS)

    expect(metaCalls).toHaveLength(EVENTS)
    for (let i = 0; i < EVENTS; i++) {
      const lang = langFor(i)
      const cat = catFor(i)
      expect(callTo(i)[0].body).toBe(CATEGORY_QUESTIONS[cat.id][0].text[lang])
      expect(runOf(i).current_node_key).toBe(`${lang}_${cat.short}_1`)
      expect(runOf(i).vars).toMatchObject({ language: languageReplyId(lang), solar_category: cat.id })
    }
    expect(metaCalls.some((c) => c.body === WELCOME_TEXT)).toBe(false)
    expect(s.totals.to_outbound_request_ms.failures).toBe(0)
  }, TIMEOUT)

  it('duplicate button deliveries (concurrent and replay) produce one reply', async () => {
    seed(freshDb(), { flowStatus: 'active' })
    seedParkedRuns(EVENTS, () => 'welcome')
    await burst(EVENTS, async (i) => {
      const payload = buttonPayload(i, `wamid.duptap.${i}`, languageReplyId(langFor(i)), `wamid.prompt.${i}`)
      await Promise.all([deliver(payload), deliver(payload)])
      await deliver(payload)
    })
    summarize('duplicate_button_taps', traces, db, EVENTS)

    expect(metaCalls).toHaveLength(EVENTS)
    for (let i = 0; i < EVENTS; i++) expect(callTo(i)).toHaveLength(1)
    expect(db.rows('messages').filter((m) => m.sender_type === 'customer')).toHaveLength(EVENTS)
  }, TIMEOUT)

  it('unknown button id re-shows the language menu and saves nothing', async () => {
    seed(freshDb(), { flowStatus: 'active' })
    seedParkedRuns(EVENTS, () => 'welcome')
    await burst(EVENTS, (i) => deliver(buttonPayload(i, `wamid.unknown.${i}`, i % 2 ? 'lang_xx' : 'language_te', `wamid.prompt.${i}`)))
    summarize('unknown_button_id', traces, db, EVENTS)

    expect(metaCalls).toHaveLength(EVENTS)
    expect(metaCalls.every((c) => c.body === WELCOME_TEXT)).toBe(true)
    expect(metaCalls[0].buttonIds).toEqual(['lang_te', 'lang_en', 'lang_hi'])
    for (let i = 0; i < EVENTS; i++) {
      expect(runOf(i)).toMatchObject({ status: 'active', current_node_key: 'welcome', reprompt_count: 1 })
      expect((runOf(i).vars as Record<string, unknown>).language).toBeUndefined()
    }
  }, TIMEOUT)

  it('Supabase write failure while saving the selection sends nothing and leaves the step unchanged', async () => {
    seed(freshDb(), { flowStatus: 'active' })
    seedParkedRuns(EVENTS, () => 'welcome')
    db.failWrites.add('flow_runs')
    const responses: Response[] = []
    await burst(EVENTS, async (i) =>
      responses.push(await deliver(buttonPayload(i, `wamid.dbfail.${i}`, languageReplyId(langFor(i)), `wamid.prompt.${i}`))),
    )
    expect(responses.every((r) => r.status === 200)).toBe(true)
    expect(metaCalls).toHaveLength(0)
    for (let i = 0; i < EVENTS; i++) {
      expect(runOf(i).current_node_key).toBe('welcome')
      expect((runOf(i).vars as Record<string, unknown>).language).toBeUndefined()
    }
  }, TIMEOUT)

  it('the bot reply still lands after the unread bump when the bump is slow', async () => {
    seed(freshDb(), { flowStatus: 'active' })
    seedParkedRuns(EVENTS, () => 'welcome')
    const SLOW_BUMP_MS = BENCH ? 1500 : 80
    const rpc = db.rpc.bind(db)
    db.rpc = ((name: string, args: Record<string, unknown>) =>
      name === 'bump_conversation_on_inbound'
        ? new Promise((r) => setTimeout(r, SLOW_BUMP_MS)).then(() => rpc(name, args))
        : rpc(name, args)) as unknown as typeof db.rpc
    await burst(EVENTS, (i) => deliver(buttonPayload(i, `wamid.order.${i}`, languageReplyId(langFor(i)), `wamid.prompt.${i}`)))

    expect(metaCalls).toHaveLength(EVENTS)
    for (let i = 0; i < EVENTS; i++) {
      const conv = db.rows('conversations').find((c) => c.id === `cv-${i}`)!
      expect(conv.unread_count).toBe(1)
      expect(conv.last_message_text).toBe(MESSAGES.categoryPrompt[langFor(i)])
    }
  }, TIMEOUT)

  it('opted-out contact tapping a button gets no reply and the run does not advance', async () => {
    seed(freshDb(), { flowStatus: 'active' })
    seedParkedRuns(EVENTS, () => 'welcome')
    for (const c of db.rows('contacts')) c.opted_out_at = '2026-10-01T00:00:00Z'
    await burst(EVENTS, (i) => deliver(buttonPayload(i, `wamid.optout.${i}`, 'lang_te', `wamid.prompt.${i}`)))
    expect(metaCalls).toHaveLength(0)
    expect(db.rows('flow_runs').every((r) => r.current_node_key === 'welcome')).toBe(true)
  }, TIMEOUT)

  it('Supabase failure storing the inbound tap sends nothing and does not advance', async () => {
    seed(freshDb(), { flowStatus: 'active' })
    seedParkedRuns(EVENTS, () => 'welcome')
    db.failWrites.add('messages')
    await burst(EVENTS, (i) => deliver(buttonPayload(i, `wamid.msgfail.${i}`, 'lang_en', `wamid.prompt.${i}`)))
    expect(metaCalls).toHaveLength(0)
    expect(db.rows('flow_runs').every((r) => r.current_node_key === 'welcome')).toBe(true)
  }, TIMEOUT)

  it('slow Meta API is measured separately from our own processing', async () => {
    seed(freshDb(), { flowStatus: 'active' })
    seedParkedRuns(EVENTS, () => 'welcome')
    metaMode = 'slow'
    await burst(EVENTS, (i) => deliver(buttonPayload(i, `wamid.slowmeta.${i}`, 'lang_en', `wamid.prompt.${i}`)))
    const s = summarize('slow_meta_api', traces, db, EVENTS)

    expect(metaCalls).toHaveLength(EVENTS)
    for (const t of traces) {
      expect(t.outbound_api_ms!).toBeGreaterThanOrEqual(SLOW_META_MS - 5)
      expect(t.to_meta_accepted_ms! - t.to_outbound_request_ms!).toBeCloseTo(t.outbound_api_ms!, 0)
    }
    // Our side stops the clock when the request leaves; Meta's time is not folded into it.
    expect(s.totals.to_outbound_request_ms.max!).toBeLessThan(s.totals.to_meta_accepted_ms.p50!)
  }, TIMEOUT)

  it('duplicate deliveries (concurrent and later replay) send one welcome', async () => {
    seed(freshDb(), { flowStatus: 'active' })
    await burst(EVENTS, async (i) => {
      const payload = textPayload(i, `wamid.dup.${i}`)
      await Promise.all([deliver(payload), deliver(payload)])
      await deliver(payload)
    })
    summarize('duplicates', traces, db, EVENTS)

    expect(metaCalls).toHaveLength(EVENTS)
    expect(new Set(metaCalls.map((c) => c.to)).size).toBe(EVENTS)
    const inbound = db.rows('messages').filter((m) => m.sender_type === 'customer')
    expect(inbound).toHaveLength(EVENTS)
    expect(db.rows('flow_runs')).toHaveLength(EVENTS)
  }, TIMEOUT)

  it('slow Supabase (3× RTT) still replies once per event', async () => {
    seed(freshDb(3), { flowStatus: 'active' })
    await burst(EVENTS, (i) => deliver(textPayload(i, `wamid.slow.${i}`)))
    const s = summarize('slow_supabase_3x', traces, db, EVENTS)
    expect(metaCalls).toHaveLength(EVENTS)
    expect(s.totals.to_outbound_request_ms.failures).toBe(0)
  }, TIMEOUT)

  it('Meta timeout fails the run without recording a sent message', async () => {
    seed(freshDb(), { flowStatus: 'active' })
    metaMode = 'timeout'
    await burst(EVENTS, (i) => deliver(textPayload(i, `wamid.timeout.${i}`)))
    summarize('meta_timeout', traces, db, EVENTS)

    expect(metaCalls).toHaveLength(EVENTS)
    expect(db.rows('messages').filter((m) => m.sender_type === 'bot')).toHaveLength(0)
    expect(db.rows('flow_runs').every((r) => r.status === 'failed')).toBe(true)
    expect(traces.every((t) => t.stages.outbound_failed !== undefined)).toBe(true)
  }, TIMEOUT)

  it('Meta rate limit (429 / 130429) fails the run without recording a sent message', async () => {
    seed(freshDb(), { flowStatus: 'active' })
    metaMode = 'rate_limit'
    await burst(EVENTS, (i) => deliver(textPayload(i, `wamid.rl.${i}`)))
    summarize('meta_rate_limit', traces, db, EVENTS)

    expect(metaCalls).toHaveLength(EVENTS)
    expect(db.rows('messages').filter((m) => m.sender_type === 'bot')).toHaveLength(0)
    expect(db.rows('flow_runs').every((r) => r.status === 'failed')).toBe(true)
  }, TIMEOUT)

  it('queue delay with a Meta retry arriving first still sends one welcome', async () => {
    seed(freshDb(), { flowStatus: 'active' })
    await burst(EVENTS, async (i) => {
      const payload = textPayload(i, `wamid.queue.${i}`)
      await Promise.all([
        deliver(payload, { queueDelayMs: BENCH ? 3000 : 30 }),
        new Promise((r) => setTimeout(r, BENCH ? 1000 : 10)).then(() => deliver(payload)),
      ])
    })
    summarize('queue_delay_and_retry', traces, db, EVENTS)

    expect(metaCalls).toHaveLength(EVENTS)
    expect(db.rows('flow_runs')).toHaveLength(EVENTS)
  }, TIMEOUT)

  it('disabled automation + draft flow (current intended state) sends nothing', async () => {
    seed(freshDb(), { flowStatus: 'draft', automationActive: false })
    await burst(EVENTS, (i) => deliver(textPayload(i, `wamid.off.${i}`)))
    summarize('disabled_automation_draft_flow', traces, db, EVENTS)

    expect(metaCalls).toHaveLength(0)
    expect(db.rows('flow_runs')).toHaveLength(0)
    expect(db.rows('messages').filter((m) => m.sender_type === 'customer')).toHaveLength(EVENTS)
  }, TIMEOUT)

  it('draft flow alone never auto-replies', async () => {
    seed(freshDb(), { flowStatus: 'draft' })
    await burst(EVENTS, (i) => deliver(textPayload(i, `wamid.draft.${i}`)))
    expect(metaCalls).toHaveLength(0)
    expect(db.rows('flow_runs')).toHaveLength(0)
  }, TIMEOUT)

  it('invalid signature is rejected before any database work', async () => {
    seed(freshDb(), { flowStatus: 'active' })
    const responses: Response[] = []
    await burst(EVENTS, async (i) =>
      responses.push(await deliver(textPayload(i, `wamid.bad.${i}`), { badSignature: true })),
    )
    expect(responses.every((r) => r.status === 401)).toBe(true)
    expect(db.queries).toBe(0)
    expect(metaCalls).toHaveLength(0)
  }, TIMEOUT)

  it('final qualification answer runs score, CRM update and checks before the last message', async () => {
    seed(freshDb(), { flowStatus: 'active' })
    db.seed(
      'custom_fields',
      LEAD_FLOW_CUSTOM_FIELDS.map(([name], i) => ({ id: `cf-${i}`, account_id: ACCOUNT, name })),
    )
    // Answers that score HOT (timeline 30 + roof 10 + callback 20), so both
    // tag nodes run, as in the real journey.
    seedParkedRuns(EVENTS, (i) => `${langFor(i)}_confirm`, (i) => ({
      language: languageReplyId(langFor(i)),
      solar_category: CATEGORIES[i % CATEGORIES.length].id,
      timeline: 'timeline_1m',
      res_roof: 'res_roof_rcc',
    }))
    await burst(EVENTS, (i) =>
      deliver(buttonPayload(i, `wamid.last.${i}`, 'callback_yes', `wamid.prompt.${i}`)),
    )
    const s = summarize('final_answer_to_closing_message', traces, db, EVENTS)
    expect(metaCalls).toHaveLength(EVENTS)
    for (let i = 0; i < EVENTS; i++) {
      expect(callTo(i)[0].body).toBe(MESSAGES.finalCallback[langFor(i)])
      expect((runOf(i).vars as Record<string, unknown>).lead_score).toBeDefined()
    }
    // CRM fields, the lead note and every audit row are persisted.
    expect(db.rows('contact_custom_values').length).toBeGreaterThan(0)
    const payloadOf = (e: Record<string, unknown>) => (e.payload ?? {}) as Record<string, unknown>
    const events = db.rows('flow_run_events')
    expect(events.filter((e) => e.node_key === 'score' && payloadOf(e).score !== undefined)).toHaveLength(EVENTS)
    expect(
      events.filter((e) => e.node_key === 'crm_update' && payloadOf(e).updated_fields !== undefined),
    ).toHaveLength(EVENTS)
    expect(db.rows('contact_notes')).toHaveLength(EVENTS)
    // Both tags are written before the closing message, once per contact.
    expect(db.rows('contact_tags')).toHaveLength(EVENTS * 2)
    expect(s.totals.to_outbound_request_ms.failures).toBe(0)
  }, TIMEOUT)

  it('cached config: a second message skips the config read; invalidation forces a fresh one', async () => {
    process.env.WHATSAPP_CONFIG_CACHE_TTL_MS = '30000'
    try {
      seed(freshDb(), { flowStatus: 'active' })
      // The per-table path is the one that reads the cache.
      db.functions.delete('resolve_inbound_context')
      await deliver(textPayload(900, 'wamid.cache.1'))
      const configReads = () => db.reads.filter((t) => t === 'whatsapp_config').length
      expect(configReads()).toBe(1)
      await deliver(textPayload(901, 'wamid.cache.2'))
      expect(configReads()).toBe(1)
      invalidateWhatsAppConfigCache('acc-bench')
      await deliver(textPayload(902, 'wamid.cache.3'))
      expect(configReads()).toBe(2)
      expect(metaCalls).toHaveLength(3)
    } finally {
      delete process.env.WHATSAPP_CONFIG_CACHE_TTL_MS
    }
  }, TIMEOUT)

  it('a missing config is never cached', async () => {
    process.env.WHATSAPP_CONFIG_CACHE_TTL_MS = '30000'
    try {
      freshDb()
      await deliver(textPayload(910, 'wamid.nocfg.1'))
      seed(db, { flowStatus: 'active' })
      await deliver(textPayload(911, 'wamid.nocfg.2'))
      expect(metaCalls).toHaveLength(1)
    } finally {
      delete process.env.WHATSAPP_CONFIG_CACHE_TTL_MS
    }
  }, TIMEOUT)

  it('writes the report', () => {
    const dir = process.env.LATENCY_BENCH_OUT ?? join(tmpdir(), 'wacrm-latency')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${report.label}-${report.mode}.json`), JSON.stringify(report, null, 2))
  })
})

describe('durable webhook inbox (WHATSAPP_WEBHOOK_INBOX=1, migration 056 draft)', { timeout: TIMEOUT }, () => {
  beforeEach(() => {
    process.env.WHATSAPP_WEBHOOK_INBOX = '1'
    process.env.AUTOMATION_CRON_SECRET = 'bench-cron-secret'
  })
  afterEach(() => {
    delete process.env.WHATSAPP_WEBHOOK_INBOX
    delete process.env.AUTOMATION_CRON_SECRET
  })

  function sweep() {
    return SWEEP(
      new Request('http://localhost/api/whatsapp/webhook/sweep', {
        headers: { 'x-cron-secret': 'bench-cron-secret' },
      }),
    )
  }

  it('records the event before acknowledging and marks it done after processing', async () => {
    seed(freshDb(), { flowStatus: 'active' })
    const res = await deliver(textPayload(1, 'wamid.inbox.1'))
    expect(res.status).toBe(200)
    const rows = db.rows('whatsapp_webhook_inbox')
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('done')
    expect(metaCalls).toHaveLength(1)
  })

  it('answers 503 (so Meta retries) when the event cannot be stored, and does no work', async () => {
    seed(freshDb(), { flowStatus: 'active' })
    db.failWrites.add('whatsapp_webhook_inbox')
    const res = await deliver(textPayload(2, 'wamid.inbox.2'))
    expect(res.status).toBe(503)
    expect(db.rows('messages')).toHaveLength(0)
    expect(metaCalls).toHaveLength(0)
  })

  it('a redelivered identical body is acknowledged without being processed again', async () => {
    seed(freshDb(), { flowStatus: 'active' })
    const payload = textPayload(3, 'wamid.inbox.3')
    await deliver(payload)
    const before = db.queries
    const res = await deliver(payload)
    expect(res.status).toBe(200)
    expect(db.rows('whatsapp_webhook_inbox')).toHaveLength(1)
    expect(db.queries - before).toBe(1)
    expect(metaCalls).toHaveLength(1)
  })

  it('the sweep finishes an event whose processing never ran, exactly once', async () => {
    seed(freshDb(), { flowStatus: 'active' })
    const raw = JSON.stringify(textPayload(4, 'wamid.inbox.4'))
    // Accepted, then the process "dies" before the after() work runs.
    await POST(
      new Request('http://localhost/api/whatsapp/webhook', {
        method: 'POST',
        headers: { 'x-hub-signature-256': sign(raw) },
        body: raw,
      }),
    )
    h.after.splice(0)
    expect(metaCalls).toHaveLength(0)
    db.rows('whatsapp_webhook_inbox')[0].received_at = new Date(Date.now() - 10 * 60_000).toISOString()

    const first = await (await sweep()).json()
    expect(first).toMatchObject({ reprocessed: 1, failed: 0 })
    expect(metaCalls).toHaveLength(1)
    expect(db.rows('whatsapp_webhook_inbox')[0].status).toBe('done')

    // Nothing left to do; and replaying an already-stored message can't
    // send a second welcome.
    expect(await (await sweep()).json()).toMatchObject({ reprocessed: 0 })
    const row = db.rows('whatsapp_webhook_inbox')[0]
    row.status = 'failed'
    expect(await (await sweep()).json()).toMatchObject({ reprocessed: 1 })
    expect(metaCalls).toHaveLength(1)
  })

  it('the sweep requires the cron secret', async () => {
    freshDb()
    const res = await SWEEP(new Request('http://localhost/api/whatsapp/webhook/sweep'))
    expect(res.status).toBe(401)
  })
})

describe('resolve_inbound_context (migration 058, emulated)', { timeout: TIMEOUT }, () => {
  const RPC = 'resolve_inbound_context'
  const rpcCount = () => db.rpcCalls.filter((n) => n === RPC).length
  const bot = () => db.rows('messages').filter((m) => m.sender_type === 'bot')
  const customer = () => db.rows('messages').filter((m) => m.sender_type === 'customer')
  function installed() {
    seed(freshDb(), { flowStatus: 'active' })
    db.functions.add(RPC)
    return db
  }

  it('new sender: config, contact and conversation in one call, then the welcome', async () => {
    installed()
    await deliver(textPayload(1, 'wamid.rpc.new'))
    expect(rpcCount()).toBe(1)
    expect(db.reads).not.toContain('whatsapp_config')
    expect(db.rows('contacts')).toHaveLength(1)
    expect(db.rows('contacts')[0]).toMatchObject({ account_id: ACCOUNT, user_id: 'user-bench', phone: phoneFor(1) })
    expect(db.rows('conversations')).toHaveLength(1)
    expect(customer()).toHaveLength(1)
    expect(metaCalls).toHaveLength(1)
    expect(metaCalls[0].body).toBe(WELCOME_TEXT)
  })

  it('existing contact: reuses the contact and its conversation; a tap advances the flow', async () => {
    installed()
    seedParkedRuns(1, () => 'welcome')
    await deliver(buttonPayload(0, 'wamid.rpc.tap', 'lang_en', 'wamid.prompt.0'))
    expect(db.rows('contacts')).toHaveLength(1)
    expect(db.rows('conversations')).toHaveLength(1)
    expect(metaCalls).toHaveLength(1)
    expect(metaCalls[0].body).toBe(MESSAGES.categoryPrompt.en)
    expect(runOf(0).current_node_key).toBe('en_category')
  })

  it('existing contact without a conversation gets one, without a second lookup', async () => {
    installed()
    db.seed('contacts', [{ id: 'ct-lone', account_id: ACCOUNT, user_id: 'user-bench', phone: phoneFor(5), name: 'Lead 5' }])
    await deliver(textPayload(5, 'wamid.rpc.noconv'))
    expect(db.rows('contacts')).toHaveLength(1)
    expect(db.rows('conversations')).toHaveLength(1)
    expect(db.rows('conversations')[0].contact_id).toBe('ct-lone')
    expect(metaCalls).toHaveLength(1)
  })

  it('takes fewer round trips than the per-table path for the same messages', async () => {
    const queriesFor = async (withRpc: boolean) => {
      resetInboundContextRpcAvailability()
      invalidateWhatsAppConfigCache()
      seed(freshDb(), { flowStatus: 'active' })
      if (withRpc) db.functions.add(RPC)
      else db.functions.delete(RPC)
      seedParkedRuns(1, () => 'welcome')
      await deliver(textPayload(20, 'wamid.rpc.cmp.new'))
      await deliver(buttonPayload(0, 'wamid.rpc.cmp.tap', 'lang_en', 'wamid.prompt.0'))
      return db.queries
    }
    const perTable = await queriesFor(false)
    const viaRpc = await queriesFor(true)
    expect(viaRpc).toBeLessThan(perTable)
  })

  it('concurrent first messages from one new sender: one contact, one conversation, one welcome', async () => {
    installed()
    await Promise.all([
      deliver(textPayload(7, 'wamid.rpc.c1', 'Hi')),
      deliver(textPayload(7, 'wamid.rpc.c2', 'Hello')),
      deliver(textPayload(7, 'wamid.rpc.c3', 'Solar?')),
    ])
    expect(db.rows('contacts')).toHaveLength(1)
    expect(db.rows('conversations')).toHaveLength(1)
    expect(customer()).toHaveLength(3)
    expect(metaCalls.filter((c) => c.body === WELCOME_TEXT)).toHaveLength(1)
  })

  it('duplicate deliveries (concurrent and replay) store one message and send one welcome', async () => {
    installed()
    const payload = textPayload(8, 'wamid.rpc.dup')
    await Promise.all([deliver(payload), deliver(payload)])
    await deliver(payload)
    expect(db.rows('contacts')).toHaveLength(1)
    expect(customer()).toHaveLength(1)
    expect(metaCalls).toHaveLength(1)
  })

  it('function not installed: per-table path, and the call is not retried for every message', async () => {
    seed(freshDb(), { flowStatus: 'active' })
    db.functions.delete(RPC)
    await deliver(textPayload(10, 'wamid.rpc.missing.1'))
    await deliver(textPayload(11, 'wamid.rpc.missing.2'))
    expect(rpcCount()).toBe(1)
    expect(db.reads).toContain('whatsapp_config')
    expect(db.rows('contacts')).toHaveLength(2)
    expect(metaCalls).toHaveLength(2)
  })

  it('function fails: that message falls back to the per-table path and is still answered once', async () => {
    installed()
    db.failRpc.add(RPC)
    await deliver(textPayload(12, 'wamid.rpc.fail.1'))
    await deliver(textPayload(13, 'wamid.rpc.fail.2'))
    // A transient failure is not remembered as "not installed".
    expect(rpcCount()).toBe(2)
    expect(db.rows('contacts')).toHaveLength(2)
    expect(customer()).toHaveLength(2)
    expect(metaCalls).toHaveLength(2)
  })

  it('contact write failure: nothing stored, nothing sent, nothing marked sent', async () => {
    installed()
    db.failWrites.add('contacts')
    const res = await deliver(textPayload(14, 'wamid.rpc.cfail'))
    expect(res.status).toBe(200)
    expect(db.rows('contacts')).toHaveLength(0)
    expect(customer()).toHaveLength(0)
    expect(bot()).toHaveLength(0)
    expect(metaCalls).toHaveLength(0)
  })

  it('conversation write failure rolls the new contact back; nothing is sent', async () => {
    installed()
    db.failWrites.add('conversations')
    await deliver(textPayload(15, 'wamid.rpc.vfail'))
    expect(db.rows('conversations')).toHaveLength(0)
    expect(customer()).toHaveLength(0)
    expect(bot()).toHaveLength(0)
    expect(metaCalls).toHaveLength(0)
  })

  it('no config for the receiving number: dropped before any contact is created', async () => {
    freshDb()
    db.functions.add(RPC)
    await deliver(textPayload(16, 'wamid.rpc.nocfg'))
    expect(db.rows('contacts')).toHaveLength(0)
    expect(metaCalls).toHaveLength(0)
  })

  it('opted-out existing contact: stored, no reply', async () => {
    installed()
    seedParkedRuns(1, () => 'welcome')
    for (const c of db.rows('contacts')) c.opted_out_at = '2026-10-01T00:00:00Z'
    await deliver(buttonPayload(0, 'wamid.rpc.optout', 'lang_te', 'wamid.prompt.0'))
    expect(customer()).toHaveLength(1)
    expect(metaCalls).toHaveLength(0)
  })

  it('draft flow: the message is stored and nothing is sent', async () => {
    seed(freshDb(), { flowStatus: 'draft', automationActive: false })
    db.functions.add(RPC)
    await deliver(textPayload(17, 'wamid.rpc.draft'))
    expect(customer()).toHaveLength(1)
    expect(metaCalls).toHaveLength(0)
    expect(db.rows('flow_runs')).toHaveLength(0)
  })
})
