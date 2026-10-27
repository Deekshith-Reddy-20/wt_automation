import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  inboundContextRpcEnabled,
  resetInboundContextRpcAvailability,
  resolveInboundContext,
} from './inbound-context-rpc'
import type { WaIdentity } from './wa-identity'

const identity: WaIdentity = {
  phone: '919000000001',
  waUserId: null,
  waParentUserId: null,
  waUsername: null,
  name: 'Ravi',
}

const result = {
  config: [{ account_id: 'acc', user_id: 'u', phone_number_id: 'pn', access_token: 'enc', mirror_inbound_media: false }],
  matched_by: 'created',
  contacts: [{ id: 'c1' }],
  conversations: [{ id: 'v1', contact_id: 'c1' }],
  contact_created: true,
  conversation_created: true,
}

function client(response: unknown) {
  const rpc = vi.fn(async () => response)
  return { db: { rpc } as never, rpc }
}

beforeEach(() => {
  resetInboundContextRpcAvailability()
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  delete process.env.WHATSAPP_INBOUND_CONTEXT_RPC
  vi.restoreAllMocks()
})

describe('resolveInboundContext', () => {
  it('passes the lookup keys and the new-contact fields, and returns the result', async () => {
    const { db, rpc } = client({ data: result, error: null })
    await expect(resolveInboundContext(db, 'pn', identity)).resolves.toEqual(result)
    expect(rpc).toHaveBeenCalledTimes(1)
    const [name, args] = rpc.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(name).toBe('resolve_inbound_context')
    expect(args.p_phone_number_id).toBe('pn')
    expect(args.p_wa_user_id).toBeNull()
    expect(args.p_phone_variants).toEqual(expect.arrayContaining(['919000000001']))
    expect(args.p_new_contact).toMatchObject({ phone: '919000000001', name: 'Ravi' })
  })

  it('never asks the database to create a contact for an unusable identity', async () => {
    const { db, rpc } = client({ data: { ...result, matched_by: null, contacts: [], conversations: [] }, error: null })
    await resolveInboundContext(db, 'pn', { ...identity, phone: '' })
    const args = (rpc.mock.calls[0] as unknown as [string, Record<string, unknown>])[1]
    expect(args.p_new_contact).toBeNull()
    expect(args.p_phone_variants).toEqual([])
  })

  it('a missing function returns null and is not called again for a while', async () => {
    const { db, rpc } = client({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } })
    await expect(resolveInboundContext(db, 'pn', identity)).resolves.toBeNull()
    await expect(resolveInboundContext(db, 'pn', identity)).resolves.toBeNull()
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(inboundContextRpcEnabled()).toBe(false)
    expect(inboundContextRpcEnabled(Date.now() + 11 * 60_000)).toBe(true)
  })

  it('a transient failure returns null for that call only', async () => {
    const { db, rpc } = client({ data: null, error: { code: '57014', message: 'statement timeout' } })
    await expect(resolveInboundContext(db, 'pn', identity)).resolves.toBeNull()
    await expect(resolveInboundContext(db, 'pn', identity)).resolves.toBeNull()
    expect(rpc).toHaveBeenCalledTimes(2)
    expect(inboundContextRpcEnabled()).toBe(true)
  })

  it('a thrown error or an unexpected shape returns null', async () => {
    const thrown = { rpc: vi.fn(async () => { throw new Error('network') }) }
    await expect(resolveInboundContext(thrown as never, 'pn', identity)).resolves.toBeNull()
    const { db } = client({ data: { config: [] }, error: null })
    await expect(resolveInboundContext(db, 'pn', identity)).resolves.toBeNull()
  })

  it('WHATSAPP_INBOUND_CONTEXT_RPC=0 turns the call off', async () => {
    process.env.WHATSAPP_INBOUND_CONTEXT_RPC = '0'
    const { db, rpc } = client({ data: result, error: null })
    await expect(resolveInboundContext(db, 'pn', identity)).resolves.toBeNull()
    expect(rpc).not.toHaveBeenCalled()
  })
})
