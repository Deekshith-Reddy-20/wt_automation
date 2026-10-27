"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Activity, Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { IntegrationHealthState } from "@/lib/whatsapp/integration-health"

export interface HealthProbe {
  health?: { state: IntegrationHealthState; reasons: string[] }
  errors?: string[]
  token?: { type: string | null; expires_at: number | null; is_valid: boolean } | null
  webhook?: {
    app_secret: "ok" | "placeholder" | "missing"
    since: string
    last_post: { at: string; outcome: string } | null
    last_accepted_at: string | null
  } | null
  activity?: {
    last_inbound_at: string | null
    last_outbound_at: string | null
    last_outbound_status: string | null
    last_failure: { at: string; code: number | null; title: string | null } | null
  }
}

const STATE_CLASS: Record<IntegrationHealthState, string> = {
  connected: "bg-emerald-500/15 text-emerald-300 border-emerald-600/40",
  verification_pending: "bg-amber-500/15 text-amber-300 border-amber-600/40",
  missing_configuration: "bg-red-500/15 text-red-300 border-red-600/40",
  webhook_delivery_failed: "bg-red-500/15 text-red-300 border-red-600/40",
  message_send_failed: "bg-red-500/15 text-red-300 border-red-600/40",
}

const time = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : null)

/** Renders a verify-registration result: overall state + the evidence behind it. */
export function HealthDetails({ probe }: { probe: HealthProbe }) {
  const t = useTranslations("WhatsAppHealth")
  const { health, token, webhook, activity } = probe
  return (
    <div className="space-y-1.5 text-xs">
      {health && (
        <span className={cn("inline-flex rounded-full border px-2 py-0.5 font-medium", STATE_CLASS[health.state])}>
          {t(`state.${health.state}`)}
        </span>
      )}
      <ul className="space-y-0.5 text-muted-foreground">
        {webhook && (
          <li>
            {webhook.last_post
              ? t("lastWebhookPost", { outcome: t(`outcome.${webhook.last_post.outcome}`), time: time(webhook.last_post.at)! })
              : t("noWebhookPost", { since: time(webhook.since)! })}
          </li>
        )}
        {activity && (
          <>
            <li>{t("lastInbound", { time: time(activity.last_inbound_at) ?? t("never") })}</li>
            <li>
              {t("lastOutbound", {
                time: time(activity.last_outbound_at) ?? t("never"),
                status: activity.last_outbound_status ?? "—",
              })}
            </li>
            {activity.last_failure && (
              <li className="text-red-300">
                {t("lastFailure", {
                  time: time(activity.last_failure.at)!,
                  code: String(activity.last_failure.code ?? "—"),
                  title: activity.last_failure.title ?? "",
                })}
              </li>
            )}
          </>
        )}
        {token && (
          <li>
            {token.expires_at
              ? t("tokenExpires", { type: token.type ?? "—", time: new Date(token.expires_at * 1000).toLocaleString() })
              : t("tokenNeverExpires", { type: token.type ?? "—" })}
          </li>
        )}
      </ul>
      {(probe.errors ?? []).length > 0 && (
        <ul className="space-y-0.5 text-red-300">
          {probe.errors!.map((e, i) => (
            <li key={i}>• {e}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Automations-page panel: runs the same read-only checks on demand. */
export function WhatsAppHealthPanel() {
  const t = useTranslations("WhatsAppHealth")
  const [probe, setProbe] = useState<HealthProbe | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)

  async function check() {
    setLoading(true)
    setFailed(false)
    try {
      const res = await fetch("/api/whatsapp/config/verify-registration")
      if (!res.ok) throw new Error(String(res.status))
      setProbe(await res.json())
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Activity className="size-4 text-primary" />
          {t("title")}
        </div>
        <Button variant="outline" size="sm" onClick={check} disabled={loading}>
          {loading && <Loader2 className="size-3.5 animate-spin" />}
          {t("check")}
        </Button>
      </div>
      <div className="mt-3">
        {failed ? (
          <p className="text-xs text-red-300">{t("checkFailed")}</p>
        ) : probe ? (
          <HealthDetails probe={probe} />
        ) : (
          <p className="text-xs text-muted-foreground">{t("hint")}</p>
        )}
      </div>
    </div>
  )
}
