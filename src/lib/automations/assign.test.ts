import { describe, expect, it } from 'vitest'
import { pickRoundRobinAgent } from './assign'

const members = [
  { user_id: 'b-agent', account_role: 'agent' },
  { user_id: 'a-owner', account_role: 'owner' },
  { user_id: 'c-viewer', account_role: 'viewer' },
  { user_id: 'd-admin', account_role: 'admin' },
]

describe('pickRoundRobinAgent', () => {
  it('returns null when no member can work conversations', () => {
    expect(pickRoundRobinAgent([{ user_id: 'v', account_role: 'viewer' }], [])).toBeNull()
    expect(pickRoundRobinAgent([], [])).toBeNull()
  })

  it('never assigns a viewer, even when they have the lowest load', () => {
    const picked = pickRoundRobinAgent(members, ['a-owner', 'b-agent', 'd-admin'])
    expect(picked).not.toBe('c-viewer')
  })

  it('picks the eligible member with the fewest open conversations', () => {
    expect(pickRoundRobinAgent(members, ['a-owner', 'a-owner', 'd-admin', 'b-agent', 'b-agent'])).toBe('d-admin')
  })

  it('breaks ties deterministically by user_id', () => {
    expect(pickRoundRobinAgent(members, [])).toBe('a-owner')
    expect(pickRoundRobinAgent(members, ['a-owner'])).toBe('b-agent')
  })

  it('spreads consecutive assignments across agents', () => {
    const open: string[] = []
    for (let i = 0; i < 6; i++) {
      const id = pickRoundRobinAgent(members, open)!
      open.push(id)
    }
    expect(open.filter((id) => id === 'a-owner')).toHaveLength(2)
    expect(open.filter((id) => id === 'b-agent')).toHaveLength(2)
    expect(open.filter((id) => id === 'd-admin')).toHaveLength(2)
  })

  it('keeps an existing eligible assignee (sticky salesperson)', () => {
    expect(pickRoundRobinAgent(members, ['b-agent', 'b-agent', 'b-agent'], 'b-agent')).toBe('b-agent')
  })

  it('reassigns when the current assignee is no longer eligible', () => {
    expect(pickRoundRobinAgent(members, [], 'c-viewer')).toBe('a-owner')
    expect(pickRoundRobinAgent(members, [], 'departed-user')).toBe('a-owner')
  })

  it('ignores unassigned and non-member ids in the load list', () => {
    expect(pickRoundRobinAgent(members, [null, 'ghost', 'ghost', 'a-owner'])).toBe('b-agent')
  })
})
