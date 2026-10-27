import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  getPhoneRegistrationStatus,
  getSubscribedApps,
  getTokenInfo,
  type MetaPhoneRegistrationStatus,
  type MetaTokenInfo,
} from '@/lib/whatsapp/meta-api'
import { explainMetaError } from '@/lib/whatsapp/meta-error-explain'
import { markTokenRejected } from '@/lib/whatsapp/token-health'
import { appSecretStatus } from '@/lib/whatsapp/webhook-signature'
import { getWebhookHealth } from '@/lib/whatsapp/webhook-health'
import { deriveIntegrationHealth } from '@/lib/whatsapp/integration-health'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

/**
 * GET /api/whatsapp/config/verify-registration
 *
 * Diagnostic endpoint — confirms the user's saved phone number is
 * actually reachable on Meta's side. Solves the failure mode that
 * surfaced the multi-number bug originally: "UI says Connected but
 * Meta isn't delivering events."
 *
 * Three checks run independently so the UI can show which step
 * passes and which fails:
 *
 *   1. phone_metadata_ok — GET /{phone_number_id} succeeds
 *   2. registered_with_cloud_api — Meta reports platform_type
 *                    CLOUD_API for the number (registered_at is
 *                    synced to this, so the UI banner is
 *                    provider-confirmed, never a local guess)
 *   3. waba_subscribed_to_app — our app appears in
 *                    GET /{waba_id}/subscribed_apps
 *
 * Returns 200 in every case so the UI can render diagnostic detail
 * rather than a generic error toast. The combined `live` flag is
 * what the UI badges on.
 */
export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: t('common.unauthorized') }, { status: 401 })
  }

  const limit = checkRateLimit(`whatsapp-admin:${user.id}`, RATE_LIMITS.whatsappAdmin)
  if (!limit.success) return rateLimitResponse(limit)

  // whatsapp_config is one-row-per-account post-017. Resolve the
  // caller's account_id so a teammate who joined an existing account
  // sees the same registration state as the admin who set it up.
  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id, account_role')
    .eq('user_id', user.id)
    .maybeSingle()
  const accountId = profile?.account_id as string | undefined
  const isAdmin = profile?.account_role === 'owner' || profile?.account_role === 'admin'
  if (!accountId) {
    return NextResponse.json({
      live: false,
      checks: { config_exists: false },
      message: t('common.profileNotLinked'),
    })
  }

  const { data: config } = await supabase
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .maybeSingle()

  if (!config) {
    return NextResponse.json({
      live: false,
      checks: { config_exists: false },
      message: t('whatsappConfig.noConfigShort'),
    })
  }

  let accessToken: string
  try {
    accessToken = decrypt(config.access_token)
  } catch {
    return NextResponse.json({
      live: false,
      checks: {
        config_exists: true,
        token_decryptable: false,
      },
      message:
        t('whatsappConfig.tokenUndecryptable'),
    })
  }

  const checks: {
    config_exists: boolean
    token_decryptable: boolean
    phone_metadata_ok: boolean
    registered_with_cloud_api: boolean | null
    waba_subscribed_to_app: boolean | null
  } = {
    config_exists: true,
    token_decryptable: true,
    phone_metadata_ok: false,
    registered_with_cloud_api: null,
    waba_subscribed_to_app: null,
  }
  const errors: string[] = []
  const metaCtx = { phoneNumberId: config.phone_number_id, wabaId: config.waba_id ?? null }
  let phoneStatus: MetaPhoneRegistrationStatus | null = null

  // 1. Phone metadata + Meta's own registration state
  try {
    phoneStatus = await getPhoneRegistrationStatus({
      phoneNumberId: config.phone_number_id,
      accessToken,
    })
    checks.phone_metadata_ok = true
    checks.registered_with_cloud_api = phoneStatus.platform_type === 'CLOUD_API'
    if (!checks.registered_with_cloud_api) {
      errors.push(t('whatsappConfig.notRegisteredWithCloudApi', { platform: phoneStatus.platform_type ?? 'unknown' }))
    }
  } catch (err) {
    errors.push(
      t('whatsappConfig.phoneCheckFailed', { message: explainMetaError(err, 'verify_number', metaCtx).summary }),
    )
    await markTokenRejected(supabase, accountId, err, 'health check')
  }

  // Keep registered_at in step with what Meta reports, so the page's
  // "Registered" banner only ever reflects a provider-confirmed state.
  // RLS limits whatsapp_config updates to admins; for anyone else this
  // is a no-op and the probe result below still tells the truth.
  let registeredAt: string | null = config.registered_at ?? null
  if (checks.registered_with_cloud_api !== null) {
    const next = checks.registered_with_cloud_api ? (registeredAt ?? new Date().toISOString()) : null
    if (next !== registeredAt) {
      const { error: updateError } = await supabase
        .from('whatsapp_config')
        .update({ registered_at: next })
        .eq('account_id', accountId)
      if (!updateError) registeredAt = next
    }
  }

  // 2. WABA subscription — only meaningful if we have a waba_id
  if (config.waba_id) {
    try {
      const subs = await getSubscribedApps({
        wabaId: config.waba_id,
        accessToken,
      })
      // Meta returns the apps subscribed to this WABA. If the list
      // is non-empty, OUR app is in there (the access_token we used
      // belongs to our app — Meta wouldn't return data for an app
      // the token can't see). Treat any entry as success.
      checks.waba_subscribed_to_app = subs.length > 0
      if (!checks.waba_subscribed_to_app) {
        errors.push(
          t('whatsappConfig.wabaNoApps'),
        )
      }
    } catch (err) {
      errors.push(
        t('whatsappConfig.wabaCheckFailed', { message: explainMetaError(err, 'subscribed_apps', metaCtx).summary }),
      )
    }
  } else {
    errors.push(
      t('whatsappConfig.noWabaId'),
    )
  }

  // 3. The token itself — a short-lived token silently breaks every
  //    send a few hours after it was saved.
  let token: MetaTokenInfo | null = null
  try {
    token = await getTokenInfo(accessToken)
    const expiresSoon = token.expires_at ? token.expires_at * 1000 - Date.now() < 7 * 24 * 3600 * 1000 : false
    if (token.is_valid && expiresSoon) {
      errors.push(t('whatsappConfig.tokenExpiresSoon', { when: new Date(token.expires_at! * 1000).toISOString() }))
    }
  } catch {
    // Unreadable token info is already reflected by the phone check above.
  }

  const secretStatus = appSecretStatus()
  if (secretStatus !== 'ok') {
    errors.push(t(secretStatus === 'missing' ? 'whatsappConfig.appSecretMissing' : 'whatsappConfig.appSecretPlaceholder'))
  }

  const live =
    checks.phone_metadata_ok &&
    checks.registered_with_cloud_api === true &&
    (checks.waba_subscribed_to_app ?? false)

  const activity = await loadMessagingActivity(supabase, accountId)
  const webhook = getWebhookHealth()
  const health = deriveIntegrationHealth({
    appSecret: secretStatus,
    tokenValid: token ? token.is_valid : checks.phone_metadata_ok ? true : null,
    registeredWithCloudApi: checks.registered_with_cloud_api,
    wabaSubscribed: checks.waba_subscribed_to_app,
    lastWebhookOutcome: webhook.last_post?.outcome ?? null,
    webhookAccepted: webhook.last_accepted_at !== null,
    lastInboundAt: activity.last_inbound_at,
    lastOutboundStatus: activity.last_outbound_status,
  })

  return NextResponse.json({
    live,
    health,
    checks,
    errors,
    phone_status: phoneStatus
      ? { platform_type: phoneStatus.platform_type ?? null, status: phoneStatus.status ?? null }
      : null,
    token: token ? { type: token.type, expires_at: token.expires_at, is_valid: token.is_valid } : null,
    // Unauthenticated webhook traffic isn't tied to an account, so only
    // admins see the raw per-server record.
    webhook: isAdmin ? { app_secret: secretStatus, ...webhook } : null,
    activity,
    last_registration_error: config.last_registration_error ?? null,
    registered_at: registeredAt,
    subscribed_apps_at: config.subscribed_apps_at ?? null,
  })
}

/**
 * Evidence from the CRM's own records: when an inbound customer message
 * last arrived via the webhook, when we last sent one, and the most
 * recent send Meta reported as failed.
 */
async function loadMessagingActivity(
  supabase: Awaited<ReturnType<typeof createClient>>,
  accountId: string,
) {
  const latest = (build: (q: ReturnType<typeof base>) => ReturnType<typeof base>) =>
    build(base()).order('created_at', { ascending: false }).limit(1).maybeSingle()
  function base() {
    return supabase
      .from('messages')
      .select('created_at, status, error_code, error_title, conversations!inner(account_id)')
      .eq('conversations.account_id', accountId)
  }
  const [inbound, outbound, failed] = await Promise.all([
    latest((q) => q.eq('sender_type', 'customer')),
    latest((q) => q.neq('sender_type', 'customer')),
    latest((q) => q.neq('sender_type', 'customer').eq('status', 'failed')),
  ])
  return {
    last_inbound_at: inbound.data?.created_at ?? null,
    last_outbound_at: outbound.data?.created_at ?? null,
    last_outbound_status: outbound.data?.status ?? null,
    last_failure: failed.data
      ? {
          at: failed.data.created_at,
          code: failed.data.error_code ?? null,
          title: failed.data.error_title ?? null,
        }
      : null,
  }
}
