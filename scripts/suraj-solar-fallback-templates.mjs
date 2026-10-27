#!/usr/bin/env node
// Adds the 24h-window fallback templates to an existing Suraj Solar install.
//
//   node scripts/suraj-solar-fallback-templates.mjs           # dry run: report only
//   node scripts/suraj-solar-fallback-templates.mjs --apply   # write the changes
//
// For every account with Suraj Solar automations it:
//   * inserts each template in src/lib/suraj-solar/automation-fallbacks.ts as a
//     DRAFT message_templates row (skipped if the name already exists) — nothing
//     is submitted to Meta; submit from Settings → Templates;
//   * sets step_config.fallback_template on send_message steps whose text is
//     word-for-word the template body. Other steps and automations' active
//     state are left untouched.
//
// Credentials come from .env.local (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY).

import fs from 'node:fs'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { AUTOMATION_FALLBACK_LANGUAGE, AUTOMATION_FALLBACK_TEMPLATES } from '../src/lib/suraj-solar/automation-fallbacks.ts'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const apply = process.argv.includes('--apply')

function loadEnv(file) {
  if (!fs.existsSync(file)) return {}
  const out = {}
  for (const line of fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return out
}

const env = { ...loadEnv(path.join(root, '.env.local')), ...process.env }
if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (.env.local).')
  process.exit(2)
}
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

function must({ data, error }, what) {
  if (error) throw new Error(`${what}: ${error.message}`)
  return data
}

const byText = new Map(Object.entries(AUTOMATION_FALLBACK_TEMPLATES).map(([name, body]) => [body, name]))

const automations = must(
  await db.from('automations').select('id, name, account_id, user_id').like('name', 'Suraj Solar%'),
  'load automations',
)
const accounts = new Map()
for (const a of automations) if (!accounts.has(a.account_id)) accounts.set(a.account_id, a.user_id)

console.log(apply ? 'Applying changes.' : 'Dry run — pass --apply to write.')

for (const [accountId, userId] of accounts) {
  const existing = new Set(
    must(await db.from('message_templates').select('name').eq('account_id', accountId), 'load templates').map((t) => t.name),
  )
  for (const [name, body_text] of Object.entries(AUTOMATION_FALLBACK_TEMPLATES)) {
    if (existing.has(name)) {
      console.log(`  template ${name}: already exists, left as is`)
      continue
    }
    console.log(`  template ${name}: ${apply ? 'created as DRAFT' : 'would be created as DRAFT'}`)
    if (apply) {
      must(
        await db.from('message_templates').insert({
          account_id: accountId,
          user_id: userId,
          name,
          category: 'Utility',
          language: AUTOMATION_FALLBACK_LANGUAGE,
          body_text,
          status: 'DRAFT',
        }),
        `insert template ${name}`,
      )
    }
  }

  for (const a of automations.filter((x) => x.account_id === accountId)) {
    const steps = must(
      await db.from('automation_steps').select('id, step_config').eq('automation_id', a.id).eq('step_type', 'send_message'),
      `load steps for ${a.name}`,
    )
    for (const s of steps) {
      const name = byText.get(s.step_config?.text)
      if (!name) continue
      if (s.step_config.fallback_template?.template_name === name) {
        console.log(`  ${a.name}: fallback ${name} already set`)
        continue
      }
      console.log(`  ${a.name}: ${apply ? 'fallback set to' : 'would set fallback to'} ${name}`)
      if (apply) {
        must(
          await db
            .from('automation_steps')
            .update({ step_config: { ...s.step_config, fallback_template: { template_name: name, language: AUTOMATION_FALLBACK_LANGUAGE } } })
            .eq('id', s.id),
          `update step for ${a.name}`,
        )
      }
    }
  }
}
