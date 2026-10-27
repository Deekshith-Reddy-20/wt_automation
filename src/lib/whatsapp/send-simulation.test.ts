import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  isMetaSendSimulated,
  sendInteractiveButtons,
  sendInteractiveList,
  sendTextMessage,
} from './meta-api'
import { withSimulatedMetaSends } from './send-simulation'
import { LANGUAGE_OPTIONS, WELCOME_TEXT } from '@/lib/suraj-solar/lead-flow'

const creds = { phoneNumberId: 'PNID', accessToken: 'TOKEN', to: '+915555599999' }
const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ messages: [{ id: 'wamid.REAL' }] }), { status: 200 }),
  )
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe('withSimulatedMetaSends', () => {
  it('records a genuine interactive-button payload without calling Meta', async () => {
    const { result, sends } = await withSimulatedMetaSends(() =>
      sendInteractiveButtons({
        ...creds,
        bodyText: WELCOME_TEXT,
        buttons: LANGUAGE_OPTIONS.map((l) => ({ id: l.id, title: l.title })),
      }),
    )
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.messageId).toMatch(/^wamid\.SIMULATED\./)
    expect(sends).toHaveLength(1)
    expect(sends[0].kind).toBe('interactive_buttons')
    expect(sends[0].payload).toMatchObject({
      messaging_product: 'whatsapp',
      to: '+915555599999',
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: WELCOME_TEXT },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'lang_te', title: 'తెలుగు' } },
            { type: 'reply', reply: { id: 'lang_en', title: 'English' } },
            { type: 'reply', reply: { id: 'lang_hi', title: 'हिंदी' } },
          ],
        },
      },
    })
  })

  it('records a genuine interactive-list payload', async () => {
    const { sends } = await withSimulatedMetaSends(() =>
      sendInteractiveList({
        ...creds,
        bodyText: 'What type of solar solution are you looking for?',
        buttonLabel: 'View options',
        sections: [{ rows: [{ id: 'solar_residential', title: 'Home rooftop solar' }] }],
      }),
    )
    expect(fetchMock).not.toHaveBeenCalled()
    expect(sends[0].payload).toMatchObject({
      type: 'interactive',
      interactive: {
        type: 'list',
        action: { button: 'View options', sections: [{ rows: [{ id: 'solar_residential' }] }] },
      },
    })
  })

  it('still enforces Meta limits inside a simulation', async () => {
    await expect(
      withSimulatedMetaSends(() =>
        sendInteractiveButtons({ ...creds, bodyText: 'x', buttons: [{ id: 'a', title: 'A title that is far too long' }] }),
      ),
    ).rejects.toThrow()
  })

  it('only simulates inside the scope', async () => {
    expect(isMetaSendSimulated()).toBe(false)
    await withSimulatedMetaSends(async () => {
      expect(isMetaSendSimulated()).toBe(true)
    })
    const real = await sendTextMessage({ ...creds, text: 'outside' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(real.messageId).toBe('wamid.REAL')
  })

  it('keeps concurrent requests outside the scope unaffected', async () => {
    const [simulated] = await Promise.all([
      withSimulatedMetaSends(() => sendTextMessage({ ...creds, text: 'inside' })),
      sendTextMessage({ ...creds, text: 'outside' }),
    ])
    expect(simulated.sends).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
