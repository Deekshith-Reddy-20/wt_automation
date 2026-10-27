import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createBroadcast,
  deliverBroadcast,
  finalizeBroadcastStatus,
  BroadcastError,
  type BroadcastPlan,
} from './broadcast-core';

const sendTemplateMessage = vi.hoisted(() => vi.fn());
vi.mock('@/lib/whatsapp/meta-api', () => ({ sendTemplateMessage }));

// Contact resolution and token decryption are exercised elsewhere — stub
// them so these tests focus on the persistence boundary.
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: () => 'plain-access-token',
}));
vi.mock('@/lib/api/v1/contacts', () => ({
  findOrCreateContact: vi.fn(async () => ({ id: 'c1' })),
}));

// These assertions all fire in the pure validation prologue, before
// any Supabase call — a bare stub is enough.
const db = {} as SupabaseClient;

describe('createBroadcast validation', () => {
  it('rejects a missing template_name', async () => {
    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: '',
        recipients: [{ to: '+14155550123' }],
      })
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
  });

  it('rejects an empty recipient list', async () => {
    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: 'promo',
        recipients: [],
      })
    ).rejects.toBeInstanceOf(BroadcastError);
  });

  it('rejects more than 1000 recipients', async () => {
    const recipients = Array.from({ length: 1001 }, () => ({
      to: '+14155550123',
    }));
    await expect(
      createBroadcast(db, 'acc', 'user', { templateName: 'promo', recipients })
    ).rejects.toMatchObject({ status: 400 });
  });
});

// Build a Supabase-shaped mock that gets createBroadcast past its config +
// template lookups and into persistence. `rpcResult` is what the atomic
// create_broadcast_with_recipients RPC returns.
function makeDb(rpcResult: { data: unknown; error: unknown }) {
  const calls = {
    rpc: [] as { name: string; args: unknown }[],
    // Incremented if the OLD non-atomic path (a direct broadcasts /
    // broadcast_recipients insert) is ever reached — it must not be.
    usedDirectInsert: 0,
  };
  const database = {
    from(table: string) {
      if (table === 'whatsapp_config') {
        return {
          select: () => ({
            eq: () => ({
              single: () =>
                Promise.resolve({
                  data: { phone_number_id: 'pn-1', access_token: 'enc' },
                  error: null,
                }),
            }),
          }),
        };
      }
      if (table === 'message_templates') {
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
        };
        return chain;
      }
      if (table === 'broadcasts' || table === 'broadcast_recipients') {
        calls.usedDirectInsert++;
        return {
          insert: () => ({
            select: () => ({
              single: () =>
                Promise.resolve({ data: { id: 'orphan' }, error: null }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
    rpc(name: string, args: unknown) {
      calls.rpc.push({ name, args });
      return Promise.resolve(rpcResult);
    },
  } as unknown as SupabaseClient;
  return { db: database, calls };
}

describe('createBroadcast recipient validation (#586)', () => {
  it('counts a recipient without a leading + as rejected instead of sending it abroad', async () => {
    const { db } = makeDb({
      data: [{ broadcast_id: 'b-1', recipient_id: 'r-1', contact_id: 'c1' }],
      error: null,
    });

    const plan = await createBroadcast(db, 'acc', 'user', {
      templateName: 'promo',
      recipients: [
        { to: '4155551212' }, // US national → Meta would read +41 (Switzerland)
        { to: '14155550123' }, // country code but no + — indistinguishable
        { to: '+14155550123' },
      ],
    });

    expect(plan.rejected).toBe(2);
    expect(plan.planned).toEqual([
      { recipientRowId: 'r-1', phone: '14155550123', params: [] },
    ]);
  });

  it('fails the whole request when no recipient carries a country code', async () => {
    const { db, calls } = makeDb({ data: [], error: null });
    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: 'promo',
        recipients: [{ to: '4155551212' }],
      })
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
    expect(calls.rpc).toHaveLength(0);
  });
});

describe('createBroadcast atomicity (#370)', () => {
  it('creates parent + recipients through the atomic RPC, never a bare parent insert', async () => {
    const { db, calls } = makeDb({
      data: [{ broadcast_id: 'b-1', recipient_id: 'r-1', contact_id: 'c1' }],
      error: null,
    });

    const plan = await createBroadcast(db, 'acc', 'user', {
      templateName: 'promo',
      recipients: [{ to: '+14155550123' }],
    });

    expect(calls.rpc).toHaveLength(1);
    expect(calls.rpc[0].name).toBe('create_broadcast_with_recipients');
    expect(calls.usedDirectInsert).toBe(0);
    expect(plan.broadcastId).toBe('b-1');
    expect(plan.planned).toEqual([
      { recipientRowId: 'r-1', phone: '14155550123', params: [] },
    ]);
  });

  it('sends one params array per contact, even for a single-variable template', async () => {
    const { db, calls } = makeDb({
      data: [{ broadcast_id: 'b-1', recipient_id: 'r-1', contact_id: 'c1' }],
      error: null,
    });

    await createBroadcast(db, 'acc', 'user', {
      templateName: 'promo',
      recipients: [{ to: '+14155550123', params: ['Ann'] }],
    });

    const args = calls.rpc[0].args as {
      p_contact_ids: string[];
      p_template_params: unknown;
    };
    expect(args.p_contact_ids).toEqual(['c1']);
    expect(args.p_template_params).toEqual([['Ann']]);
  });

  it('throws and leaves no orphaned parent when the atomic create fails', async () => {
    const { db, calls } = makeDb({
      data: null,
      error: { message: 'recipient insert failed' },
    });

    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: 'promo',
        recipients: [{ to: '+14155550123' }],
      })
    ).rejects.toBeInstanceOf(BroadcastError);

    // The RPC was the only persistence attempt; because it runs both
    // inserts in a single transaction, its failure rolls the parent back —
    // there is no separate parent insert that could survive as an orphan.
    expect(calls.rpc).toHaveLength(1);
    expect(calls.usedDirectInsert).toBe(0);
  });
});

// ============================================================
// Terminal status (#472). Derived from the recipient rows, not from a
// counter local to one delivery pass — a resume only sends the
// leftovers, so "nothing sent this pass" must not condemn a campaign
// that already delivered hundreds.
// ============================================================

function statusDb(
  counts: Record<string, number>,
  total: number,
  writes: { update?: Record<string, unknown> },
) {
  return {
    from(table: string) {
      let status: string | null = null;
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (col: string, val: unknown) => {
          if (col === 'status') status = val as string;
          return b;
        },
        update: (row: Record<string, unknown>) => {
          if (table === 'broadcasts') writes.update = row;
          return b;
        },
        then: (resolve: (r: { count: number; error: null }) => unknown) =>
          resolve({
            count: status === null ? total : (counts[status] ?? 0),
            error: null,
          }),
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

describe('finalizeBroadcastStatus', () => {
  it('leaves a capped pass in "sending" while recipients are still pending', async () => {
    const writes: { update?: Record<string, unknown> } = {};
    await finalizeBroadcastStatus(statusDb({ pending: 25 }, 1025, writes), 'b-1');
    // No write at all — the UI keeps offering Resume.
    expect(writes.update).toBeUndefined();
  });

  it('marks a fully-failed broadcast failed', async () => {
    const writes: { update?: Record<string, unknown> } = {};
    await finalizeBroadcastStatus(
      statusDb({ pending: 0, failed: 10 }, 10, writes),
      'b-1',
    );
    expect(writes.update?.status).toBe('failed');
  });

  it('marks a partially-failed broadcast sent', async () => {
    const writes: { update?: Record<string, unknown> } = {};
    await finalizeBroadcastStatus(
      statusDb({ pending: 0, failed: 3 }, 10, writes),
      'b-1',
    );
    // 7 people got the message; failed_count carries the other 3.
    expect(writes.update?.status).toBe('sent');
  });

  it('does not condemn a campaign whose resume pass sent nothing new', async () => {
    const writes: { update?: Record<string, unknown> } = {};
    // 800 delivered on the original pass, the 200-recipient resume all
    // failed. Pre-fix this wrote 'failed' off a pass-local counter.
    await finalizeBroadcastStatus(
      statusDb({ pending: 0, failed: 200 }, 1000, writes),
      'b-1',
    );
    expect(writes.update?.status).toBe('sent');
  });
});

// ============================================================
// Rejected access token: one Meta 190 means every later send fails the
// same way, so delivery stops and the rest stay pending for a resume.
// ============================================================

function deliveryDb() {
  const updates: { table: string; patch: Record<string, unknown>; filters: [string, unknown][] }[] = [];
  const database = {
    from(table: string) {
      let current: (typeof updates)[number] | null = null;
      const b: Record<string, unknown> = {
        select: () => b,
        update: (patch: Record<string, unknown>) => {
          current = { table, patch, filters: [] };
          updates.push(current);
          return b;
        },
        eq: (col: string, val: unknown) => {
          current?.filters.push([col, val]);
          return b;
        },
        then: (resolve: (r: unknown) => unknown) =>
          resolve({ count: 1, error: null, data: null }),
      };
      return b;
    },
  } as unknown as SupabaseClient;
  return { db: database, updates };
}

function plan(phones: string[]): BroadcastPlan {
  return {
    accountId: 'acct-1',
    broadcastId: 'b-1',
    templateName: 'promo',
    templateLanguage: 'en',
    phoneNumberId: 'pn-1',
    accessToken: 'plain-access-token',
    templateRow: null,
    planned: phones.map((phone, i) => ({ recipientRowId: `r-${i + 1}`, phone, params: [] })),
    rejected: 0,
  };
}

function expiredTokenError() {
  return Object.assign(new Error('Error validating access token: Session has expired'), {
    name: 'MetaApiError',
    code: 190,
    subcode: 463,
  });
}

describe('deliverBroadcast with a rejected token', () => {
  it('stops after the first 190, leaves the rest pending and marks the connection disconnected', async () => {
    sendTemplateMessage.mockReset();
    sendTemplateMessage.mockRejectedValue(expiredTokenError());
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { db, updates } = deliveryDb();

    await deliverBroadcast(db, plan(['14155550101', '14155550102', '14155550103']));

    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);
    const recipientWrites = updates.filter((u) => u.table === 'broadcast_recipients');
    expect(recipientWrites).toHaveLength(1);
    expect(recipientWrites[0]).toMatchObject({ patch: { status: 'failed' }, filters: [['id', 'r-1']] });
    const configWrites = updates.filter((u) => u.table === 'whatsapp_config');
    expect(configWrites).toHaveLength(1);
    expect(configWrites[0].patch).toMatchObject({ status: 'disconnected' });
  });

  it('keeps going past an ordinary per-recipient failure', async () => {
    sendTemplateMessage.mockReset();
    sendTemplateMessage
      .mockRejectedValueOnce(Object.assign(new Error('(#131026) Message undeliverable'), { name: 'MetaApiError', code: 131026 }))
      .mockResolvedValue({ messageId: 'wamid.1' });
    const { db, updates } = deliveryDb();

    await deliverBroadcast(db, plan(['14155550101', '14155550102']));

    expect(sendTemplateMessage).toHaveBeenCalledTimes(2);
    expect(updates.filter((u) => u.table === 'whatsapp_config')).toHaveLength(0);
    expect(updates.filter((u) => u.table === 'broadcast_recipients').map((u) => u.patch.status)).toEqual([
      'failed',
      'sent',
    ]);
  });
});
