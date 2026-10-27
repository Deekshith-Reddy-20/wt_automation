import { AsyncLocalStorage } from 'node:async_hooks'
import { performance } from 'node:perf_hooks'

/** Same registry key as META_SEND_LATENCY_MARK in meta-api.ts. */
const META_SEND_LATENCY_MARK = Symbol.for('wacrm.metaSendLatencyMark')

// ------------------------------------------------------------
// Inbound → first-reply latency trace.
//
// One trace per inbound WhatsApp message, carried through the async
// call chain with AsyncLocalStorage so the flow engine and the Meta
// client can mark stages without threading a parameter through every
// signature. Timings use the monotonic clock (performance.now), never
// Date.now, so NTP adjustments can't produce negative stages.
//
// Sanitized by construction: a trace holds stage names, millisecond
// offsets, a short suffix of Meta's message id and an outcome label.
// No phone numbers, message text, tokens or payloads ever enter it.
// ------------------------------------------------------------

export type LatencyStage =
  | 'signature_verified'
  | 'parsed'
  | 'acked'
  | 'processing_started'
  | 'config_loaded'
  | 'contact_resolved'
  | 'conversation_resolved'
  | 'message_persisted'
  | 'bookkeeping_done'
  | 'flow_dispatch_started'
  | 'flow_run_started'
  | 'button_id_resolved'
  | 'flow_step_selected'
  | 'outbound_request_started'
  | 'outbound_accepted'
  | 'outbound_failed'
  | 'processing_finished'

export interface LatencyTrace {
  /** Last 6 chars of Meta's message id — enough to correlate, not to identify. */
  ref: string
  /** performance.now() when the webhook POST was received. */
  origin: number
  /** Stage → ms since origin. First mark wins; later marks are ignored. */
  stages: Partial<Record<LatencyStage, number>>
}

const storage = new AsyncLocalStorage<LatencyTrace>()

type TraceListener = (trace: LatencyTrace) => void
const listeners = new Set<TraceListener>()

export function newLatencyTrace(origin = performance.now()): LatencyTrace {
  return { ref: '', origin, stages: {} }
}

export function forkLatencyTrace(base: LatencyTrace, metaMessageId: string): LatencyTrace {
  return {
    ref: metaMessageId.slice(-6),
    origin: base.origin,
    stages: { ...base.stages },
  }
}

export function runWithLatencyTrace<T>(trace: LatencyTrace, fn: () => Promise<T>): Promise<T> {
  return storage.run(trace, fn)
}

export function markLatency(stage: LatencyStage, trace = storage.getStore()): void {
  if (!trace || trace.stages[stage] !== undefined) return
  trace.stages[stage] = Math.round((performance.now() - trace.origin) * 10) / 10
}

/** Test hook — the latency benchmark subscribes to finished traces. */
export function onLatencyTrace(listener: TraceListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function loggingEnabled(): boolean {
  return process.env.NODE_ENV === 'development' || process.env.WHATSAPP_LATENCY_LOG === '1'
}

/** Emit the finished trace: to subscribers always, to the log in development. */
export function finishLatencyTrace(trace: LatencyTrace): void {
  markLatency('processing_finished', trace)
  for (const listener of listeners) listener(trace)
  if (loggingEnabled()) {
    console.info(`[latency] ${JSON.stringify({ ref: trace.ref, ...summarizeLatency(trace) })}`)
  }
}

export interface LatencySummary {
  /** Receipt → 200 sent to Meta. */
  ack_ms?: number
  /** 200 sent → background processing started (after() / queue wait). */
  queue_wait_ms?: number
  /** Processing start → first outbound Meta request started. */
  processing_ms?: number
  /** Receipt → first outbound Meta request started (the < 1 s target). */
  to_outbound_request_ms?: number
  /** Outbound request started → Meta accepted it (external). */
  outbound_api_ms?: number
  /** Receipt → Meta accepted the first reply. */
  to_meta_accepted_ms?: number
  /** Meta accepted → our post-send writes finished. */
  after_meta_ms?: number
  /** Receipt → all processing for the event finished. */
  total_processing_ms?: number
  stages: LatencyTrace['stages']
}

function diff(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined || b === undefined ? undefined : Math.round((b - a) * 10) / 10
}

export function summarizeLatency(trace: LatencyTrace): LatencySummary {
  const s = trace.stages
  return {
    ack_ms: s.acked,
    queue_wait_ms: diff(s.acked, s.processing_started),
    processing_ms: diff(s.processing_started, s.outbound_request_started),
    to_outbound_request_ms: s.outbound_request_started,
    outbound_api_ms: diff(s.outbound_request_started, s.outbound_accepted),
    to_meta_accepted_ms: s.outbound_accepted,
    after_meta_ms: diff(s.outbound_accepted, s.processing_finished),
    total_processing_ms: s.processing_finished,
    stages: s,
  }
}

;(globalThis as Record<symbol, unknown>)[META_SEND_LATENCY_MARK] = (stage: LatencyStage) =>
  markLatency(stage)
