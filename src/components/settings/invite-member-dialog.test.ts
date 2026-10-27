import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { EXPIRY_OPTIONS, NEVER_EXPIRES, inviteExpiryPayload } from './invite-member-dialog'

const en = JSON.parse(readFileSync(join(process.cwd(), 'messages', 'en.json'), 'utf8'))

describe('invite dialog expiry options', () => {
  it('offers 1 day, 7 days, 30 days, then Never expires', () => {
    expect(EXPIRY_OPTIONS.map((o) => en.Settings.invite[o.labelKey])).toEqual([
      '1 day',
      '7 days',
      '30 days',
      'Never expires',
    ])
  })

  it.each([
    ['1', { expiresInDays: 1 }],
    ['7', { expiresInDays: 7 }],
    ['30', { expiresInDays: 30 }],
  ] as const)('%s sends the same expiresInDays as before', (value, payload) => {
    expect(inviteExpiryPayload(value)).toEqual(payload)
  })

  it('Never expires sends an explicit flag and no day count', () => {
    expect(inviteExpiryPayload(NEVER_EXPIRES)).toEqual({ neverExpires: true })
  })
})
