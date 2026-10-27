export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { installKeepAliveDispatcher } = await import('./lib/http/keep-alive')
    installKeepAliveDispatcher()
  }
}
