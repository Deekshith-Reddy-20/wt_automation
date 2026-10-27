import { beforeEach, describe, expect, it, vi } from 'vitest'

// Revocation is a hard delete by id and never looks at expires_at, so it
// works the same for timed and never-expiring invites.

const h = vi.hoisted(() => ({
  role: 'admin' as 'admin' | 'agent',
  userSeq: 0,
  deletedIds: [] as unknown[],
  count: 1,
}))

vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>()
  return {
    ...actual,
    requireRole: vi.fn(async () => {
      if (h.role !== 'admin') throw new actual.ForbiddenError()
      return {
        accountId: 'acct-1',
        userId: `admin-${h.userSeq}`,
        role: 'admin',
        supabase: {
          from: () => ({
            delete: () => ({
              eq: (_col: string, id: unknown) => {
                h.deletedIds.push(id)
                return Promise.resolve({ error: null, count: h.count })
              },
            }),
          }),
        },
      }
    }),
  }
})

import { DELETE } from './route'

const revoke = (id: string) =>
  DELETE(new Request(`http://localhost/api/account/invitations/${id}`, { method: 'DELETE' }), {
    params: Promise.resolve({ id }),
  })

beforeEach(() => {
  h.role = 'admin'
  h.userSeq++
  h.deletedIds = []
  h.count = 1
})

describe('DELETE /api/account/invitations/[id]', () => {
  it('an admin can revoke an invite', async () => {
    const res = await revoke('inv-never')
    expect(res.status).toBe(200)
    expect(h.deletedIds).toEqual(['inv-never'])
  })

  it('non-admins cannot revoke', async () => {
    h.role = 'agent'
    const res = await revoke('inv-never')
    expect(res.status).toBe(403)
    expect(h.deletedIds).toEqual([])
  })

  it('an unknown or other-account invite is a 404', async () => {
    h.count = 0
    expect((await revoke('inv-other')).status).toBe(404)
  })
})
