#!/usr/bin/env node
// End-to-end smoke test against a RUNNING app + a NON-PRODUCTION Supabase.
//
//   node scripts/smoke-test.mjs            (base URL defaults to http://localhost:3000)
//   SMOKE_BASE_URL=http://localhost:3001 node scripts/smoke-test.mjs
//   Docker: SMOKE_BASE_URL=http://localhost:3002 SMOKE_APP_SUPABASE_URL=http://host.docker.internal:54321
//   Seeded-account checks: SMOKE_SOLAR_EMAIL=… SMOKE_SOLAR_PASSWORD=…
//
// Reads Supabase + secrets from .env.local. Provisions throwaway users
// (*@smoke.surajsolar.test), signs in, and exercises auth, RBAC, RLS,
// API keys, cron auth, and the Meta webhook (signature, verify handshake,
// inbound message, idempotent replay). Never calls Meta: the WhatsApp
// config it seeds holds a fake token and every inbound payload is
// self-signed with META_APP_SECRET. Refuses to run against a non-local
// Supabase unless SMOKE_ALLOW_REMOTE=1.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const env = { ...loadEnv(path.join(root, '.env.local')), ...process.env }
const BASE = (env.SMOKE_BASE_URL || 'http://localhost:3000').replace(/\/$/, '')
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY
const APP_SECRET = (env.META_APP_SECRET || '').split(',')[0].trim()

if (!SB_URL || !ANON || !SERVICE || !env.ENCRYPTION_KEY || !APP_SECRET) {
  console.error('Missing Supabase / ENCRYPTION_KEY / META_APP_SECRET in .env.local')
  process.exit(2)
}
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(SB_URL) && env.SMOKE_ALLOW_REMOTE !== '1') {
  console.error(`Refusing to run against non-local Supabase ${SB_URL} (set SMOKE_ALLOW_REMOTE=1 for a dev project).`)
  process.exit(2)
}

const admin = createClient(SB_URL, SERVICE, { auth: { persistSession: false } })
const results = []

function loadEnv(file) {
  if (!fs.existsSync(file)) return {}
  const out = {}
  for (const line of fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return out
}

async function check(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, ok: true, detail: detail ?? '' })
    console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}`)
  } catch (err) {
    results.push({ name, ok: false, detail: err.message })
    console.log(`FAIL  ${name}  -> ${err.message}`)
  }
}

function expectStatus(res, ...allowed) {
  if (!allowed.includes(res.status)) throw new Error(`HTTP ${res.status}, expected ${allowed.join('/')}`)
  return `HTTP ${res.status}`
}

function encrypt(text) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(env.ENCRYPTION_KEY, 'hex'), iv)
  const ct = cipher.update(text, 'utf8', 'hex') + cipher.final('hex')
  return `${iv.toString('hex')}:${ct}:${cipher.getAuthTag().toString('hex')}`
}

function sign(body, secret = APP_SECRET) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
}

async function ensureUser(email, password, fullName) {
  const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 })
  const existing = list?.users?.find((u) => u.email === email)
  if (existing) return existing.id
  const { data, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { full_name: fullName },
  })
  if (error) throw error
  return data.user.id
}

/** Sign in the way the browser does and return a Cookie header for the app. */
async function sessionCookie(email, password) {
  const jar = new Map()
  // When the app reaches Supabase under a different hostname than this script
  // (e.g. a container using host.docker.internal), name the cookie the way the app expects.
  const appSbHost = env.SMOKE_APP_SUPABASE_URL ? new URL(env.SMOKE_APP_SUPABASE_URL).hostname.split('.')[0] : null
  const client = createServerClient(SB_URL, ANON, {
    ...(appSbHost ? { cookieOptions: { name: `sb-${appSbHost}-auth-token` } } : {}),
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (list) => list.forEach(({ name, value }) => (value ? jar.set(name, value) : jar.delete(name))),
    },
  })
  const { error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw error
  return [...jar].map(([n, v]) => `${n}=${v}`).join('; ')
}

const http = (p, { cookie, bearer, ...init } = {}) =>
  fetch(BASE + p, {
    redirect: 'manual',
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(init.headers || {}),
    },
  })

async function accountOf(userId) {
  const { data, error } = await admin.from('profiles').select('account_id, account_role').eq('user_id', userId).single()
  if (error) throw error
  return data
}

async function main() {
  console.log(`Smoke test → app ${BASE}, supabase ${SB_URL}\n`)
  const PW = 'Smoke-Test-Pw-2026!'
  const OWNER = 'owner@smoke.surajsolar.test'
  const VIEWER = 'viewer@smoke.surajsolar.test'
  const OUTSIDER = 'outsider@smoke.surajsolar.test'

  // ---------- Unauthenticated surface ----------
  await check('auth page /login renders', async () => expectStatus(await http('/login'), 200))
  for (const p of ['/dashboard', '/inbox', '/contacts', '/pipelines', '/broadcasts', '/automations', '/flows', '/agents', '/notifications', '/settings']) {
    await check(`unauthenticated ${p} redirects to /login`, async () => {
      const r = await http(p)
      expectStatus(r, 307, 308)
      if (!r.headers.get('location')?.includes('/login')) throw new Error(`location=${r.headers.get('location')}`)
      return 'redirect /login'
    })
  }
  await check('unauthenticated POST /api/whatsapp/send → 401', async () =>
    expectStatus(await http('/api/whatsapp/send', { method: 'POST', body: '{}' }), 401))
  await check('public API without key → 401', async () => expectStatus(await http('/api/v1/me'), 401))
  await check('public API with bogus key → 401', async () =>
    expectStatus(await http('/api/v1/me', { bearer: 'wacrm_live_bogus' }), 401))
  await check('automation cron without secret → 401', async () => expectStatus(await http('/api/automations/cron'), 401, 503))
  await check('automation cron with wrong secret → 401', async () =>
    expectStatus(await http('/api/automations/cron', { headers: { 'x-cron-secret': 'nope' } }), 401, 503))
  if (env.AUTOMATION_CRON_SECRET) {
    await check('automation cron with secret → 200', async () =>
      expectStatus(await http('/api/automations/cron', { headers: { 'x-cron-secret': env.AUTOMATION_CRON_SECRET } }), 200))
    await check('flows cron with secret → 200', async () =>
      expectStatus(await http('/api/flows/cron', { headers: { 'x-cron-secret': env.AUTOMATION_CRON_SECRET } }), 200))
  }
  await check('webhook verify without params → 400', async () => expectStatus(await http('/api/whatsapp/webhook'), 400))
  await check('webhook verify with wrong token → 403', async () =>
    expectStatus(await http('/api/whatsapp/webhook?hub.mode=subscribe&hub.challenge=123&hub.verify_token=wrong'), 403))
  await check('webhook POST without signature → 401', async () =>
    expectStatus(await http('/api/whatsapp/webhook', { method: 'POST', body: '{"entry":[]}' }), 401))
  await check('webhook POST with forged signature → 401', async () =>
    expectStatus(await http('/api/whatsapp/webhook', {
      method: 'POST', body: '{"entry":[]}', headers: { 'x-hub-signature-256': sign('{"entry":[]}', 'attacker-secret') },
    }), 401))

  // ---------- Provisioning + login ----------
  let ownerId, ownerCookie, ownerAccount
  await check('provision owner user (signup trigger creates profile + account)', async () => {
    ownerId = await ensureUser(OWNER, PW, 'Smoke Owner')
    ownerAccount = await accountOf(ownerId)
    if (ownerAccount.account_role !== 'owner') throw new Error(`role=${ownerAccount.account_role}`)
    return `account ${ownerAccount.account_id.slice(0, 8)}… role=owner`
  })
  await check('owner password login', async () => {
    ownerCookie = await sessionCookie(OWNER, PW)
    if (!ownerCookie.includes('auth-token')) throw new Error('no auth cookie set')
  })
  await check('logged-in /login redirects to /dashboard', async () => {
    const r = await http('/login', { cookie: ownerCookie })
    expectStatus(r, 307, 308)
    if (!r.headers.get('location')?.includes('/dashboard')) throw new Error(`location=${r.headers.get('location')}`)
  })

  for (const p of ['/dashboard', '/inbox', '/contacts', '/pipelines', '/broadcasts', '/broadcasts/new', '/automations', '/automations/new', '/flows', '/agents', '/notifications', '/settings']) {
    await check(`authenticated page ${p} renders`, async () => expectStatus(await http(p, { cookie: ownerCookie }), 200))
  }

  for (const p of ['/api/account', '/api/account/members', '/api/account/invitations', '/api/account/api-keys', '/api/automations', '/api/flows', '/api/flows/templates', '/api/quick-replies', '/api/ai/config', '/api/ai/usage', '/api/ai/knowledge', '/api/whatsapp/config']) {
    await check(`authenticated GET ${p}`, async () => expectStatus(await http(p, { cookie: ownerCookie }), 200))
  }

  // ---------- Team invite + RBAC ----------
  let viewerCookie
  await check('owner creates viewer invitation; viewer redeems it', async () => {
    const viewerId = await ensureUser(VIEWER, PW, 'Smoke Viewer')
    const current = await accountOf(viewerId)
    viewerCookie = await sessionCookie(VIEWER, PW)
    if (current.account_id === ownerAccount.account_id) return 'already a member'
    const inv = await http('/api/account/invitations', { method: 'POST', cookie: ownerCookie, body: JSON.stringify({ role: 'viewer', label: 'smoke' }) })
    expectStatus(inv, 201)
    const { token } = await inv.json()
    const red = await http(`/api/invitations/${encodeURIComponent(token)}/redeem`, { method: 'POST', cookie: viewerCookie, body: '{}' })
    if (!red.ok) throw new Error(`redeem HTTP ${red.status}: ${await red.text()}`)
    const after = await accountOf(viewerId)
    if (after.account_id !== ownerAccount.account_id || after.account_role !== 'viewer') throw new Error(JSON.stringify(after))
    viewerCookie = await sessionCookie(VIEWER, PW)
    return 'joined as viewer'
  })
  await check('viewer can read shared contacts list page', async () => expectStatus(await http('/contacts', { cookie: viewerCookie }), 200))
  await check('viewer cannot mint API keys (403)', async () =>
    expectStatus(await http('/api/account/api-keys', { method: 'POST', cookie: viewerCookie, body: '{"name":"x"}' }), 403))
  await check('viewer cannot create invitations (403)', async () =>
    expectStatus(await http('/api/account/invitations', { method: 'POST', cookie: viewerCookie, body: '{"role":"agent"}' }), 403))
  await check('viewer cannot change WhatsApp config (403)', async () =>
    expectStatus(await http('/api/whatsapp/config', { method: 'POST', cookie: viewerCookie, body: '{}' }), 403))

  // ---------- Public API keys + scopes ----------
  let apiKey, apiKeyId
  await check('owner mints scoped API key (contacts:read, contacts:write)', async () => {
    const r = await http('/api/account/api-keys', { method: 'POST', cookie: ownerCookie, body: JSON.stringify({ name: 'smoke', scopes: ['contacts:read', 'contacts:write'] }) })
    expectStatus(r, 201)
    const j = await r.json()
    apiKey = j.plaintext
    apiKeyId = j.key.id
    return `prefix ${j.key.key_prefix}`
  })
  await check('GET /api/v1/me with key → 200', async () => expectStatus(await http('/api/v1/me', { bearer: apiKey }), 200))
  await check('POST /api/v1/contacts creates contact', async () => {
    const r = await http('/api/v1/contacts', { method: 'POST', bearer: apiKey, body: JSON.stringify({ phone: '+919990000999', name: 'API Smoke Contact' }) })
    return expectStatus(r, 200, 201, 409)
  })
  await check('GET /api/v1/contacts lists contacts', async () => expectStatus(await http('/api/v1/contacts', { bearer: apiKey }), 200))
  await check('key lacking conversations:read is refused (403)', async () =>
    expectStatus(await http('/api/v1/conversations', { bearer: apiKey }), 403))
  await check('revoked key is refused (401)', async () => {
    expectStatus(await http(`/api/account/api-keys/${apiKeyId}`, { method: 'DELETE', cookie: ownerCookie }), 200, 204)
    return expectStatus(await http('/api/v1/me', { bearer: apiKey }), 401)
  })

  // ---------- RLS tenant isolation ----------
  await check('RLS: outsider account sees none of owner account data', async () => {
    await ensureUser(OUTSIDER, PW, 'Smoke Outsider')
    const c = createClient(SB_URL, ANON, { auth: { persistSession: false } })
    const { error } = await c.auth.signInWithPassword({ email: OUTSIDER, password: PW })
    if (error) throw error
    const leaks = []
    for (const table of ['contacts', 'conversations', 'automations', 'pipelines', 'deals', 'whatsapp_config', 'api_keys', 'custom_fields']) {
      const { data, error: e } = await c.from(table).select('account_id').eq('account_id', ownerAccount.account_id).limit(1)
      if (e) throw new Error(`${table}: ${e.message}`)
      if (data.length) leaks.push(table)
    }
    // messages carry no account_id; they are scoped through their conversation.
    const { data: ownerConvs } = await admin.from('conversations').select('id').eq('account_id', ownerAccount.account_id)
    if (ownerConvs?.length) {
      const { data: msgs, error: e } = await c.from('messages').select('id').in('conversation_id', ownerConvs.map((r) => r.id)).limit(1)
      if (e) throw new Error(`messages: ${e.message}`)
      if (msgs.length) leaks.push('messages')
    }
    if (leaks.length) throw new Error(`visible: ${leaks.join(', ')}`)
    return '9 tables isolated'
  })
  await check('RLS: anonymous client reads nothing', async () => {
    const c = createClient(SB_URL, ANON, { auth: { persistSession: false } })
    const { data } = await c.from('contacts').select('id').limit(1)
    if (data?.length) throw new Error('anon can read contacts')
  })

  // ---------- Meta webhook pipeline (no outbound calls) ----------
  const VERIFY = 'smoke-verify-token'
  let pnid
  await check('seed fake WhatsApp config for owner account', async () => {
    const { data: existing } = await admin.from('whatsapp_config').select('phone_number_id').eq('account_id', ownerAccount.account_id).maybeSingle()
    pnid = existing?.phone_number_id ?? `SMOKE${Date.now()}`
    const row = {
      account_id: ownerAccount.account_id, user_id: ownerId, phone_number_id: pnid, waba_id: 'SMOKE_WABA',
      access_token: encrypt('fake-token-never-valid-at-meta'), verify_token: encrypt(VERIFY), status: 'connected',
    }
    const { error } = existing
      ? await admin.from('whatsapp_config').update(row).eq('account_id', ownerAccount.account_id)
      : await admin.from('whatsapp_config').insert(row)
    if (error) throw error
    return pnid
  })
  await check('webhook verify handshake echoes challenge', async () => {
    const r = await http(`/api/whatsapp/webhook?hub.mode=subscribe&hub.challenge=4242&hub.verify_token=${VERIFY}`)
    expectStatus(r, 200)
    const t = await r.text()
    if (t !== '4242') throw new Error(`body=${t}`)
  })

  const wamid = `wamid.SMOKE${Date.now()}`
  const from = '919990000123'
  const payload = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: 'SMOKE_WABA', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: '15550000000', phone_number_id: pnid },
      contacts: [{ profile: { name: 'Smoke Solar Lead' }, wa_id: from }],
      messages: [{ id: wamid, from, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Hi, I want rooftop solar for my home. Bill is 4000/month' } }],
    } }] }],
  })
  const countMessages = async () => {
    const { count } = await admin.from('messages').select('id', { count: 'exact', head: true }).eq('message_id', wamid)
    return count ?? 0
  }
  const waitFor = async (pred, ms = 15000) => {
    const end = Date.now() + ms
    while (Date.now() < end) { if (await pred()) return true; await new Promise((r) => setTimeout(r, 500)) }
    return false
  }
  await check('signed inbound message → contact + conversation + message stored', async () => {
    expectStatus(await http('/api/whatsapp/webhook', { method: 'POST', body: payload, headers: { 'x-hub-signature-256': sign(payload) } }), 200)
    if (!(await waitFor(async () => (await countMessages()) === 1))) throw new Error('message not stored within 15s')
    const { data: contact } = await admin.from('contacts').select('id, name').eq('account_id', ownerAccount.account_id).eq('phone', from).maybeSingle()
    if (!contact) throw new Error('contact missing')
    return `contact "${contact.name}"`
  })
  await check('webhook replay of same message is idempotent', async () => {
    expectStatus(await http('/api/whatsapp/webhook', { method: 'POST', body: payload, headers: { 'x-hub-signature-256': sign(payload) } }), 200)
    await new Promise((r) => setTimeout(r, 3000))
    const n = await countMessages()
    if (n !== 1) throw new Error(`${n} copies stored`)
    return 'still 1 row'
  })
  await check('signed status update (read) is accepted', async () => {
    const st = JSON.stringify({ entry: [{ id: 'SMOKE_WABA', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: pnid },
      statuses: [{ id: 'wamid.UNKNOWN_SMOKE', status: 'read', timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: from }],
    } }] }] })
    return expectStatus(await http('/api/whatsapp/webhook', { method: 'POST', body: st, headers: { 'x-hub-signature-256': sign(st) } }), 200)
  })
  await check('inbox conversation visible to owner via RLS session', async () => {
    const r = await http('/inbox', { cookie: ownerCookie })
    return expectStatus(r, 200)
  })

  // ---------- Suraj Solar seed (scripts/seed-suraj-solar.mjs) ----------
  // Opt-in: SMOKE_SOLAR_EMAIL / SMOKE_SOLAR_PASSWORD of an account that was seeded.
  if (env.SMOKE_SOLAR_EMAIL && env.SMOKE_SOLAR_PASSWORD) {
    let solarCookie, solarAccount, automations = []
    await check('Suraj Solar admin login', async () => {
      solarCookie = await sessionCookie(env.SMOKE_SOLAR_EMAIL, env.SMOKE_SOLAR_PASSWORD)
      const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 })
      solarAccount = (await accountOf(list.users.find((u) => u.email === env.SMOKE_SOLAR_EMAIL).id)).account_id
    })
    await check('seeded catalogue present (fields, tags, pipeline, 9 inactive automations)', async () => {
      const [{ count: fields }, { count: tags }, { data: pipe }, { data: autos }] = await Promise.all([
        admin.from('custom_fields').select('id', { count: 'exact', head: true }).eq('account_id', solarAccount),
        admin.from('tags').select('id', { count: 'exact', head: true }).eq('account_id', solarAccount),
        admin.from('pipelines').select('id, pipeline_stages(name, position)').eq('account_id', solarAccount).eq('name', 'Solar Sales').single(),
        admin.from('automations').select('id, name, is_active').eq('account_id', solarAccount).like('name', 'Suraj Solar ·%'),
      ])
      automations = autos ?? []
      const stages = pipe.pipeline_stages.sort((a, b) => a.position - b.position).map((s) => s.name).join(' → ')
      if (stages !== 'New Lead → Contacted → Qualified → Site Survey → Quotation Sent → Negotiation → Won → Lost') throw new Error(stages)
      if (automations.length !== 9) throw new Error(`${automations.length} automations`)
      if (automations.some((a) => a.is_active)) throw new Error('an automation is active')
      return `${fields} fields, ${tags} tags, ${stages}`
    })
    for (const a of automations) {
      await check(`activation validator accepts "${a.name}"`, async () => {
        const on = await http(`/api/automations/${a.id}`, { method: 'PATCH', cookie: solarCookie, body: JSON.stringify({ is_active: true }) })
        const off = await http(`/api/automations/${a.id}`, { method: 'PATCH', cookie: solarCookie, body: JSON.stringify({ is_active: false }) })
        if (on.status !== 200) throw new Error(`activate HTTP ${on.status}: ${await on.text()}`)
        return expectStatus(off, 200)
      })
    }
    await check('engine: "Hot Lead" tag → priority High + round-robin assignment (no Meta calls)', async () => {
      const auto = automations.find((a) => a.name.endsWith('Sales agent assignment'))
      const { data: hot } = await admin.from('tags').select('id').eq('account_id', solarAccount).eq('name', 'Hot Lead').single()
      const { data: prio } = await admin.from('custom_fields').select('id').eq('account_id', solarAccount).eq('field_name', 'Lead priority').single()
      const { data: contact } = await admin.from('contacts').select('id').eq('account_id', solarAccount).eq('phone', '+915555500001').single()
      await admin.from('contact_tags').delete().eq('contact_id', contact.id).eq('tag_id', hot.id)
      await admin.from('conversations').update({ assigned_agent_id: null }).eq('contact_id', contact.id)
      await admin.from('contact_custom_values').delete().eq('contact_id', contact.id).eq('custom_field_id', prio.id)
      const since = new Date().toISOString()
      expectStatus(await http(`/api/automations/${auto.id}`, { method: 'PATCH', cookie: solarCookie, body: '{"is_active":true}' }), 200)
      try {
        expectStatus(await http(`/api/contacts/${contact.id}/tags`, { method: 'POST', cookie: solarCookie, body: JSON.stringify({ tag_id: hot.id }) }), 200)
        let log
        await waitFor(async () => {
          const { data } = await admin.from('automation_logs').select('status, steps_executed').eq('automation_id', auto.id).gte('created_at', since).maybeSingle()
          log = data
          return log && log.steps_executed.length >= 2
        })
        if (!log) throw new Error('no automation log written')
        if (log.status !== 'success') throw new Error(`log status ${log.status}: ${JSON.stringify(log.steps_executed)}`)
        const { data: conv } = await admin.from('conversations').select('assigned_agent_id').eq('contact_id', contact.id).single()
        const { data: val } = await admin.from('contact_custom_values').select('value').eq('contact_id', contact.id).eq('custom_field_id', prio.id).maybeSingle()
        if (!conv.assigned_agent_id) throw new Error('conversation not assigned')
        if (val?.value !== 'High') throw new Error(`Lead priority=${val?.value}`)
        return 'log success, assigned, priority High'
      } finally {
        await http(`/api/automations/${auto.id}`, { method: 'PATCH', cookie: solarCookie, body: '{"is_active":false}' })
      }
    })
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (env.SMOKE_REPORT) fs.writeFileSync(env.SMOKE_REPORT, JSON.stringify(results, null, 2))
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => { console.error(err); process.exit(1) })
