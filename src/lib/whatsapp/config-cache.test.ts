import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  cacheInboundConfig,
  getCachedInboundConfig,
  invalidateWhatsAppConfigCache,
  whatsAppConfigCacheTtlMs,
  type InboundConfigRow,
} from './config-cache'

const row = (over: Partial<InboundConfigRow> = {}): InboundConfigRow => ({
  account_id: 'acc-1',
  user_id: 'user-1',
  phone_number_id: 'pn-1',
  access_token: 'ciphertext',
  mirror_inbound_media: true,
  ...over,
})

describe('whatsapp config cache', () => {
  beforeEach(() => {
    process.env.WHATSAPP_CONFIG_CACHE_TTL_MS = '30000'
    invalidateWhatsAppConfigCache()
  })
  afterEach(() => {
    delete process.env.WHATSAPP_CONFIG_CACHE_TTL_MS
    invalidateWhatsAppConfigCache()
  })

  it('serves a cached row until the TTL elapses', () => {
    cacheInboundConfig(row(), 1_000)
    expect(getCachedInboundConfig('pn-1', 1_000 + 29_999)?.account_id).toBe('acc-1')
    expect(getCachedInboundConfig('pn-1', 1_000 + 30_000)).toBeNull()
    // An expired entry is dropped, not revived.
    expect(getCachedInboundConfig('pn-1', 1_000)).toBeNull()
  })

  it('is keyed by phone_number_id', () => {
    cacheInboundConfig(row())
    expect(getCachedInboundConfig('pn-other')).toBeNull()
  })

  it('invalidates one account without touching others', () => {
    cacheInboundConfig(row())
    cacheInboundConfig(row({ account_id: 'acc-2', phone_number_id: 'pn-2' }))
    invalidateWhatsAppConfigCache('acc-1')
    expect(getCachedInboundConfig('pn-1')).toBeNull()
    expect(getCachedInboundConfig('pn-2')?.account_id).toBe('acc-2')
  })

  it('invalidates everything when no account is given', () => {
    cacheInboundConfig(row())
    cacheInboundConfig(row({ account_id: 'acc-2', phone_number_id: 'pn-2' }))
    invalidateWhatsAppConfigCache()
    expect(getCachedInboundConfig('pn-1')).toBeNull()
    expect(getCachedInboundConfig('pn-2')).toBeNull()
  })

  it('caches nothing when disabled with a TTL of 0', () => {
    process.env.WHATSAPP_CONFIG_CACHE_TTL_MS = '0'
    cacheInboundConfig(row())
    expect(getCachedInboundConfig('pn-1')).toBeNull()
  })

  it('treats an invalid TTL as disabled', () => {
    process.env.WHATSAPP_CONFIG_CACHE_TTL_MS = 'soon'
    expect(whatsAppConfigCacheTtlMs()).toBe(0)
  })

  it('is off by default under the test runner and 30 s otherwise', () => {
    delete process.env.WHATSAPP_CONFIG_CACHE_TTL_MS
    expect(whatsAppConfigCacheTtlMs()).toBe(0)
    const vitest = process.env.VITEST
    delete process.env.VITEST
    try {
      expect(whatsAppConfigCacheTtlMs()).toBe(30_000)
    } finally {
      process.env.VITEST = vitest
    }
  })
})
