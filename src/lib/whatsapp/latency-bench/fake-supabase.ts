// ------------------------------------------------------------
// In-memory Supabase stand-in for the latency benchmark (test-only).
//
// Every awaited query sleeps for `latency()` ms before it is applied,
// so the real webhook → flow engine → Meta client code pays one
// simulated network round trip per query, and queries issued in
// parallel overlap exactly as they would against PostgREST. It honours
// the filters the inbound hot path uses and the unique indexes that
// make inbound processing idempotent; it is not a general emulator.
// ------------------------------------------------------------

type Row = Record<string, unknown>
type Filter = (row: Row) => boolean

export interface FakeDbOptions {
  /** Simulated round-trip time for one query, in ms. */
  latency: () => number
}

interface UniqueRule {
  columns: string[]
  where?: (row: Row) => boolean
}

const UNIQUE: Record<string, UniqueRule[]> = {
  messages: [{ columns: ['conversation_id', 'message_id'], where: (r) => r.message_id != null }],
  conversations: [{ columns: ['account_id', 'contact_id'] }],
  contacts: [
    { columns: ['account_id', 'phone_normalized'], where: (r) => !!r.phone_normalized },
    { columns: ['account_id', 'wa_user_id'], where: (r) => r.wa_user_id != null },
  ],
  flow_runs: [{ columns: ['account_id', 'contact_id'], where: (r) => r.status === 'active' }],
  contact_tags: [{ columns: ['contact_id', 'tag_id'] }],
  whatsapp_webhook_inbox: [{ columns: ['dedupe_key'] }],
}

function value(row: Row, column: string): unknown {
  const json = column.split('->>')
  if (json.length === 2) {
    const obj = row[json[0]] as Row | null | undefined
    const v = obj?.[json[1]]
    return v === undefined || v === null ? null : String(v)
  }
  const v = row[column]
  return v === undefined ? null : v
}

function uniqueViolation(table: string) {
  return {
    code: '23505',
    message: `duplicate key value violates unique constraint on ${table}`,
  }
}

let idCounter = 0
const nextId = () => `id-${(++idCounter).toString(36)}`

export class FakeDb {
  readonly tables = new Map<string, Row[]>()
  queries = 0
  rpcCalls: string[] = []
  /** Table of every select, in order. */
  reads: string[] = []
  /** Tables whose writes fail, to simulate an outage. */
  failWrites = new Set<string>()

  constructor(private readonly opts: FakeDbOptions) {}

  rows(table: string): Row[] {
    let rows = this.tables.get(table)
    if (!rows) {
      rows = []
      this.tables.set(table, rows)
    }
    return rows
  }

  seed(table: string, rows: Row[]): void {
    for (const row of rows) this.rows(table).push(this.withDefaults(table, { ...row }))
  }

  async roundTrip(): Promise<void> {
    this.queries++
    const ms = this.opts.latency()
    if (ms > 0) await new Promise((r) => setTimeout(r, ms))
  }

  withDefaults(table: string, row: Row): Row {
    const now = new Date().toISOString()
    row.id ??= nextId()
    row.created_at ??= now
    if (table === 'contacts') {
      row.phone_normalized = String(row.phone ?? '').replace(/\D/g, '')
      row.opted_out_at ??= null
    }
    if (table === 'conversations') {
      row.status ??= 'open'
      row.unread_count ??= 0
      row.first_inbound_at ??= null
    }
    if (table === 'whatsapp_webhook_inbox') {
      row.status ??= 'pending'
      row.attempts ??= 1
      row.received_at ??= now
      row.processed_at ??= null
    }
    if (table === 'flow_runs') {
      row.vars ??= {}
      row.reprompt_count ??= 0
      row.transition_seq ??= 0
      row.started_at ??= now
      row.last_advanced_at ??= now
    }
    return row
  }

  conflicts(table: string, row: Row, ignoreId?: unknown): boolean {
    return (UNIQUE[table] ?? []).some((rule) => {
      if (rule.where && !rule.where(row)) return false
      return this.rows(table).some(
        (other) =>
          other.id !== ignoreId &&
          (!rule.where || rule.where(other)) &&
          rule.columns.every((c) => value(other, c) === value(row, c)),
      )
    })
  }

  /** SQL functions from not-yet-applied migrations that this database has. */
  functions = new Set<string>()
  /** Functions whose call fails (other than "not found"). */
  failRpc = new Set<string>()

  /** Migration 058, emulated: one atomic statement. */
  private resolveInboundContext(args: Record<string, unknown>): Result {
    const cfg = this.rows('whatsapp_config').filter((r) => r.phone_number_id === args.p_phone_number_id)
    const config = cfg.map((r) => ({
      account_id: r.account_id,
      user_id: r.user_id,
      phone_number_id: r.phone_number_id,
      access_token: r.access_token,
      mirror_inbound_media: r.mirror_inbound_media ?? null,
    }))
    const result = {
      config,
      matched_by: null as string | null,
      contacts: [] as Row[],
      conversations: [] as Row[],
      contact_created: false,
      conversation_created: false,
    }
    if (cfg.length !== 1) return { data: result, error: null }
    const account = cfg[0].account_id
    const owner = cfg[0].user_id
    const waUserId = (args.p_wa_user_id as string | null) ?? null
    const variants = (args.p_phone_variants as string[] | null) ?? []

    const lookup = (): { ids: unknown[]; matched: string | null } => {
      if (waUserId) {
        const ids = this.rows('contacts')
          .filter((c) => c.account_id === account && c.wa_user_id === waUserId)
          .map((c) => c.id)
        if (ids.length) return { ids, matched: 'wa_user_id' }
      }
      if (variants.length) {
        const ids = this.rows('contacts')
          .filter((c) => c.account_id === account && variants.includes(String(c.phone_normalized)))
          .map((c) => c.id)
        if (ids.length) return { ids, matched: 'phone' }
      }
      return { ids: [], matched: null }
    }

    let { ids, matched } = lookup()
    const newContact = args.p_new_contact as Row | null
    if (!matched && newContact) {
      if (this.failWrites.has('contacts')) return { data: null, error: { message: 'simulated outage' } }
      const contact = this.withDefaults('contacts', {
        account_id: account,
        user_id: owner,
        phone: newContact.phone,
        name: newContact.name,
        wa_user_id: newContact.wa_user_id ?? null,
        wa_parent_user_id: newContact.wa_parent_user_id ?? null,
        wa_username: newContact.wa_username ?? null,
      })
      if (!this.conflicts('contacts', contact)) {
        const conv = this.withDefaults('conversations', {
          account_id: account,
          user_id: owner,
          contact_id: contact.id,
        })
        // Atomic: a failed conversation insert rolls the contact back.
        if (this.failWrites.has('conversations')) return { data: null, error: { message: 'simulated outage' } }
        this.rows('contacts').push(contact)
        result.contact_created = true
        if (!this.conflicts('conversations', conv)) {
          this.rows('conversations').push(conv)
          result.conversation_created = true
        }
        ids = [contact.id]
        matched = 'created'
      } else {
        ;({ ids, matched } = lookup())
      }
    }

    result.matched_by = matched
    result.contacts = this.rows('contacts')
      .filter((c) => ids.includes(c.id))
      .map((c) => ({ ...c }))
    result.conversations = ids.flatMap((id) => {
      const oldest = this.rows('conversations')
        .filter((v) => v.account_id === account && v.contact_id === id)
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0]
      return oldest ? [{ ...oldest }] : []
    })
    return { data: result, error: null }
  }

  rpc(name: string, args: Record<string, unknown>): Result {
    this.rpcCalls.push(name)
    if (name === 'resolve_inbound_context') {
      if (!this.functions.has(name)) {
        return {
          data: null,
          error: {
            code: 'PGRST202',
            message: 'Could not find the function public.resolve_inbound_context in the schema cache',
          },
        }
      }
      if (this.failRpc.has(name)) return { data: null, error: { code: '57014', message: 'simulated failure' } }
      return this.resolveInboundContext(args)
    }
    if (name === 'bump_conversation_on_inbound') {
      const conv = this.rows('conversations').find((r) => r.id === args.p_conversation_id)
      if (conv) {
        conv.unread_count = Number(conv.unread_count ?? 0) + 1
        conv.last_message_text = args.p_last_message_text
      }
    }
    if (name === 'increment_flow_execution_count') {
      const flow = this.rows('flows').find((r) => r.id === args.p_flow_id)
      if (flow) flow.execution_count = Number(flow.execution_count ?? 0) + 1
    }
    return { data: null, error: null }
  }

  client() {
    return {
      from: (table: string) => new FakeQuery(this, table),
      rpc: async (name: string, args: Record<string, unknown> = {}) => {
        await this.roundTrip()
        return this.rpc(name, args)
      },
    }
  }
}

type Op = 'select' | 'insert' | 'update' | 'upsert' | 'delete'

interface Result {
  data: unknown
  error: { code?: string; message: string } | null
  count?: number | null
}

class FakeQuery implements PromiseLike<Result> {
  private op: Op = 'select'
  private payload: Row | Row[] | null = null
  private upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {}
  private returning = false
  private filters: Filter[] = []
  private orderBy: { column: string; ascending: boolean }[] = []
  private limitN: number | null = null
  private countMode = false
  private head = false
  private singleMode: 'one' | 'maybe' | null = null

  constructor(
    private readonly db: FakeDb,
    private readonly table: string,
  ) {}

  select(_columns?: string, opts?: { count?: string; head?: boolean }) {
    if (this.op === 'select') {
      this.countMode = !!opts?.count
      this.head = !!opts?.head
    } else {
      this.returning = true
    }
    return this
  }
  insert(payload: Row | Row[]) {
    this.op = 'insert'
    this.payload = payload
    return this
  }
  update(payload: Row) {
    this.op = 'update'
    this.payload = payload
    return this
  }
  upsert(payload: Row | Row[], opts: { onConflict?: string; ignoreDuplicates?: boolean } = {}) {
    this.op = 'upsert'
    this.payload = payload
    this.upsertOpts = opts
    return this
  }
  delete() {
    this.op = 'delete'
    return this
  }
  eq(column: string, v: unknown) {
    this.filters.push((r) => value(r, column) === v)
    return this
  }
  neq(column: string, v: unknown) {
    this.filters.push((r) => value(r, column) !== v)
    return this
  }
  is(column: string, v: unknown) {
    this.filters.push((r) => value(r, column) === v)
    return this
  }
  in(column: string, values: unknown[]) {
    this.filters.push((r) => values.includes(value(r, column)))
    return this
  }
  not(column: string, operator: string, v: unknown) {
    if (operator === 'is') this.filters.push((r) => value(r, column) !== v)
    else if (operator === 'in') {
      const list = String(v).replace(/[()]/g, '').split(',')
      this.filters.push((r) => !list.includes(String(value(r, column))))
    } else this.filters.push((r) => value(r, column) !== v)
    return this
  }
  gt(column: string, v: unknown) {
    this.filters.push((r) => String(value(r, column)) > String(v))
    return this
  }
  gte(column: string, v: unknown) {
    this.filters.push((r) => String(value(r, column)) >= String(v))
    return this
  }
  lt(column: string, v: unknown) {
    this.filters.push((r) => String(value(r, column)) < String(v))
    return this
  }
  lte(column: string, v: unknown) {
    this.filters.push((r) => String(value(r, column)) <= String(v))
    return this
  }
  filter(column: string, operator: string, v: unknown) {
    if (operator === 'eq') this.filters.push((r) => value(r, column) === String(v))
    return this
  }
  contains(column: string, v: unknown[]) {
    this.filters.push((r) => {
      const arr = value(r, column)
      return Array.isArray(arr) && v.every((x) => arr.includes(x))
    })
    return this
  }
  match(obj: Row) {
    for (const [k, v] of Object.entries(obj)) this.eq(k, v)
    return this
  }
  order(column: string, opts: { ascending?: boolean } = {}) {
    this.orderBy.push({ column, ascending: opts.ascending !== false })
    return this
  }
  limit(n: number) {
    this.limitN = n
    return this
  }
  maybeSingle() {
    this.singleMode = 'maybe'
    return this.run()
  }
  single() {
    this.singleMode = 'one'
    return this.run()
  }
  then<A = Result, B = never>(
    onfulfilled?: ((value: Result) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return this.run().then(onfulfilled, onrejected)
  }

  private matching(): Row[] {
    return this.db.rows(this.table).filter((r) => this.filters.every((f) => f(r)))
  }

  private async run(): Promise<Result> {
    await this.db.roundTrip()
    const result = this.apply()
    if (result.error || !this.singleMode) return result
    const rows = (result.data as Row[] | null) ?? []
    if (this.singleMode === 'one' && rows.length !== 1) {
      return { data: null, error: { code: 'PGRST116', message: 'expected one row' } }
    }
    return { data: rows[0] ?? null, error: null }
  }

  private apply(): Result {
    const table = this.db.rows(this.table)
    if (this.op !== 'select' && this.db.failWrites.has(this.table)) {
      return { data: null, error: { message: 'simulated outage' } }
    }
    switch (this.op) {
      case 'select': {
        this.db.reads.push(this.table)
        let rows = this.matching()
        for (const { column, ascending } of [...this.orderBy].reverse()) {
          rows = [...rows].sort((a, b) => {
            const x = String(value(a, column) ?? '')
            const y = String(value(b, column) ?? '')
            return ascending ? x.localeCompare(y) : y.localeCompare(x)
          })
        }
        if (this.limitN !== null) rows = rows.slice(0, this.limitN)
        return {
          data: this.head ? null : rows.map((r) => ({ ...r })),
          error: null,
          count: this.countMode ? rows.length : null,
        }
      }
      case 'insert': {
        const incoming = (Array.isArray(this.payload) ? this.payload : [this.payload!]).map((r) =>
          this.db.withDefaults(this.table, { ...r }),
        )
        for (const row of incoming) {
          if (this.db.conflicts(this.table, row)) return { data: null, error: uniqueViolation(this.table) }
        }
        table.push(...incoming)
        return { data: this.returning ? incoming.map((r) => ({ ...r })) : null, error: null }
      }
      case 'upsert': {
        const incoming = (Array.isArray(this.payload) ? this.payload : [this.payload!]).map((r) =>
          this.db.withDefaults(this.table, { ...r }),
        )
        const written: Row[] = []
        for (const row of incoming) {
          if (this.db.conflicts(this.table, row)) {
            if (this.upsertOpts.ignoreDuplicates) continue
            const cols = (this.upsertOpts.onConflict ?? 'id').split(',')
            const existing = table.find((o) => cols.every((c) => value(o, c) === value(row, c)))
            if (existing) {
              const rest = { ...row }
              delete rest.id
              delete rest.created_at
              Object.assign(existing, rest)
              written.push(existing)
            }
            continue
          }
          table.push(row)
          written.push(row)
        }
        return { data: this.returning ? written.map((r) => ({ ...r })) : null, error: null }
      }
      case 'update': {
        const rows = this.matching()
        for (const row of rows) {
          const next = { ...row, ...(this.payload as Row) }
          if (this.db.conflicts(this.table, next, row.id)) {
            return { data: null, error: uniqueViolation(this.table) }
          }
        }
        for (const row of rows) Object.assign(row, this.payload)
        return { data: this.returning ? rows.map((r) => ({ ...r })) : null, error: null }
      }
      case 'delete': {
        const rows = this.matching()
        for (const row of rows) table.splice(table.indexOf(row), 1)
        return { data: this.returning ? rows : null, error: null }
      }
    }
  }
}
