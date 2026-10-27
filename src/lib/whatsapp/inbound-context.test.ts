import { describe, expect, it } from 'vitest'
import {
  inboundSendCredentialsFor,
  inboundVerifiedRecipient,
  markInboundRecipientVerified,
  runWithInboundSendCredentials,
} from './inbound-context'

const creds = { accountId: 'acct-1', phoneNumberId: 'pn-1', accessToken: 'tok' }
const recipient = {
  contactId: 'ct-1',
  conversationId: 'cv-1',
  contact: { id: 'ct-1', phone: '919800000001', wa_user_id: null },
}

describe('inbound send context', () => {
  it('has nothing outside an inbound message', () => {
    expect(inboundSendCredentialsFor('acct-1')).toBeNull()
    expect(inboundVerifiedRecipient('acct-1', 'ct-1', 'cv-1')).toBeNull()
    markInboundRecipientVerified('acct-1', recipient)
    expect(inboundVerifiedRecipient('acct-1', 'ct-1', 'cv-1')).toBeNull()
  })

  it('returns the verified recipient only for the exact account, contact and conversation', async () => {
    await runWithInboundSendCredentials(creds, async () => {
      expect(inboundVerifiedRecipient('acct-1', 'ct-1', 'cv-1')).toBeNull()
      markInboundRecipientVerified('acct-1', recipient)
      expect(inboundVerifiedRecipient('acct-1', 'ct-1', 'cv-1')).toEqual(recipient.contact)
      expect(inboundVerifiedRecipient('acct-2', 'ct-1', 'cv-1')).toBeNull()
      expect(inboundVerifiedRecipient('acct-1', 'ct-2', 'cv-1')).toBeNull()
      expect(inboundVerifiedRecipient('acct-1', 'ct-1', 'cv-2')).toBeNull()
    })
  })

  it('ignores a verification for another account', async () => {
    await runWithInboundSendCredentials(creds, async () => {
      markInboundRecipientVerified('acct-2', recipient)
      expect(inboundVerifiedRecipient('acct-1', 'ct-1', 'cv-1')).toBeNull()
    })
  })

  it('keeps concurrent inbound messages isolated, even when given the same credentials object', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const a = runWithInboundSendCredentials(creds, async () => {
      markInboundRecipientVerified('acct-1', recipient)
      await gate
      return inboundVerifiedRecipient('acct-1', 'ct-1', 'cv-1')
    })
    const b = runWithInboundSendCredentials(creds, async () => {
      release()
      return inboundVerifiedRecipient('acct-1', 'ct-1', 'cv-1')
    })
    expect(await b).toBeNull()
    expect(await a).toEqual(recipient.contact)
  })
})
