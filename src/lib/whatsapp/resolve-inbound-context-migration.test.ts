import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const sql = readFileSync(
  join(process.cwd(), 'supabase/migrations/058_resolve_inbound_context.sql'),
  'utf8',
)
const code = sql
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n')

const SIGNATURE = String.raw`public\.resolve_inbound_context\(TEXT, TEXT, TEXT\[\], JSONB\)`

describe('migration 058 resolve_inbound_context', () => {
  it('is additive: creates one function and changes no table, index or policy', () => {
    expect(code).not.toMatch(/\b(update\s+\w+\s+set|delete\s+from|truncate|alter\s+table|drop\s+table|create\s+(unique\s+)?index|drop\s+index|policy)\b/i)
    expect(code).not.toMatch(/\bDROP FUNCTION\b/i)
    expect(code.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(1)
  })

  it('only writes new contacts / conversations, never overwriting on conflict', () => {
    const inserts = code.match(/INSERT INTO\s+\w+/gi) ?? []
    expect(inserts.map((s) => s.replace(/\s+/g, ' ').toLowerCase())).toEqual([
      'insert into contacts',
      'insert into conversations',
    ])
    expect(code.match(/ON CONFLICT DO NOTHING/g)).toHaveLength(2)
    expect(code).not.toMatch(/ON CONFLICT[^;]*DO UPDATE/i)
    expect(code).toMatch(/\bVOLATILE\b/)
  })

  it('runs with the caller’s rights and only service_role may execute it', () => {
    expect(code).toMatch(/SECURITY INVOKER/)
    expect(code).not.toMatch(/SECURITY DEFINER/)
    expect(code).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${SIGNATURE} FROM PUBLIC`))
    expect(code).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${SIGNATURE} FROM anon, authenticated`))
    expect(code).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${SIGNATURE} TO service_role`))
    expect(code).not.toMatch(/GRANT EXECUTE[^;]*TO[^;]*(anon|authenticated)/)
  })

  it('keeps today’s matching rules', () => {
    // Exactly one config row, otherwise nothing else runs.
    expect(code).toMatch(/IF v_config_count <> 1 THEN\s+RETURN/)
    // BSUID first; phone variants only when the BSUID matched nothing.
    const bsuid = code.indexOf('wa_user_id = p_wa_user_id')
    const phone = code.indexOf('phone_normalized = ANY (p_phone_variants)')
    expect(bsuid).toBeGreaterThan(-1)
    expect(phone).toBeGreaterThan(bsuid)
    expect(code).toMatch(/IF v_matched_by IS NULL AND coalesce\(cardinality\(p_phone_variants\), 0\) > 0/)
    // Creates only when nothing matched and the caller asked for it.
    expect(code).toMatch(/IF v_matched_by IS NULL AND p_new_contact IS NOT NULL THEN\s+INSERT INTO contacts/)
    // Oldest conversation per contact.
    expect(code).toMatch(/SELECT DISTINCT ON \(contact_id\) \*[\s\S]*ORDER BY contact_id, created_at ASC/)
  })

  it('creates the contact under the config owner, with the same columns as the webhook', () => {
    expect(code).toMatch(
      /INSERT INTO contacts \(account_id, user_id, phone, name, wa_user_id, wa_parent_user_id, wa_username\)\s+VALUES \(\s+v_account,\s+v_owner,/,
    )
    expect(code).toMatch(/INSERT INTO conversations \(account_id, user_id, contact_id\)\s+VALUES \(v_account, v_owner, v_new_contact\.id\)/)
  })

  it('re-reads the winner when a concurrent insert won the race', () => {
    const lostRace = code.slice(code.indexOf('v_contact_created := TRUE'))
    expect(lostRace).toMatch(/ELSE[\s\S]*wa_user_id = p_wa_user_id[\s\S]*phone_normalized = ANY \(p_phone_variants\)/)
  })

  it('documents its rollback', () => {
    expect(sql).toMatch(/Rollback: DROP FUNCTION public\.resolve_inbound_context\(TEXT, TEXT, TEXT\[\], JSONB\);/)
  })
})
