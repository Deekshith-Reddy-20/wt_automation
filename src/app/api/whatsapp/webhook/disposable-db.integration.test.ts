import { execFileSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// ============================================================
// Integration tests against a DISPOSABLE local database (migration 058).
//
// Skipped unless WACRM_DISPOSABLE_DB=1. Expects, on this machine only, the
// stack from scripts/disposable-db/up.ps1 (removed by down.ps1):
//   * Docker container `wacrm058-db` (supabase/postgres) on 127.0.0.1:55432
//     with every migration in supabase/migrations applied;
//   * PostgREST on 127.0.0.1:55433 using the JWT secret below.
// Runs the real webhook route, inbound processing, Flows engine and
// Supabase client end to end. Every request is routed by the fetch stub:
// the fake Supabase host goes to the local PostgREST, Meta's Graph API is
// answered in-process, and anything else throws, so neither the hosted
// Supabase project nor Meta can be reached.
//
// WACRM_DISPOSABLE_BENCH=1 adds 100-event latency runs (local Docker
// database: round-trip counts are real, timings are NOT representative of
// hosted Supabase).
// ============================================================

const ENABLED = process.env.WACRM_DISPOSABLE_DB === '1'
const BENCH = ENABLED && process.env.WACRM_DISPOSABLE_BENCH === '1'
const CONTAINER = 'wacrm058-db'
const LOCAL_REST = 'http://127.0.0.1:55433/'
const JWT_SECRET = 'disposable-local-only-jwt-secret-not-for-prod-0001'
const OWNER = '00000000-0000-4000-8000-000000000001'
const PHONE_NUMBER_ID = 'pn-disposable-058'

const h = vi.hoisted(() => {
  const FAKE_SUPABASE = 'http://disposable-db.invalid'
  process.env.NEXT_PUBLIC_SUPABASE_URL = FAKE_SUPABASE
  process.env.WHATSAPP_CONFIG_CACHE_TTL_MS = '0'
  const state = {
    FAKE_SUPABASE,
    realFetch: globalThis.fetch,
    restCalls: 0,
    rpcCalls: [] as string[],
    meta: [] as { to: string; type: string; kind?: string; body: string; options: string[]; id: string }[],
    metaMode: 'ok' as 'ok' | 'fail',
    outCounter: 0,
    after: [] as (() => Promise<void> | void)[],
    /** Method + table / function name and timing of every request; no row data. */
    timeline: [] as { label: string; start: number; end: number }[],
  }
  const timed = async (label: string, run: () => Promise<Response>) => {
    const entry = { label, start: performance.now(), end: 0 }
    state.timeline.push(entry)
    try {
      return await run()
    } finally {
      entry.end = performance.now()
    }
  }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const restPrefix = `${FAKE_SUPABASE}/rest/v1/`
    if (url.startsWith(restPrefix)) {
      state.restCalls++
      const path = url.slice(restPrefix.length)
      if (path.startsWith('rpc/')) state.rpcCalls.push(path.slice(4).split('?')[0])
      const target = 'http://127.0.0.1:55433/' + path
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
      return timed(`${method} ${path.split('?')[0]}`, () =>
        input instanceof Request ? state.realFetch(new Request(target, input), init) : state.realFetch(target, init),
      )
    }
    if (url.startsWith('https://graph.facebook.com/') && url.endsWith('/messages')) {
      state.timeline.push({ label: 'META POST /messages', start: performance.now(), end: performance.now() })
      const body = JSON.parse(String(init?.body ?? '{}'))
      const id = `wamid.out.${++state.outCounter}`
      state.meta.push({
        to: body.to,
        type: body.type,
        kind: body.interactive?.type,
        body: body.interactive?.body?.text ?? body.text?.body ?? '',
        options: [
          ...(body.interactive?.action?.buttons ?? []).map((b: { reply: { id: string } }) => b.reply.id),
          ...(body.interactive?.action?.sections ?? []).flatMap((s: { rows: { id: string }[] }) => s.rows.map((r) => r.id)),
        ],
        id,
      })
      if (state.metaMode === 'fail') {
        return new Response(JSON.stringify({ error: { message: 'Service temporarily unavailable', code: 2, type: 'OAuthException' } }), { status: 503 })
      }
      return new Response(JSON.stringify({ messages: [{ id }] }), { status: 200 })
    }
    throw new Error(`disposable-db test: blocked outbound request to ${url}`)
  }) as typeof fetch
  return state
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
vi.mock('@/lib/ai/auto-reply', () => ({ dispatchInboundToAiReply: vi.fn(async () => {}) }))

import { SignJWT } from 'jose'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  CATEGORY_QUESTIONS,
  LEAD_FLOW_CUSTOM_FIELDS,
  LEAD_FLOW_NAME,
  LEAD_FLOW_TAGS,
  MESSAGES,
  WELCOME_TEXT,
  buildLeadFlow,
} from '@/lib/suraj-solar/lead-flow'
import { encrypt } from '@/lib/whatsapp/encryption'
import { invalidateWhatsAppConfigCache } from '@/lib/whatsapp/config-cache'
import { resetInboundContextRpcAvailability } from '@/lib/whatsapp/inbound-context-rpc'
import { onLatencyTrace, summarizeLatency, type LatencySummary } from '@/lib/whatsapp/latency-trace'
import { POST } from './route'

// ---------- disposable database access ----------
function psql(query: string, user = 'postgres'): string {
  return execFileSync(
    'docker',
    ['exec', '-i', CONTAINER, 'psql', '-U', user, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-AtqX', '-f', '-'],
    { input: query, encoding: 'utf8' },
  ).trim()
}

async function reloadRestSchema(expectRpc: boolean) {
  psql(`NOTIFY pgrst, 'reload schema';`)
  for (let i = 0; i < 50; i++) {
    const res = await h.realFetch(`${LOCAL_REST}rpc/resolve_inbound_context`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${keys.service}` },
      body: JSON.stringify({ p_phone_number_id: 'none', p_wa_user_id: null, p_phone_variants: [] }),
    })
    if ((res.status === 200) === expectRpc) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('PostgREST did not reload its schema cache')
}

const keys = { service: '', anon: '', authenticated: '' }
async function jwt(claims: Record<string, unknown>) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setExpirationTime('2h')
    .sign(new TextEncoder().encode(JWT_SECRET))
}
const client = (key: string) =>
  createClient(h.FAKE_SUPABASE, key, { auth: { persistSession: false, autoRefreshToken: false } })

let db: SupabaseClient
let accountId = ''

// ---------- payloads ----------
const RUN = String(Math.floor(Date.now() / 1000) % 100000).padStart(5, '0')
let phoneSeq = 0
const nextPhone = () => `919${RUN}${String(++phoneSeq).padStart(4, '0')}`
let wamidSeq = 0
const nextWamid = () => `wamid.disposable.${RUN}.${++wamidSeq}`

function textPayload(phone: string, wamid: string, text = 'Hi') {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-disposable',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550000000', phone_number_id: PHONE_NUMBER_ID },
              contacts: [{ wa_id: phone, profile: { name: `Lead ${phone.slice(-4)}` } }],
              messages: [
                { id: wamid, from: phone, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } },
              ],
            },
          },
        ],
      },
    ],
  }
}

function tapPayload(phone: string, wamid: string, replyId: string, contextId: string, kind: 'button_reply' | 'list_reply') {
  const p = textPayload(phone, wamid)
  const message = p.entry[0].changes[0].value.messages[0] as Record<string, unknown>
  delete message.text
  message.type = 'interactive'
  message.context = { from: '15550000000', id: contextId }
  message.interactive = { type: kind, [kind]: { id: replyId, title: replyId } }
  return p
}

function sign(raw: string) {
  return 'sha256=' + createHmac('sha256', process.env.META_APP_SECRET!).update(raw).digest('hex')
}

async function deliver(payload: unknown): Promise<Response> {
  const raw = JSON.stringify(payload)
  const res = await POST(
    new Request('http://localhost/api/whatsapp/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(raw) },
      body: raw,
    }),
  )
  const callbacks = h.after.splice(0)
  await Promise.all(callbacks.map((cb) => cb()))
  return res
}

const sentTo = (phone: string) => h.meta.filter((m) => m.to === phone)
const lastTo = (phone: string) => sentTo(phone).at(-1)!

/** Send a text, or tap the first option of the last prompt sent to `phone`. */
async function say(phone: string, text?: string) {
  return deliver(textPayload(phone, nextWamid(), text ?? 'Hi'))
}
async function tap(phone: string, replyId: string) {
  const last = lastTo(phone)
  const kind = last.kind === 'list' ? 'list_reply' : 'button_reply'
  return deliver(tapPayload(phone, nextWamid(), replyId, last.id, kind))
}

/** Answer the current question: type the city, otherwise tap the first option. */
async function answer(phone: string) {
  const options = lastTo(phone).options
  if (!options.length || options.includes('city_skip')) return say(phone, 'Vijayawada')
  return tap(phone, options[0])
}

// ---------- reads ----------
async function contactsFor(phone: string) {
  const { data, error } = await db.from('contacts').select('*').eq('account_id', accountId).eq('phone_normalized', phone)
  if (error) throw error
  return data as Record<string, unknown>[]
}
async function conversationsFor(contactId: string) {
  const { data, error } = await db.from('conversations').select('*').eq('contact_id', contactId)
  if (error) throw error
  return data as Record<string, unknown>[]
}
async function messagesIn(conversationId: string) {
  const { data, error } = await db
    .from('messages')
    .select('id, sender_type, status, message_id, content_text, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at')
  if (error) throw error
  return data as Record<string, unknown>[]
}
async function runFor(contactId: string) {
  const { data, error } = await db
    .from('flow_runs')
    .select('id, status, current_node_key, vars')
    .eq('contact_id', contactId)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data as Record<string, unknown> | null
}
async function customValues(contactId: string) {
  const { data, error } = await db
    .from('contact_custom_values')
    .select('value, custom_fields(field_name)')
    .eq('contact_id', contactId)
  if (error) throw error
  return Object.fromEntries(
    (data as unknown as { value: string; custom_fields: { field_name: string } }[]).map((r) => [r.custom_fields.field_name, r.value]),
  )
}

// ---------- seeding (disposable database only) ----------
async function must<T>(p: PromiseLike<{ data: T; error: unknown }>, what: string): Promise<T> {
  const { data, error } = await p
  if (error) throw new Error(`${what}: ${JSON.stringify(error)}`)
  return data
}

async function seed() {
  accountId = psql(`SELECT account_id FROM public.profiles WHERE user_id = '${OWNER}';`)
  expect(accountId).toMatch(/^[0-9a-f-]{36}$/)
  const base = { account_id: accountId, user_id: OWNER }

  const fields: Record<string, string> = {}
  for (const [name] of LEAD_FLOW_CUSTOM_FIELDS) {
    const existing = await must(db.from('custom_fields').select('id').eq('account_id', accountId).eq('field_name', name).maybeSingle(), `field ${name}`)
    fields[name] = (existing as { id: string } | null)?.id ??
      (await must(db.from('custom_fields').insert({ ...base, field_name: name, field_type: 'text' }).select('id').single(), `field ${name}`) as { id: string }).id
  }
  const tags: Record<string, string> = {}
  for (const name of [LEAD_FLOW_TAGS.newEnquiry, LEAD_FLOW_TAGS.hot]) {
    const existing = await must(db.from('tags').select('id').eq('account_id', accountId).eq('name', name).maybeSingle(), `tag ${name}`)
    tags[name] = (existing as { id: string } | null)?.id ??
      (await must(db.from('tags').insert({ ...base, name, color: '#3b82f6' }).select('id').single(), `tag ${name}`) as { id: string }).id
  }

  const def = buildLeadFlow({ fields, tags })
  await must(db.from('flows').delete().eq('account_id', accountId).eq('name', LEAD_FLOW_NAME), 'clear flow')
  const flow = (await must(
    db.from('flows').insert({
      ...base,
      name: def.name,
      description: def.description,
      trigger_type: def.trigger_type,
      trigger_config: def.trigger_config,
      entry_node_id: def.entry_node_id,
      fallback_policy: def.fallback_policy,
      // Active only inside this disposable database.
      status: 'active',
    }).select('id').single(),
    'create flow',
  )) as { id: string }
  await must(db.from('flow_nodes').insert(def.nodes.map((n) => ({ flow_id: flow.id, ...n }))), 'flow nodes')

  await must(db.from('whatsapp_config').delete().eq('account_id', accountId), 'clear config')
  await must(
    db.from('whatsapp_config').insert({
      ...base,
      phone_number_id: PHONE_NUMBER_ID,
      access_token: encrypt('disposable-not-a-real-token'),
    }),
    'config',
  )
}

// ---------- suite ----------
describe.skipIf(!ENABLED)('migration 058 on a disposable database (real Postgres + PostgREST)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    // Refuse anything but the disposable container bound to localhost.
    const ports = execFileSync('docker', ['port', CONTAINER, '5432/tcp'], { encoding: 'utf8' }).trim()
    expect(ports).toBe('127.0.0.1:55432')
    expect(psql(`SELECT count(*) FROM auth.users WHERE email = 'owner@disposable.example.invalid';`)).toBe('1')

    keys.service = await jwt({ role: 'service_role' })
    keys.anon = await jwt({ role: 'anon' })
    keys.authenticated = await jwt({ role: 'authenticated', sub: OWNER })
    process.env.SUPABASE_SERVICE_ROLE_KEY = keys.service
    db = client(keys.service)
    await seed()
  })

  beforeEach(() => {
    invalidateWhatsAppConfigCache()
    resetInboundContextRpcAvailability()
    h.metaMode = 'ok'
    h.rpcCalls = []
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('is installed as reviewed: VOLATILE, SECURITY INVOKER, pinned search_path, service_role only', async () => {
    expect(psql(`
      SELECT provolatile::text || ',' || prosecdef::text || ',' || array_to_string(proconfig, ';')
        FROM pg_proc WHERE proname = 'resolve_inbound_context';`)).toBe('v,false,search_path=public')
    const args = { p_phone_number_id: PHONE_NUMBER_ID, p_wa_user_id: null, p_phone_variants: ['910000000000'] }
    for (const key of [keys.anon, keys.authenticated]) {
      const { error } = await client(key).rpc('resolve_inbound_context', args)
      expect(error?.code).toBe('42501')
    }
    const { data, error } = await db.rpc('resolve_inbound_context', args)
    expect(error).toBeNull()
    expect(data).toMatchObject({ matched_by: null, contacts: [], contact_created: false })
    // The encrypted token is returned to service_role only.
    expect((data as { config: unknown[] }).config).toHaveLength(1)
  })

  it('new contact → one call creates contact + conversation; welcome with lang_te, lang_en, lang_hi', async () => {
    const phone = nextPhone()
    await say(phone, 'Hi')
    expect(h.rpcCalls.filter((n) => n === 'resolve_inbound_context')).toHaveLength(1)

    const [contact, ...extra] = await contactsFor(phone)
    expect(extra).toHaveLength(0)
    expect(contact).toMatchObject({ user_id: OWNER, name: `Lead ${phone.slice(-4)}` })
    const convs = await conversationsFor(contact.id as string)
    expect(convs).toHaveLength(1)

    expect(sentTo(phone)).toHaveLength(1)
    expect(lastTo(phone)).toMatchObject({ type: 'interactive', body: WELCOME_TEXT, options: ['lang_te', 'lang_en', 'lang_hi'] })
    const msgs = await messagesIn(convs[0].id as string)
    expect(msgs.map((m) => m.sender_type)).toEqual(['customer', 'bot'])
    expect(msgs[1].status).toBe('sent')
    expect(msgs[1].message_id).toBe(lastTo(phone).id)
    expect(await runFor(contact.id as string)).toMatchObject({ status: 'active' })
  })

  it('language selection, category buttons and the final answer write the lead before closing', async () => {
    const phone = nextPhone()
    await say(phone, 'namaskaram')
    await tap(phone, 'lang_en')
    expect(lastTo(phone)).toMatchObject({ body: MESSAGES.categoryPrompt.en })
    await tap(phone, 'solar_residential')
    const questions = CATEGORY_QUESTIONS.solar_residential
    expect(lastTo(phone).body).toBe(questions[0].text.en)
    for (let i = 0; i < questions.length; i++) {
      expect(lastTo(phone).body).toBe(questions[i].text.en)
      await answer(phone)
    }
    expect(lastTo(phone).body).toBe(MESSAGES.confirmation.en)
    await tap(phone, 'callback_yes')
    expect(lastTo(phone)).toMatchObject({ type: 'text', body: MESSAGES.finalCallback.en })

    const [contact, ...extra] = await contactsFor(phone)
    expect(extra).toHaveLength(0)
    const run = await runFor(contact.id as string)
    expect(run).toMatchObject({ status: 'handed_off' })
    expect(run!.vars).toMatchObject({ language: 'lang_en', solar_category: 'solar_residential' })
    const values = await customValues(contact.id as string)
    expect(values).toMatchObject({
      'Preferred language': 'English',
      'Solar requirement': 'Residential rooftop',
      'Callback preference': 'Yes, call me',
      'Lead source': 'WhatsApp',
    })
    expect(Number(values['Lead score'])).toBeGreaterThan(0)
    expect(values['Lead priority']).toMatch(/^(HOT|WARM|COLD)$/)
    const { data: notes } = await db.from('contact_notes').select('note_text').eq('contact_id', contact.id as string)
    expect(notes?.length).toBe(1)
    expect(String(notes![0].note_text)).toContain('Location: Vijayawada')

    const convs = await conversationsFor(contact.id as string)
    expect(convs).toHaveLength(1)
    expect(convs[0]).toMatchObject({ status: 'pending' })
    const msgs = await messagesIn(convs[0].id as string)
    const bot = msgs.filter((m) => m.sender_type === 'bot')
    expect(bot).toHaveLength(sentTo(phone).length)
    expect(bot.every((m) => m.status === 'sent')).toBe(true)
    expect(msgs.filter((m) => m.sender_type === 'customer')).toHaveLength(sentTo(phone).length)
    expect(new Set(sentTo(phone).filter((m) => m.body === WELCOME_TEXT).map((m) => m.id)).size).toBe(1)
  })

  it('existing contact (different phone formatting) keeps its row and conversation', async () => {
    const phone = nextPhone()
    const pretty = `+${phone.slice(0, 2)} ${phone.slice(2, 7)} ${phone.slice(7)}`
    const contactId = psql(`
      INSERT INTO contacts (account_id, user_id, phone, name)
      VALUES ('${accountId}', '${OWNER}', '${pretty}', 'Existing lead') RETURNING id;`)
    const convId = psql(`
      INSERT INTO conversations (account_id, user_id, contact_id)
      VALUES ('${accountId}', '${OWNER}', '${contactId}') RETURNING id;`)
    await say(phone, 'Hello again')

    const contacts = await contactsFor(phone)
    expect(contacts.map((c) => c.id)).toEqual([contactId])
    // Unchanged behaviour: a WhatsApp profile name refreshes the stored name.
    expect(contacts[0].name).toBe(`Lead ${phone.slice(-4)}`)
    expect(contacts[0].phone).toBe(pretty)
    expect((await conversationsFor(contactId)).map((c) => c.id)).toEqual([convId])
    const msgs = await messagesIn(convId)
    expect(msgs.filter((m) => m.sender_type === 'customer')).toHaveLength(1)
    expect(sentTo(phone)).toHaveLength(1)
  })

  it('duplicate webhooks (concurrent and replayed) store one message and send one reply', async () => {
    const phone = nextPhone()
    const payload = textPayload(phone, nextWamid())
    await Promise.all([deliver(payload), deliver(payload), deliver(payload)])
    await deliver(payload)
    const [contact, ...extra] = await contactsFor(phone)
    expect(extra).toHaveLength(0)
    const [conv] = await conversationsFor(contact.id as string)
    const msgs = await messagesIn(conv.id as string)
    expect(msgs.filter((m) => m.sender_type === 'customer')).toHaveLength(1)
    expect(msgs.filter((m) => m.sender_type === 'bot')).toHaveLength(1)
    expect(sentTo(phone)).toHaveLength(1)
  })

  it('concurrent first messages from one new sender: one contact, one conversation, one welcome', async () => {
    const phone = nextPhone()
    await Promise.all(['Hi', 'Hello', 'Solar?', 'Price?', 'Namaste'].map((t) => say(phone, t)))
    const contacts = await contactsFor(phone)
    expect(contacts).toHaveLength(1)
    const convs = await conversationsFor(contacts[0].id as string)
    expect(convs).toHaveLength(1)
    const msgs = await messagesIn(convs[0].id as string)
    expect(msgs.filter((m) => m.sender_type === 'customer')).toHaveLength(5)
    expect(sentTo(phone).filter((m) => m.body === WELCOME_TEXT)).toHaveLength(1)
  })

  it('20 concurrent function calls for one new sender create exactly one contact and conversation', async () => {
    const phone = nextPhone()
    const args = {
      p_phone_number_id: PHONE_NUMBER_ID,
      p_wa_user_id: null,
      p_phone_variants: [phone],
      p_new_contact: { phone, name: 'Race', wa_user_id: null, wa_parent_user_id: null, wa_username: null },
    }
    const results = await Promise.all(Array.from({ length: 20 }, () => db.rpc('resolve_inbound_context', args)))
    expect(results.every((r) => r.error === null)).toBe(true)
    const data = results.map((r) => r.data as { contact_created: boolean; conversation_created: boolean; contacts: { id: string }[]; conversations: { id: string }[] })
    expect(data.filter((d) => d.contact_created)).toHaveLength(1)
    expect(data.filter((d) => d.conversation_created)).toHaveLength(1)
    expect(new Set(data.map((d) => d.contacts[0]?.id)).size).toBe(1)
    expect(new Set(data.map((d) => d.conversations[0]?.id)).size).toBe(1)
    expect(await contactsFor(phone)).toHaveLength(1)
  })

  it('transaction safety: a failed conversation insert rolls back the contact from the same call', async () => {
    const phone = nextPhone()
    psql(`
      CREATE OR REPLACE FUNCTION public._disposable_fail_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'disposable test: insert refused'; END $$;
      CREATE TRIGGER _disposable_fail_conv BEFORE INSERT ON public.conversations
        FOR EACH ROW EXECUTE FUNCTION public._disposable_fail_insert();`)
    try {
      const { error } = await db.rpc('resolve_inbound_context', {
        p_phone_number_id: PHONE_NUMBER_ID,
        p_wa_user_id: null,
        p_phone_variants: [phone],
        p_new_contact: { phone, name: 'Rollback', wa_user_id: null, wa_parent_user_id: null, wa_username: null },
      })
      expect(error?.code).toBe('P0001')
      expect(await contactsFor(phone)).toHaveLength(0)

      // Through the webhook: nothing is stored or sent, nothing marked sent.
      await say(phone, 'Hi')
      expect(sentTo(phone)).toHaveLength(0)
      const contacts = await contactsFor(phone)
      for (const c of contacts) expect(await conversationsFor(c.id as string)).toHaveLength(0)
    } finally {
      psql(`DROP TRIGGER IF EXISTS _disposable_fail_conv ON public.conversations;`)
    }
  })

  it('database failure creating the contact: nothing stored, nothing sent', async () => {
    const phone = nextPhone()
    psql(`
      CREATE OR REPLACE FUNCTION public._disposable_fail_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'disposable test: insert refused'; END $$;
      CREATE TRIGGER _disposable_fail_contact BEFORE INSERT ON public.contacts
        FOR EACH ROW WHEN (NEW.phone = '${phone}') EXECUTE FUNCTION public._disposable_fail_insert();`)
    try {
      const res = await say(phone, 'Hi')
      expect(res.status).toBe(200)
      // The function failed (not "missing"), so the per-table path was tried too.
      expect(h.rpcCalls.filter((n) => n === 'resolve_inbound_context')).toHaveLength(1)
      expect(await contactsFor(phone)).toHaveLength(0)
      expect(sentTo(phone)).toHaveLength(0)
      expect(psql(`SELECT count(*) FROM messages WHERE content_text = 'Hi' AND created_at > now() - interval '10 seconds' AND conversation_id IN (SELECT id FROM conversations WHERE contact_id IN (SELECT id FROM contacts WHERE phone = '${phone}'));`)).toBe('0')
    } finally {
      psql(`DROP TRIGGER IF EXISTS _disposable_fail_contact ON public.contacts;`)
    }
  })

  it('Meta rejects the send: the customer message is kept, no bot message is marked sent', async () => {
    const phone = nextPhone()
    h.metaMode = 'fail'
    await say(phone, 'Hi')
    expect(sentTo(phone).length).toBeGreaterThan(0)
    const [contact] = await contactsFor(phone)
    const [conv] = await conversationsFor(contact.id as string)
    const msgs = await messagesIn(conv.id as string)
    expect(msgs.filter((m) => m.sender_type === 'customer')).toHaveLength(1)
    expect(msgs.filter((m) => m.sender_type === 'bot' && m.status === 'sent')).toHaveLength(0)
  })

  it('backward compatible: with the function dropped the per-table path answers, and stops calling it', async () => {
    psql(`DROP FUNCTION public.resolve_inbound_context(TEXT, TEXT, TEXT[], JSONB);`)
    try {
      await reloadRestSchema(false)
      const a = nextPhone()
      const b = nextPhone()
      await say(a, 'Hi')
      await say(b, 'Hi')
      expect(h.rpcCalls.filter((n) => n === 'resolve_inbound_context')).toHaveLength(1)
      for (const phone of [a, b]) {
        const contacts = await contactsFor(phone)
        expect(contacts).toHaveLength(1)
        expect(await conversationsFor(contacts[0].id as string)).toHaveLength(1)
        expect(lastTo(phone)).toMatchObject({ body: WELCOME_TEXT, options: ['lang_te', 'lang_en', 'lang_hi'] })
      }
    } finally {
      execFileSync('docker', ['exec', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-f', '/tmp/migrations/058_resolve_inbound_context.sql'])
      await reloadRestSchema(true)
    }
  })

  // ---------- latency on the disposable database ----------
  describe.skipIf(!BENCH)('100-event runs (local Docker database)', { timeout: 1_200_000 }, () => {
    const EVENTS = 100
    const report: Record<string, unknown> = {
      environment: 'disposable local Docker Postgres + PostgREST; Meta stubbed in-process (0 ms)',
      caveat: 'Round-trip counts are real. Timings reflect a sub-millisecond local network, not hosted Supabase (~180 ms per round trip).',
      scenarios: {},
    }
    let traces: LatencySummary[] = []
    let unsubscribe = () => {}
    beforeEach(() => {
      traces = []
      unsubscribe = onLatencyTrace((t) => traces.push(summarizeLatency(t)))
    })
    afterEach(() => unsubscribe())
    afterAll(() => {
      const dir = process.env.LATENCY_BENCH_OUT ?? join(tmpdir(), 'wacrm-latency')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'disposable-db-bench.json'), JSON.stringify(report, null, 2))
    })

    function stats(values: (number | undefined)[]) {
      const ok = values.filter((v): v is number => typeof v === 'number').sort((x, y) => x - y)
      const at = (p: number) => ok[Math.min(ok.length - 1, Math.ceil((p / 100) * ok.length) - 1)]
      return { p50: at(50), p95: at(95), max: ok.at(-1), missing: values.length - ok.length }
    }
    function record(name: string, restCalls: number, rpc: string[]) {
      const t = traces.map((s) => s.to_outbound_request_ms)
      ;(report.scenarios as Record<string, unknown>)[name] = {
        events: EVENTS,
        traces: traces.length,
        rest_round_trips_per_event: Math.round((restCalls / EVENTS) * 10) / 10,
        resolve_inbound_context_calls: rpc.filter((n) => n === 'resolve_inbound_context').length,
        to_outbound_request_ms: stats(t),
        under_1s_pct: Math.round((t.filter((v) => typeof v === 'number' && v < 1000).length / EVENTS) * 1000) / 10,
      }
    }

    async function walkToConfirmation(phone: string) {
      await say(phone, 'Hi')
      await tap(phone, 'lang_en')
      await tap(phone, 'solar_residential')
      for (const _ of CATEGORY_QUESTIONS.solar_residential) await answer(phone)
      expect(lastTo(phone).body).toBe(MESSAGES.confirmation.en)
    }

    /** Requests the outbound Meta call waited on, walking back from it. */
    function criticalChain(timeline: typeof h.timeline) {
      const meta = timeline.find((e) => e.label.startsWith('META'))
      if (!meta) return []
      const chain: string[] = []
      let cursor = meta.start
      for (;;) {
        const prev = timeline
          .filter((e) => !e.label.startsWith('META') && e.end <= cursor + 0.5)
          .sort((a, b) => b.end - a.end)[0]
        if (!prev) break
        chain.unshift(prev.label)
        cursor = prev.start
      }
      return chain
    }

    it('critical chain of round trips before the reply (function installed)', async () => {
      resetInboundContextRpcAvailability()
      const phone = nextPhone()
      h.timeline = []
      await say(phone, 'Hi')
      const welcome = h.timeline.splice(0)
      await tap(phone, 'lang_en')
      await tap(phone, 'solar_residential')
      for (const _ of CATEGORY_QUESTIONS.solar_residential) await answer(phone)
      h.timeline = []
      await tap(phone, 'callback_yes')
      const final = h.timeline.splice(0)
      const describeTimeline = (t: typeof h.timeline) => {
        const t0 = t[0]?.start ?? 0
        return {
          requests_before_meta: t.findIndex((e) => e.label.startsWith('META')),
          total_requests: t.length,
          critical_chain: criticalChain(t),
          timeline: t.map((e) => `${(e.start - t0).toFixed(1)}–${(e.end - t0).toFixed(1)} ms ${e.label}`),
        }
      }
      report.welcome_timeline = describeTimeline(welcome)
      report.final_answer_timeline = describeTimeline(final)
      expect(criticalChain(final).length).toBeGreaterThan(0)
    })

    for (const installed of [true, false]) {
      const label = installed ? 'function_installed' : 'function_dropped'
      it(`${label}: welcome and final answer`, async () => {
        if (!installed) {
          psql(`DROP FUNCTION public.resolve_inbound_context(TEXT, TEXT, TEXT[], JSONB);`)
          await reloadRestSchema(false)
        }
        try {
          resetInboundContextRpcAvailability()
          const welcomePhones = Array.from({ length: EVENTS }, nextPhone)
          traces = []
          h.restCalls = 0
          h.rpcCalls = []
          for (const phone of welcomePhones) await say(phone, 'Hi')
          record(`${label}:welcome`, h.restCalls, h.rpcCalls)
          expect(welcomePhones.every((p) => lastTo(p)?.body === WELCOME_TEXT)).toBe(true)

          const finalPhones = Array.from({ length: EVENTS }, nextPhone)
          for (const phone of finalPhones) await walkToConfirmation(phone)
          traces = []
          h.restCalls = 0
          h.rpcCalls = []
          for (const phone of finalPhones) await tap(phone, 'callback_yes')
          record(`${label}:final_answer`, h.restCalls, h.rpcCalls)
          expect(finalPhones.every((p) => lastTo(p).body === MESSAGES.finalCallback.en)).toBe(true)
        } finally {
          if (!installed) {
            execFileSync('docker', ['exec', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-f', '/tmp/migrations/058_resolve_inbound_context.sql'])
            await reloadRestSchema(true)
          }
        }
      })
    }
  })
})
