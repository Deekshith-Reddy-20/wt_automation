import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { META_SEND_SIMULATOR, type MetaSendResult } from './meta-api'

/**
 * Simulated WhatsApp sends for flow test runs.
 *
 * Inside `withSimulatedMetaSends(fn)`, every outbound Meta send made on
 * that async context (text, media, template, interactive, reaction,
 * typing) is validated and built exactly as in production, then recorded
 * here instead of being POSTed to graph.facebook.com. Concurrent requests
 * outside the scope are unaffected.
 */

export interface SimulatedSend {
  kind: string
  to: string | null
  payload: Record<string, unknown>
  messageId: string
}

const scope = new AsyncLocalStorage<SimulatedSend[]>()

;(globalThis as Record<symbol, unknown>)[META_SEND_SIMULATOR] = () => {
  const sends = scope.getStore()
  if (!sends) return undefined
  return ({ kind, payload }: { kind: string; payload: Record<string, unknown> }): MetaSendResult => {
    const messageId = `wamid.SIMULATED.${randomUUID()}`
    const to = (payload.to ?? payload.recipient ?? null) as string | null
    sends.push({ kind, to, payload, messageId })
    return { messageId }
  }
}

export async function withSimulatedMetaSends<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; sends: SimulatedSend[] }> {
  const sends: SimulatedSend[] = []
  const result = await scope.run(sends, fn)
  return { result, sends }
}
