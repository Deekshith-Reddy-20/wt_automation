"use client"

import { useCallback, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { useTranslations } from "next-intl"
import { FlaskConical, History, Languages, Loader2, Pause, Pencil, Play, Workflow } from "lucide-react"

import { createClient } from "@/lib/supabase/client"
import { useCan } from "@/hooks/use-can"
import { formatRelative } from "@/lib/automations/trigger-meta"
import { LEAD_FLOW_NAME, LANGUAGE_OPTIONS } from "@/lib/suraj-solar/lead-flow"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FlowTestDialog } from "./flow-test-dialog"

interface LeadFlowRow {
  id: string
  name: string
  status: "draft" | "active" | "archived"
  trigger_type: string
  trigger_config: { restart_keywords?: string[] } | null
  entry_node_id: string | null
  execution_count: number
  last_executed_at: string | null
}

type DisplayStatus = "draft" | "active" | "paused" | "error"

const STATUS_CLASS: Record<DisplayStatus, string> = {
  draft: "border-border bg-muted text-muted-foreground",
  active: "border-primary/40 bg-primary/10 text-primary",
  paused: "border-amber-500/40 bg-amber-500/10 text-amber-400",
  error: "border-red-500/40 bg-red-500/10 text-red-400",
}

/**
 * Automations-page card for the Suraj Solar lead-qualification flow:
 * status, execution count, last run / error, and the edit, history,
 * activate / pause and simulated-test actions.
 */
export function LeadFlowCard() {
  const router = useRouter()
  const t = useTranslations("Automations.leadFlow")
  const tRelative = useTranslations("Automations.relative")
  const canAdmin = useCan("edit-settings")
  const [flow, setFlow] = useState<LeadFlowRow | null | undefined>(undefined)
  const [lastRunAt, setLastRunAt] = useState<string | null>(null)
  const [lastError, setLastError] = useState<string | null>(null)
  const [latestRunFailed, setLatestRunFailed] = useState(false)
  const [nodeCount, setNodeCount] = useState(0)
  const [confirmActivate, setConfirmActivate] = useState(false)
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)

  const load = useCallback(async () => {
    const supabase = createClient()
    const { data } = await supabase
      .from("flows")
      .select("id, name, status, trigger_type, trigger_config, entry_node_id, execution_count, last_executed_at")
      .eq("name", LEAD_FLOW_NAME)
      .limit(1)
      .maybeSingle()
    const row = (data as LeadFlowRow | null) ?? null
    setFlow(row)
    if (!row) return

    const [{ count }, { data: runs }] = await Promise.all([
      supabase.from("flow_nodes").select("id", { count: "exact", head: true }).eq("flow_id", row.id),
      supabase
        .from("flow_runs")
        .select("id, status, end_reason, started_at, last_advanced_at")
        .eq("flow_id", row.id)
        .order("started_at", { ascending: false })
        .limit(25),
    ])
    setNodeCount(count ?? 0)
    const recent = (runs ?? []) as Array<{ id: string; status: string; end_reason: string | null; last_advanced_at: string }>
    setLastRunAt(recent[0]?.last_advanced_at ?? row.last_executed_at)
    setLatestRunFailed(recent[0]?.status === "failed")

    const failed = recent.find((r) => r.status === "failed")
    let errorText: string | null = failed ? (failed.end_reason ?? "failed") : null
    if (recent.length > 0) {
      const { data: events } = await supabase
        .from("flow_run_events")
        .select("payload, created_at")
        .eq("event_type", "error")
        .in("flow_run_id", recent.map((r) => r.id))
        .order("created_at", { ascending: false })
        .limit(1)
      const payload = (events?.[0]?.payload ?? null) as { reason?: string; detail?: string } | null
      if (payload) errorText = [payload.reason, payload.detail].filter(Boolean).join(": ")
    }
    setLastError(errorText)
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  if (flow === undefined) return null

  if (flow === null) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-card/40 p-4 text-xs text-muted-foreground">
        <span className="font-semibold text-foreground">{LEAD_FLOW_NAME}</span> — {t("notInstalled")}
      </div>
    )
  }

  const structurallyValid = Boolean(flow.entry_node_id) && nodeCount > 0
  const status: DisplayStatus =
    !structurallyValid || latestRunFailed
      ? "error"
      : flow.status === "active"
        ? "active"
        : flow.status === "archived"
          ? "paused"
          : "draft"
  const isActive = flow.status === "active"
  const restart = flow.trigger_config?.restart_keywords ?? []

  async function setStatus(next: "active" | "archived") {
    if (!flow) return
    setBusy(true)
    const res = await fetch(`/api/flows/${flow.id}/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: next }),
    })
    setBusy(false)
    setConfirmActivate(false)
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      toast.error(res.status === 422 ? t("toasts.invalid") : t("toasts.updateFailed", { error: body?.error ?? res.status }))
      return
    }
    toast.success(next === "active" ? t("toasts.activated") : t("toasts.paused"))
    load()
  }

  return (
    <li className="list-none rounded-xl border border-border bg-card">
      <div className="flex flex-col gap-3 p-4 md:flex-row md:items-center">
        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10" aria-hidden>
          <Workflow className="h-5 w-5 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-semibold text-foreground">{flow.name}</span>
            <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-medium", STATUS_CLASS[status])}>
              {t(`status.${status}`)}
            </span>
            <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
              {t("badge")}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{t("trigger")}</span>
            {restart.length > 0 && (
              <>
                <span aria-hidden>·</span>
                <span>{t("restartHint", { keywords: restart.join(", ") })}</span>
              </>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Languages className="h-3.5 w-3.5" aria-label={t("languages")} />
            {LANGUAGE_OPTIONS.map((l) => (
              <span key={l.id} className="rounded bg-muted px-1.5 py-0.5">
                {l.crm}
              </span>
            ))}
            <span aria-hidden>·</span>
            <span className="tabular-nums">{t("executions", { count: flow.execution_count })}</span>
            <span aria-hidden>·</span>
            <span>{t("lastRun", { time: formatRelative(lastRunAt, tRelative) })}</span>
          </div>
          {(lastError || !structurallyValid) && (
            <p className="mt-1 truncate text-xs text-red-400">
              {t("lastError", { error: lastError ?? t("invalidConfig") })}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => router.push(`/flows/${flow.id}`)}>
            <Pencil className="h-3.5 w-3.5" />
            {t("edit")}
          </Button>
          <Button variant="outline" size="sm" onClick={() => router.push(`/flows/${flow.id}/runs`)}>
            <History className="h-3.5 w-3.5" />
            {t("history")}
          </Button>
          {canAdmin && (
            <>
              <Button variant="outline" size="sm" onClick={() => setTesting(true)}>
                <FlaskConical className="h-3.5 w-3.5" />
                {t("test")}
              </Button>
              {isActive ? (
                <Button variant="outline" size="sm" disabled={busy} onClick={() => setStatus("archived")}>
                  <Pause className="h-3.5 w-3.5" />
                  {t("pause")}
                </Button>
              ) : (
                <Button size="sm" disabled={busy || !structurallyValid} onClick={() => setConfirmActivate(true)}>
                  <Play className="h-3.5 w-3.5" />
                  {t("activate")}
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      <Dialog open={confirmActivate} onOpenChange={(v) => !v && setConfirmActivate(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("activateTitle")}</DialogTitle>
            <DialogDescription>{t("activateDesc")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmActivate(false)} disabled={busy}>
              {t("cancel")}
            </Button>
            <Button onClick={() => setStatus("active")} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {t("activateConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {testing && (
        <FlowTestDialog
          flowId={flow.id}
          open={testing}
          onOpenChange={(v) => {
            setTesting(v)
            if (!v) load()
          }}
        />
      )}
    </li>
  )
}
