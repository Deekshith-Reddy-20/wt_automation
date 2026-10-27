"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2, RotateCcw, Send } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

interface ReplyOption {
  id: string
  title: string
  description?: string
}

interface TranscriptEntry {
  from: "customer" | "bot"
  text: string
  options?: ReplyOption[]
}

interface SimulatedPayload {
  text?: { body?: string }
  interactive?: {
    body?: { text?: string }
    action?: {
      buttons?: Array<{ reply?: { id: string; title: string } }>
      sections?: Array<{ rows?: Array<{ id: string; title: string; description?: string }> }>
    }
  }
}

interface SimulatedSend {
  kind: string
  payload: SimulatedPayload
}

interface TestResponse {
  sends?: SimulatedSend[]
  run?: { status: string; current_node_key: string | null; vars: Record<string, unknown> } | null
  error?: string
}

/** Turns a simulated Meta payload into a readable bubble + tappable options. */
function toEntry(send: SimulatedSend): TranscriptEntry | null {
  const p = send.payload
  if (send.kind === "text") return { from: "bot", text: String(p.text?.body ?? "") }
  if (send.kind === "interactive_buttons" || send.kind === "interactive_list") {
    const action = p.interactive?.action ?? {}
    const options: ReplyOption[] =
      send.kind === "interactive_buttons"
        ? (action.buttons ?? []).flatMap((b) => (b.reply ? [{ id: b.reply.id, title: b.reply.title }] : []))
        : (action.sections ?? []).flatMap((s) =>
            (s.rows ?? []).map((r) => ({ id: r.id, title: r.title, description: r.description })),
          )
    return { from: "bot", text: String(p.interactive?.body?.text ?? ""), options }
  }
  return null
}

/**
 * Drives a flow with mock inbound messages through
 * POST /api/flows/[id]/test. Every bot reply is simulated server-side;
 * nothing is sent to WhatsApp.
 */
export function FlowTestDialog({
  flowId,
  open,
  onOpenChange,
}: {
  flowId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const t = useTranslations("Automations.leadFlow.testDialog")
  const [entries, setEntries] = useState<TranscriptEntry[]>([])
  const [run, setRun] = useState<TestResponse["run"]>(null)
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function post(body: Record<string, unknown>): Promise<TestResponse | null> {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/flows/${flowId}/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      const json = (await res.json().catch(() => ({}))) as TestResponse
      if (!res.ok) {
        setError(t("failed", { error: json.error ?? String(res.status) }))
        return null
      }
      return json
    } finally {
      setBusy(false)
    }
  }

  async function send(message: Record<string, unknown>, label: string) {
    setEntries((prev) => [...prev, { from: "customer", text: label }])
    const json = await post({ message })
    if (!json) return
    const bot = (json.sends ?? []).map(toEntry).filter((e): e is TranscriptEntry => e !== null)
    setEntries((prev) => [...prev, ...bot])
    setRun(json.run ?? null)
  }

  async function reset() {
    const json = await post({ reset: true })
    if (!json) return
    setEntries([])
    setRun(null)
  }

  const lastOptions = [...entries].reverse().find((e) => e.from === "bot")?.options ?? []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("desc")}</DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[45vh] flex-col gap-2 overflow-y-auto rounded-md border border-border bg-muted/30 p-3">
          {entries.length === 0 && <p className="text-xs text-muted-foreground">{t("empty")}</p>}
          {entries.map((e, i) => (
            <div
              key={i}
              className={cn(
                "max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm",
                e.from === "customer" ? "self-end bg-primary/15 text-foreground" : "self-start bg-card text-foreground",
              )}
            >
              <div className="mb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                {e.from === "customer" ? t("customer") : t("bot")}
              </div>
              {e.text}
            </div>
          ))}
        </div>

        {lastOptions.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {lastOptions.map((o) => (
              <Button
                key={o.id}
                variant="outline"
                size="sm"
                disabled={busy}
                title={o.description}
                onClick={() => send({ kind: "interactive_reply", reply_id: o.id, reply_title: o.title }, o.title)}
              >
                {o.title}
              </Button>
            ))}
          </div>
        )}

        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            const value = text.trim()
            if (!value) return
            setText("")
            send({ kind: "text", text: value }, value)
          }}
        >
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t("placeholder")}
            className="bg-muted"
            disabled={busy}
          />
          <Button type="submit" disabled={busy || !text.trim()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {t("send")}
          </Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={reset}>
            <RotateCcw className="h-4 w-4" />
            {t("reset")}
          </Button>
        </form>

        {error && <p className="text-xs text-red-400">{error}</p>}
        {run && (
          <details className="text-xs text-muted-foreground">
            <summary>{t("runStatus", { status: run.status, node: run.current_node_key ?? "—" })}</summary>
            <pre className="mt-2 max-h-40 overflow-auto rounded bg-muted p-2 text-[11px]">
              {JSON.stringify(run.vars, null, 2)}
            </pre>
          </details>
        )}
      </DialogContent>
    </Dialog>
  )
}
