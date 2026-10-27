import { NextResponse } from 'next/server'
import {
  ForbiddenError,
  UnauthorizedError,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { decrypt } from '@/lib/whatsapp/encryption'
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import { explainMetaError, metaErrorPayload } from '@/lib/whatsapp/meta-error-explain'
import { TEST_TEMPLATE, maskRecipient, resolveTestRecipient } from '@/lib/whatsapp/test-recipient'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

/**
 * GET /api/whatsapp/config/test-message
 *
 * Whether a test recipient is configured, masked. Nothing is sent.
 */
export async function GET() {
  try {
    await requireRole('admin')
    const recipient = resolveTestRecipient(process.env.WHATSAPP_TEST_RECIPIENT)
    return NextResponse.json({
      configured: recipient !== null,
      recipient: recipient ? maskRecipient(recipient) : null,
      template: TEST_TEMPLATE,
    })
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      return toErrorResponse(error)
    }
    return NextResponse.json({ error: t('common.internalServerError') }, { status: 500 })
  }
}

/**
 * POST /api/whatsapp/config/test-message  { confirm: true }
 *
 * Sends ONE real WhatsApp message — Meta's pre-approved `hello_world`
 * template — to WHATSAPP_TEST_RECIPIENT. Admin only, explicit confirm
 * required, rate limited. A 200 means Meta accepted the request; it
 * does not prove delivery — that arrives later as a status webhook.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`whatsapp-admin:${userId}`, RATE_LIMITS.whatsappAdmin)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (body?.confirm !== true) {
      return NextResponse.json({ error: t('whatsappConfig.testMessageConfirmRequired') }, { status: 400 })
    }

    const recipient = resolveTestRecipient(process.env.WHATSAPP_TEST_RECIPIENT)
    if (!recipient) {
      return NextResponse.json(
        { error: t('whatsappConfig.testRecipientMissing'), reason: 'missing_test_recipient' },
        { status: 400 },
      )
    }

    const { data: config } = await supabase
      .from('whatsapp_config')
      .select('phone_number_id, waba_id, access_token')
      .eq('account_id', accountId)
      .maybeSingle()
    if (!config) {
      return NextResponse.json({ error: t('whatsappConfig.noConfigShort') }, { status: 400 })
    }

    let accessToken: string
    try {
      accessToken = decrypt(config.access_token)
    } catch {
      return NextResponse.json({ error: t('whatsappConfig.tokenUndecryptable') }, { status: 400 })
    }

    try {
      const result = await sendTemplateMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: recipient,
        templateName: TEST_TEMPLATE.name,
        language: TEST_TEMPLATE.language,
      })
      return NextResponse.json({
        accepted: true,
        message_id: result.messageId,
        recipient: maskRecipient(recipient),
      })
    } catch (err) {
      const explained = explainMetaError(err, 'send_test', {
        phoneNumberId: config.phone_number_id,
        wabaId: config.waba_id ?? null,
      })
      return NextResponse.json(
        { accepted: false, error: explained.summary, meta: metaErrorPayload(explained) },
        { status: explained.httpStatus },
      )
    }
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      return toErrorResponse(error)
    }
    console.error('Error in WhatsApp test message POST:', error)
    return NextResponse.json({ error: t('common.internalServerError') }, { status: 500 })
  }
}
