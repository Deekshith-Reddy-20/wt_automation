import { Agent, setGlobalDispatcher } from 'undici'

/**
 * Node's default fetch agent drops idle sockets after 4 s, so a customer
 * tapping a button a few seconds after the last prompt pays a fresh
 * TCP + TLS handshake to Supabase and graph.facebook.com (~50–120 ms each
 * from this region). Keeping sockets warm for 30 s covers normal tap gaps.
 * A server-sent Keep-Alive hint still wins when it is shorter.
 */
export const KEEP_ALIVE_TIMEOUT_MS = 30_000

let installed = false

export function installKeepAliveDispatcher(): void {
  if (installed) return
  installed = true
  setGlobalDispatcher(
    new Agent({
      keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
      keepAliveMaxTimeout: KEEP_ALIVE_TIMEOUT_MS,
    }),
  )
}
