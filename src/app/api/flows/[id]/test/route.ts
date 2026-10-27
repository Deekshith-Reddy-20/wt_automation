import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import type { ParsedInbound } from '@/lib/flows/types'
import { withSimulatedMetaSends } from '@/lib/whatsapp/send-simulation'
import { FLOW_TEST_CONTACT_NAME, FLOW_TEST_CONTACT_PHONE } from '@/lib/flows/test-contact'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

type TestMessage =
  | { kind: 'text'; text: string }
  | { kind: 'interactive_reply'; reply_id: string; reply_title?: string }

/**
 * POST /api/flows/[id]/test
 *
 * Body: { reset: true } | { message: TestMessage }
 *
 * Feeds a mock inbound message from the account's dedicated test
 * contact into this flow — even while it is a draft — with every Meta
 * send simulated (nothing reaches WhatsApp). Messages, runs, events and
 * CRM writes are real rows, so the result can be inspected in the Inbox,
 * Contacts and the flow's run history. Owner/admin only.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params

  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = (await request.json().catch(() => null)) as
    | { reset?: boolean; message?: TestMessage }
    | null
  const message = body?.message
  const validMessage =
    (message?.kind === 'text' && typeof message.text === 'string' && message.text.trim().length > 0) ||
    (message?.kind === 'interactive_reply' && typeof message.reply_id === 'string' && message.reply_id.length > 0)
  if (!body?.reset && !validMessage) {
    return NextResponse.json({ error: t('flows.testMessageInvalid') }, { status: 400 })
  }

  const db = supabaseAdmin()

  try {
    const [{ data: flow }, existingContactId] = await Promise.all([
      db.from('flows').select('id').eq('id', id).eq('account_id', ctx.accountId).maybeSingle(),
      findTestContact(db, ctx.accountId),
    ])
    if (!flow) {
      return NextResponse.json({ error: t('common.notFound') }, { status: 404 })
    }
    const contactId = existingContactId ?? (await createTestContact(db, ctx.accountId, ctx.userId))

    if (body?.reset) {
      const { error } = await db
        .from('flow_runs')
        .update({ status: 'cancelled', ended_at: new Date().toISOString(), end_reason: 'test_reset' })
        .eq('account_id', ctx.accountId)
        .eq('contact_id', contactId)
        .eq('status', 'active')
      if (error) throw new Error(error.message)
      return NextResponse.json({ reset: true, contact_id: contactId })
    }

    const conversationId = await ensureTestConversation(db, ctx.accountId, ctx.userId, contactId)
    const metaMessageId = `wamid.TEST.${randomUUID()}`
    const msg = message as TestMessage
    const inbound: ParsedInbound =
      msg.kind === 'text'
        ? { kind: 'text', text: msg.text.trim(), meta_message_id: metaMessageId }
        : {
            kind: 'interactive_reply',
            reply_id: msg.reply_id,
            reply_title: msg.reply_title ?? msg.reply_id,
            meta_message_id: metaMessageId,
          }

    const { error: insertErr } = await db.from('messages').insert({
      conversation_id: conversationId,
      sender_type: 'customer',
      content_type: inbound.kind === 'text' ? 'text' : 'interactive',
      content_text: inbound.kind === 'text' ? inbound.text : inbound.reply_title,
      message_id: metaMessageId,
      status: 'delivered',
      interactive_reply_id: inbound.kind === 'interactive_reply' ? inbound.reply_id : null,
    })
    if (insertErr) throw new Error(insertErr.message)

    const { result, sends } = await withSimulatedMetaSends(() =>
      dispatchInboundToFlows({
        accountId: ctx.accountId,
        userId: ctx.userId,
        contactId,
        conversationId,
        message: inbound,
        isFirstInboundMessage: true,
        testFlowId: id,
      }),
    )

    const runColumns = 'id, status, current_node_key, vars, end_reason, started_at'
    const loadEvents = (runId: string) =>
      db
        .from('flow_run_events')
        .select('event_type, node_key, payload, created_at')
        .eq('flow_run_id', runId)
        .order('created_at', { ascending: true })

    let run: { id: string } | null = null
    let events: unknown[] | null = []
    if (result.flow_run_id) {
      const [byId, eventsById] = await Promise.all([
        db
          .from('flow_runs')
          .select(runColumns)
          .eq('id', result.flow_run_id)
          .eq('flow_id', id)
          .eq('contact_id', contactId)
          .maybeSingle(),
        loadEvents(result.flow_run_id),
      ])
      if (byId.data) {
        run = byId.data
        events = eventsById.data
      }
    }
    if (!run) {
      const { data: latest } = await db
        .from('flow_runs')
        .select(runColumns)
        .eq('flow_id', id)
        .eq('contact_id', contactId)
        .order('started_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      run = latest
      events = latest ? (await loadEvents(latest.id)).data : []
    }

    return NextResponse.json({
      result,
      sends: sends.map((s) => ({ kind: s.kind, payload: s.payload, message_id: s.messageId })),
      run,
      events: events ?? [],
      contact_id: contactId,
      conversation_id: conversationId,
    })
  } catch (err) {
    console.error('[flows/test] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : t('common.internalServerError') },
      { status: 500 },
    )
  }
}

async function findTestContact(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
): Promise<string | null> {
  const { data: existing, error } = await db
    .from('contacts')
    .select('id')
    .eq('account_id', accountId)
    .eq('phone', FLOW_TEST_CONTACT_PHONE)
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return existing?.id ?? null
}

async function createTestContact(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  userId: string,
): Promise<string> {
  const { data: created, error: createErr } = await db
    .from('contacts')
    .insert({ account_id: accountId, user_id: userId, phone: FLOW_TEST_CONTACT_PHONE, name: FLOW_TEST_CONTACT_NAME })
    .select('id')
    .single()
  if (createErr || !created) throw new Error(createErr?.message ?? 'test contact not created')
  return created.id
}

async function ensureTestConversation(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  userId: string,
  contactId: string,
): Promise<string> {
  const { data: existing, error } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (existing) return existing.id
  const { data: created, error: createErr } = await db
    .from('conversations')
    .insert({ account_id: accountId, user_id: userId, contact_id: contactId, status: 'open' })
    .select('id')
    .single()
  if (createErr || !created) throw new Error(createErr?.message ?? 'test conversation not created')
  return created.id
}
