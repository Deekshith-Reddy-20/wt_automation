/**
 * Turns Supabase Auth responses into the outcome the auth pages show.
 * Kept free of React / Supabase imports so it can be unit tested.
 */

interface AuthErrorLike {
  message: string
  code?: string
  status?: number
}

export type SignUpOutcome =
  | { kind: 'error'; message: string }
  | { kind: 'duplicate' }
  /** Email confirmation is off: Supabase already issued a session. */
  | { kind: 'signed_in' }
  /** Email confirmation is on: the user must click the emailed link. */
  | { kind: 'confirm_email' }

export function interpretSignUp(result: {
  data: { user: { identities?: unknown[] | null } | null; session: unknown | null } | null
  error: AuthErrorLike | null
}): SignUpOutcome {
  const { data, error } = result
  if (error) {
    if (error.code === 'user_already_exists' || error.code === 'email_exists') {
      return { kind: 'duplicate' }
    }
    return { kind: 'error', message: error.message }
  }
  // With confirmation on, Supabase hides whether an address is taken:
  // it answers 200 with a user that has no identities instead of an
  // error. Treat that as a duplicate rather than claiming an email went out.
  if (data?.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
    return { kind: 'duplicate' }
  }
  if (data?.session) return { kind: 'signed_in' }
  if (data?.user) return { kind: 'confirm_email' }
  return { kind: 'error', message: 'Sign-up did not return a user.' }
}

export type SignInFailure = 'invalid_credentials' | 'email_not_confirmed' | 'rate_limited' | 'other'

export function classifySignInError(error: AuthErrorLike): SignInFailure {
  if (error.code === 'invalid_credentials' || /invalid login credentials/i.test(error.message)) {
    return 'invalid_credentials'
  }
  if (error.code === 'email_not_confirmed' || /email not confirmed/i.test(error.message)) {
    return 'email_not_confirmed'
  }
  if (error.status === 429 || error.code === 'over_request_rate_limit') return 'rate_limited'
  return 'other'
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email.trim())
}
