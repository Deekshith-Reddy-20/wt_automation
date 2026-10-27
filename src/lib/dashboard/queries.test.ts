import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadConversationsSeries, loadResponseTime } from './queries'

const SERVER_ROW_CAP = 1000

function cappedDb(rows: Record<string, unknown>[]) {
  const ranges: [number, number][] = []
  const chain = {
    select: () => chain,
    gte: () => chain,
    order: () => chain,
    range: async (from: number, to: number) => {
      ranges.push([from, to])
      const end = Math.min(to + 1, from + SERVER_ROW_CAP)
      return { data: rows.slice(from, end), error: null }
    },
  }
  const db = { from: () => chain } as unknown as SupabaseClient
  return { db, ranges }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 4, 18, 12, 0, 0))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('loadConversationsSeries', () => {
  it('counts every message past the 1000-row response cap', async () => {
    const at = new Date(2026, 4, 18, 9, 0, 0).toISOString()
    const rows = Array.from({ length: 2600 }, (_, i) => ({
      created_at: at,
      sender_type: i % 2 === 0 ? 'customer' : 'agent',
    }))
    const { db, ranges } = cappedDb(rows)
    const series = await loadConversationsSeries(db, 1)
    expect(series).toEqual([{ day: '2026-05-18', incoming: 1300, outgoing: 1300 }])
    expect(ranges.length).toBeGreaterThanOrEqual(3)
  })
})

describe('loadResponseTime', () => {
  it('includes conversations beyond the first 1000 rows', async () => {
    const customerAt = new Date(2026, 4, 18, 9, 0, 0)
    const replyAt = new Date(2026, 4, 18, 9, 10, 0)
    const rows: Record<string, unknown>[] = []
    for (let c = 0; c < 600; c++) {
      const conversation_id = `conv-${String(c).padStart(4, '0')}`
      rows.push({ conversation_id, sender_type: 'customer', created_at: customerAt.toISOString() })
      rows.push({ conversation_id, sender_type: 'agent', created_at: replyAt.toISOString() })
    }
    const { db } = cappedDb(rows)
    const summary = await loadResponseTime(db)
    const monday = summary.buckets[0]
    expect(monday.samples).toBe(600)
    expect(monday.avgMinutes).toBe(10)
    expect(summary.thisWeekAvg).toBe(10)
  })
})
