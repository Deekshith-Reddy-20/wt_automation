import { describe, expect, it } from 'vitest'

import { classifySignInError, interpretSignUp, isValidEmail } from './auth-result'

describe('interpretSignUp', () => {
  it('signs the user straight in when Supabase returns a session (confirmation off)', () => {
    expect(
      interpretSignUp({ data: { user: { identities: [{}] }, session: { access_token: 'x' } }, error: null }),
    ).toEqual({ kind: 'signed_in' })
  })

  it('asks for email confirmation when there is a user but no session', () => {
    expect(interpretSignUp({ data: { user: { identities: [{}] }, session: null }, error: null })).toEqual({
      kind: 'confirm_email',
    })
  })

  it('reports a duplicate for the obfuscated "user with no identities" response', () => {
    expect(interpretSignUp({ data: { user: { identities: [] }, session: null }, error: null })).toEqual({
      kind: 'duplicate',
    })
  })

  it('reports a duplicate for an explicit user_already_exists error', () => {
    expect(
      interpretSignUp({ data: null, error: { message: 'User already registered', code: 'user_already_exists' } }),
    ).toEqual({ kind: 'duplicate' })
  })

  it('surfaces any other Supabase rejection instead of claiming success', () => {
    expect(
      interpretSignUp({ data: null, error: { message: 'Password should be at least 6 characters', code: 'weak_password' } }),
    ).toEqual({ kind: 'error', message: 'Password should be at least 6 characters' })
    expect(interpretSignUp({ data: { user: null, session: null }, error: null }).kind).toBe('error')
  })
})

describe('classifySignInError', () => {
  it('recognises the failure modes the login page explains', () => {
    expect(classifySignInError({ message: 'Invalid login credentials', code: 'invalid_credentials' })).toBe(
      'invalid_credentials',
    )
    expect(classifySignInError({ message: 'Email not confirmed' })).toBe('email_not_confirmed')
    expect(classifySignInError({ message: 'slow down', status: 429 })).toBe('rate_limited')
    expect(classifySignInError({ message: 'Database error' })).toBe('other')
  })
})

describe('isValidEmail', () => {
  it('accepts normal addresses and rejects malformed ones', () => {
    expect(isValidEmail(' owner@surajsolar.com ')).toBe(true)
    expect(isValidEmail('owner@surajsolar')).toBe(false)
    expect(isValidEmail('owner surajsolar.com')).toBe(false)
    expect(isValidEmail('')).toBe(false)
  })
})
