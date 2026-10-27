/**
 * Flow runner.
 *
 * The single entry point `dispatchInboundToFlows` is called by the
 * WhatsApp webhook on every inbound message *for an account that has
 * opted into the Flows beta*. It decides whether the message belongs
 * to an active conversation flow (advance it) or matches the entry
 * trigger of an active flow (start a new run) — and reports back to
 * the webhook so the webhook knows whether to also fire automations.
 *
 * Architecture in a sentence: the runner walks the customer through
 * a DB-stored node graph, suspending only at nodes that need
 * customer input. Each tap or text reply wakes it back up.
 *
 * What lives here vs elsewhere:
 *   - Pure decision logic (which button matched, where to advance to,
 *     when to fallback) — here.
 *   - DB shape (table reads/writes) — here.
 *   - Meta API calls — `meta-send.ts` (engineSendInteractive*).
 *   - Policy resolution (reprompt vs handoff vs end) — `fallback.ts`.
 *   - Type definitions — `types.ts`.
 *
 * Concurrency model:
 *   - Idempotency on `meta_message_id`: the runner refuses to advance
 *     an active run twice for the same Meta message — protects against
 *     Meta's retries.
 *   - Optimistic UPDATE with `current_node_key` precondition: two
 *     simultaneous taps for the same run collide at the DB layer; the
 *     second is a no-op.
 *   - Partial unique index `idx_one_active_run_per_contact`: two
 *     simultaneous starts for the same contact collide; the second
 *     INSERT raises 23505 and the runner catches & exits.
 */

import { supabaseAdmin } from "./admin-client";
import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
  engineSendMedia,
  engineSendText,
  type EngineSendResult,
} from "./meta-send";
import { decideFallback, resolveFallbackPolicy } from "./fallback";
import { addContactTagAndDispatch } from "@/lib/contacts/tag-events";
import { removeContactTag } from "@/lib/contacts/tag-write";
import { checkRunTimeout, markRunTimedOut, type RunTimeoutCheck } from "./timeout";
import {
  ASSIGNABLE_ROLES,
  pickRoundRobinAgent,
  type AssignableMember,
} from "@/lib/automations/assign";
import { normalizeKeyword } from "@/lib/contacts/opt-out";
import { markLatency } from "@/lib/whatsapp/latency-trace";
import {
  type CollectInputNodeConfig,
  type ConditionNodeConfig,
  type DispatchInboundInput,
  type DispatchInboundResult,
  type FlowNodeRow,
  type FlowRow,
  type FlowRunRow,
  type HandoffNodeConfig,
  type ParsedInbound,
  type RestartTriggerConfig,
  type ScoreLeadNodeConfig,
  type SendButtonsNodeConfig,
  type SendListNodeConfig,
  type SendMediaNodeConfig,
  type SendMessageNodeConfig,
  type SetTagNodeConfig,
  type StartNodeConfig,
  type KeywordTriggerConfig,
  type UpdateContactNodeConfig,
  AUTO_ADVANCING_NODE_TYPES,
} from "./types";

// ============================================================
// Pure helpers — extracted so engine.test.ts can exercise them
// without a Supabase / Meta mock.
// ============================================================

/**
 * Given a node + the customer's reply_id, return the next_node_key
 * to advance to, or `null` if no option matches.
 */
export function matchReplyId(
  node: { node_type: string; config: Record<string, unknown> },
  reply_id: string,
): string | null {
  if (node.node_type === "send_buttons") {
    const cfg = node.config as unknown as SendButtonsNodeConfig;
    const hit = cfg.buttons?.find((b) => b.reply_id === reply_id);
    return hit?.next_node_key ?? null;
  }
  if (node.node_type === "send_list") {
    const cfg = node.config as unknown as SendListNodeConfig;
    for (const section of cfg.sections ?? []) {
      const hit = section.rows?.find((r) => r.reply_id === reply_id);
      if (hit) return hit.next_node_key;
    }
    return null;
  }
  return null;
}

/**
 * Case-insensitive contains/exact match against a list of keywords.
 * Used by the trigger evaluator. Stable enough that the v3 builder
 * UI can preview matches by passing canned strings.
 */
export function matchesKeywordTrigger(
  text: string,
  cfg: KeywordTriggerConfig,
): boolean {
  if (!text || !cfg.keywords?.length) return false;
  const matchType = cfg.match_type ?? "contains";
  const haystack = cfg.case_sensitive ? text : text.toLowerCase();
  for (const raw of cfg.keywords) {
    if (!raw) continue;
    const needle = cfg.case_sensitive ? raw : raw.toLowerCase();
    if (matchType === "exact" ? haystack === needle : haystack.includes(needle)) {
      return true;
    }
  }
  return false;
}

/**
 * The strings an inbound message offers to a flow's *entry* trigger.
 *
 * Typed text offers itself. A button / list tap offers two: the visible
 * title — what the customer would have typed had the button not been
 * there — and the stable reply_id, because the automation engine's
 * `interactive_reply` trigger routes on the id, so an author moving a
 * menu into a flow reaches for the same value.
 *
 * Matching the id does mean a keyword that happens to be a substring of
 * an id can fire (ids are author-controlled slugs, defaulting to
 * `btn_1`). That is the same substring semantic keyword triggers
 * already have for typed text, and the alternative — ignoring the id —
 * silently breaks the author who keyed on it.
 */
export function entryTriggerTexts(message: ParsedInbound): string[] {
  if (message.kind === "text") return [message.text];
  return [...new Set([message.reply_title, message.reply_id])].filter(
    (v): v is string => Boolean(v && v.trim()),
  );
}

/**
 * True when a typed message is one of the flow's restart keywords.
 * Whole-message match after the same normalisation as opt-out
 * keywords (case, punctuation and emoji ignored).
 */
export function matchesRestartKeyword(
  message: ParsedInbound,
  triggerConfig: unknown,
): boolean {
  if (message.kind !== "text") return false;
  const keywords = (triggerConfig as RestartTriggerConfig | null)?.restart_keywords;
  if (!Array.isArray(keywords) || keywords.length === 0) return false;
  const text = normalizeKeyword(message.text);
  if (!text) return false;
  return keywords.some(
    (k) => typeof k === "string" && normalizeKeyword(k) === text,
  );
}

/** The button / list config fields shared by answer capture. */
function answerCaptureConfig(node: FlowNodeRow): {
  save_as?: string;
  text_reply_next?: string;
} {
  if (node.node_type !== "send_buttons" && node.node_type !== "send_list") {
    return {};
  }
  return node.config as { save_as?: string; text_reply_next?: string };
}

/** Longest typed answer kept in vars / the CRM. */
export const MAX_CAPTURED_TEXT_LENGTH = 1000;

/** Pure scoring for the `score_lead` node — see ScoreLeadNodeConfig. */
export function scoreLead(
  vars: Record<string, unknown>,
  cfg: Pick<ScoreLeadNodeConfig, "rules" | "bands" | "fallback_label">,
): { score: number; category: string; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  for (const rule of cfg.rules ?? []) {
    const raw = vars[rule.var_key];
    const value = raw === undefined || raw === null ? "" : String(raw);
    const hit =
      rule.values && rule.values.length > 0
        ? rule.values.includes(value)
        : value.trim() !== "";
    if (!hit) continue;
    score += Number(rule.points) || 0;
    reasons.push(
      `${rule.label ?? `${rule.var_key}=${value}`} (${rule.points >= 0 ? "+" : ""}${rule.points})`,
    );
  }
  const bands = [...(cfg.bands ?? [])].sort((a, b) => b.min_score - a.min_score);
  const band = bands.find((b) => score >= b.min_score);
  return { score, category: band?.label ?? cfg.fallback_label, reasons };
}

/**
 * Resolve an update_contact value: `{{vars.x}}`, `{{today}}` and
 * `{{today+N}}` (ISO yyyy-mm-dd, UTC). A template that is exactly one
 * `{{vars.x}}` token goes through `value_map` first.
 */
export function resolveContactFieldValue(
  template: string,
  vars: Record<string, unknown>,
  valueMap?: Record<string, string>,
  now: Date = new Date(),
): string {
  if (!template) return "";
  const single = /^\{\{vars\.([a-zA-Z0-9_]+)\}\}$/.exec(template.trim());
  if (single && valueMap) {
    const raw = vars[single[1]];
    const key = raw === undefined || raw === null ? "" : String(raw);
    if (key && valueMap[key] !== undefined) return valueMap[key];
  }
  return template
    .replace(/\{\{today(?:\+(\d{1,4}))?\}\}/g, (_, days) => {
      const d = new Date(now.getTime() + (days ? Number(days) : 0) * 86_400_000);
      return d.toISOString().slice(0, 10);
    })
    .replace(/\{\{vars\.([a-zA-Z0-9_]+)\}\}/g, (_, key) => {
      const v = vars[key];
      return v === undefined || v === null ? "" : String(v);
    })
    .trim();
}

/**
 * Interpolate a multi-line note, dropping any line whose `{{…}}`
 * tokens all resolved empty (an unanswered question).
 */
export function renderLeadNote(
  template: string,
  vars: Record<string, unknown>,
  now: Date = new Date(),
): string {
  return template
    .split("\n")
    .filter((line) => {
      const tokens = line.match(/\{\{[^}]+\}\}/g);
      if (!tokens) return true;
      return tokens.some((tok) => resolveContactFieldValue(tok, vars, undefined, now) !== "");
    })
    .map((line) => resolveContactFieldValue(line, vars, undefined, now))
    .join("\n")
    .trim();
}

/** Nodes that advance to a next_node_key without waiting for input. */
export function isAutoAdvancing(node_type: string): boolean {
  return AUTO_ADVANCING_NODE_TYPES.has(node_type);
}

export type ActiveRunClosure =
  | { kind: "cancel"; reason: "flow_not_active" | "current_node_removed" }
  | { kind: "fail"; reason: "active_run_missing_current_node" }
  | { kind: "timeout"; check: RunTimeoutCheck };

export function closureForActiveRun(args: {
  run: Pick<FlowRunRow, "current_node_key" | "last_advanced_at">;
  flow: Pick<FlowRow, "status" | "fallback_policy"> | null;
  nodeKeys: ReadonlySet<string> | { has(key: string): boolean };
  now: Date;
}): ActiveRunClosure | null {
  if (!args.flow || args.flow.status !== "active") {
    return { kind: "cancel", reason: "flow_not_active" };
  }
  const check = checkRunTimeout(
    args.run.last_advanced_at,
    args.flow.fallback_policy,
    args.now,
  );
  if (check.timedOut) return { kind: "timeout", check };
  if (!args.run.current_node_key) {
    return { kind: "fail", reason: "active_run_missing_current_node" };
  }
  if (!args.nodeKeys.has(args.run.current_node_key)) {
    return { kind: "cancel", reason: "current_node_removed" };
  }
  return null;
}

/** Nodes that send a prompt and suspend awaiting a customer reply. */
export function isSuspending(node_type: string): boolean {
  return (
    node_type === "send_buttons" ||
    node_type === "send_list" ||
    node_type === "collect_input"
  );
}

/** Nodes that end the run. */
export function isTerminal(node_type: string): boolean {
  return node_type === "handoff" || node_type === "end";
}

/**
 * Evaluate a `condition` node's predicate against the current run
 * state. Exported pure for unit testing — the engine wraps it with a
 * DB lookup for `tag` / `contact_field` subjects.
 */
export function evaluateConditionPredicate(args: {
  operator: ConditionNodeConfig["operator"];
  /**
   * Resolved value of the subject. `undefined` means the subject is
   * absent (no var with that key / no such tag / contact field is
   * null). Pure function: caller does the DB lookup.
   */
  subjectValue: string | undefined;
  /** The configured comparison value, when applicable. */
  configValue: string | undefined;
}): boolean {
  switch (args.operator) {
    case "present":
      return args.subjectValue !== undefined && args.subjectValue !== "";
    case "absent":
      return args.subjectValue === undefined || args.subjectValue === "";
    case "equals":
      if (args.subjectValue === undefined) return false;
      return args.subjectValue === (args.configValue ?? "");
    case "contains":
      if (args.subjectValue === undefined) return false;
      return args.subjectValue.includes(args.configValue ?? "");
  }
}

// ============================================================
// DB I/O — wrapped in tiny helpers so the dispatch flow stays
// readable. Errors surface as thrown — the entry point catches.
// ============================================================

type AdminClient = ReturnType<typeof supabaseAdmin>;

async function loadActiveRunForContact(
  db: AdminClient,
  accountId: string,
  contactId: string,
): Promise<FlowRunRow | null> {
  // The partial unique index `idx_one_active_run_per_contact` was
  // rebuilt in migration 017 over `(account_id, contact_id)` — so
  // "two active runs for one contact in one account" is impossible
  // by design. But a future migration glitch or manual SQL could
  // create one, and .maybeSingle() throws on >1 row — which would
  // kill dispatch for that contact's webhook entirely. .limit(1) is
  // forgiving: pick the newest, let the cron sweep clean up the
  // stale one.
  const { data, error } = await db
    .from("flow_runs")
    .select("*")
    .eq("account_id", accountId)
    .eq("contact_id", contactId)
    .eq("status", "active")
    .order("started_at", { ascending: false })
    .limit(1);
  if (error) {
    console.error("[flows] loadActiveRunForContact error:", error.message);
    return null;
  }
  const rows = (data as FlowRunRow[] | null) ?? [];
  return rows[0] ?? null;
}

async function loadFlow(
  db: AdminClient,
  flowId: string,
): Promise<FlowRow | null> {
  const { data, error } = await db
    .from("flows")
    .select("*")
    .eq("id", flowId)
    .maybeSingle();
  if (error) {
    console.error("[flows] loadFlow error:", error.message);
    return null;
  }
  return (data as FlowRow | null) ?? null;
}

/**
 * Load every node of a flow in one round trip and key them by
 * `node_key`. The advance loop is then in-memory — a 5-node
 * auto-advancing chain costs one SELECT, not five.
 *
 * Returns an empty map on error so the caller can still dispatch
 * cleanly (every subsequent .get() returns undefined → the run
 * fails with node_not_found, same as the old per-node lookup).
 */
async function loadAllNodes(
  db: AdminClient,
  flowId: string,
): Promise<Map<string, FlowNodeRow>> {
  const { data, error } = await db
    .from("flow_nodes")
    .select("*")
    .eq("flow_id", flowId);
  if (error) {
    console.error("[flows] loadAllNodes error:", error.message);
    return new Map();
  }
  const map = new Map<string, FlowNodeRow>();
  for (const row of (data ?? []) as FlowNodeRow[]) {
    map.set(row.node_key, row);
  }
  return map;
}

// Run timelines are ordered by created_at. Stamping it when the event is
// logged (strictly increasing within this process) keeps that order even
// when an insert is issued without awaiting the previous one.
let lastEventMs = 0;
function nextEventTimestamp(): string {
  lastEventMs = Math.max(Date.now(), lastEventMs + 1);
  return new Date(lastEventMs).toISOString();
}

async function logEvent(
  db: AdminClient,
  flowRunId: string,
  event_type:
    | "started"
    | "node_entered"
    | "message_sent"
    | "reply_received"
    | "fallback_fired"
    | "handoff"
    | "timeout"
    | "error"
    | "completed",
  node_key: string | null,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await db.from("flow_run_events").insert({
    flow_run_id: flowRunId,
    event_type,
    node_key,
    payload,
    created_at: nextEventTimestamp(),
  });
  if (error) {
    // Logging failure is non-fatal — surface but don't throw.
    console.error("[flows] logEvent error:", error.message);
  }
}

/**
 * Idempotency check — has a `reply_received` event with this Meta
 * message_id already been recorded for any of the contact's flow
 * runs? If yes, the inbound is a duplicate (Meta retry) and we
 * exit without re-advancing.
 *
 * Implementation note: scoped to runs belonging to this user/contact
 * so the lookup is cheap (the index on flow_run_events(flow_run_id,
 * event_type) plus the small set of runs per contact).
 */
/**
 * ALL run ids for this contact in this account (active + historical).
 * Bounded by how many flows the customer has been through — small.
 */
async function loadContactRunIds(
  db: AdminClient,
  accountId: string,
  contactId: string,
): Promise<string[]> {
  const { data: runs } = await db
    .from("flow_runs")
    .select("id")
    .eq("account_id", accountId)
    .eq("contact_id", contactId);
  return (runs ?? []).map((r) => (r as { id: string }).id);
}

async function isDuplicateInbound(
  db: AdminClient,
  metaMessageId: string,
  runIds: string[],
): Promise<boolean> {
  if (!runIds.length) return false;
  const { count } = await db
    .from("flow_run_events")
    .select("id", { count: "exact", head: true })
    .in("flow_run_id", runIds)
    .eq("event_type", "reply_received")
    .filter("payload->>meta_message_id", "eq", metaMessageId);
  return (count ?? 0) > 0;
}

async function findEntryFlow(
  db: AdminClient,
  accountId: string,
  message: ParsedInbound,
  isFirstInbound: boolean,
  testFlowId?: string,
  activeFlows?: Promise<FlowRow[] | null>,
): Promise<FlowRow | null> {
  if (testFlowId) {
    const flow = await loadFlow(db, testFlowId);
    return flow && flow.account_id === accountId
      ? { ...flow, status: "active" }
      : null;
  }
  const flows = await (activeFlows ?? loadActiveFlows(db, accountId));
  return flows ? pickEntryFlow(flows, message, isFirstInbound) : null;
}

/**
 * All active flows for the account, oldest first. Bounded (the builder
 * discourages double-trigger overlap) and index-supported by the
 * partial index on status. Resolves null on a read error.
 */
async function loadActiveFlows(
  db: AdminClient,
  accountId: string,
): Promise<FlowRow[] | null> {
  const { data, error } = await db
    .from("flows")
    .select("*")
    .eq("account_id", accountId)
    .eq("status", "active")
    .order("created_at", { ascending: true });
  return error || !data ? null : (data as FlowRow[]);
}

function pickEntryFlow(
  flows: FlowRow[],
  message: ParsedInbound,
  isFirstInbound: boolean,
): FlowRow | null {
  // A tap used to be rejected outright here, on the reasoning that
  // interactive replies are responses to existing prompts. That holds
  // only while a prompt is outstanding — and this function runs solely
  // when the contact has NO active run, so there is nothing the tap
  // could be answering. What it actually blocked was issue #490: an
  // *automation* sends the buttons, the customer taps one, and the flow
  // whose keyword matches that button never starts. Retyping the label
  // by hand worked, which is the tell — same words, different envelope.
  const candidates = entryTriggerTexts(message);
  for (const flow of flows) {
    if (matchesRestartKeyword(message, flow.trigger_config)) {
      return flow;
    }
    if (flow.trigger_type === "keyword") {
      const cfg = flow.trigger_config as KeywordTriggerConfig;
      if (candidates.some((text) => matchesKeywordTrigger(text, cfg))) {
        return flow;
      }
    } else if (flow.trigger_type === "first_inbound_message" && isFirstInbound) {
      // Also reachable by a tap now: a broadcast template with a
      // quick-reply button can genuinely be what prompts a contact's
      // first-ever inbound. The automations dispatcher has always
      // treated a tap that way (the webhook pushes
      // `first_inbound_message` regardless of envelope) — flows were
      // the inconsistent half.
      return flow;
    }
    // 'manual' triggers do not auto-start from inbound messages.
  }
  return null;
}

// ============================================================
// Node executors — each handles ONE node type. send_buttons and
// send_list also persist `last_prompt_message_id` so the inbox
// thread can quote the prompt the customer is replying to.
// ============================================================

async function sendButtonsAndSuspend(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<{ outcome: "advanced"; node_key: string }> {
  const cfg = node.config as unknown as SendButtonsNodeConfig;
  // Every customer-visible string is interpolated against run.vars —
  // same treatment send_message / collect_input already get (#553).
  // `reply_id` is deliberately NOT interpolated: it is the routing key
  // matchReplyId compares the tapped button against, so it must reach
  // Meta byte-for-byte as authored. Interpolation can push a title past
  // Meta's 20-char cap; meta-api's validator throws a descriptive error
  // and the caller logs it — we never truncate silently.
  const sent = await engineSendInteractiveButtons({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText: interpolateVars(cfg.text, run.vars),
    headerText: interpolateOptionalVars(cfg.header_text, run.vars),
    footerText: interpolateOptionalVars(cfg.footer_text, run.vars),
    buttons: cfg.buttons.map((b) => ({
      id: b.reply_id,
      title: interpolateVars(b.title, run.vars),
    })),
  });
  await recordPromptSent(db, run, node.node_key, "send_buttons", sent);
  return { outcome: "advanced", node_key: node.node_key };
}

/**
 * Log the send and stash the prompt's messages.id on the run so the inbox
 * can quote it. Both writes are independent, so they share one round trip.
 */
async function recordPromptSent(
  db: AdminClient,
  run: FlowRunRow,
  nodeKey: string,
  nodeType: "send_buttons" | "send_list" | "collect_input",
  sent: EngineSendResult,
): Promise<void> {
  let promptId = sent.message_row_id;
  if (promptId === undefined) {
    const { data: msg } = await db
      .from("messages")
      .select("id")
      .eq("message_id", sent.whatsapp_message_id)
      .maybeSingle();
    promptId = (msg as { id: string } | null)?.id ?? null;
  }
  await Promise.all([
    logEvent(db, run.id, "message_sent", nodeKey, {
      node_type: nodeType,
      whatsapp_message_id: sent.whatsapp_message_id,
    }),
    db
      .from("flow_runs")
      .update({ last_prompt_message_id: promptId })
      .eq("id", run.id),
  ]);
}

async function sendListAndSuspend(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<{ outcome: "advanced"; node_key: string }> {
  const cfg = node.config as unknown as SendListNodeConfig;
  // See sendButtonsAndSuspend — interpolate every visible string,
  // never the row `reply_id`.
  const sent = await engineSendInteractiveList({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText: interpolateVars(cfg.text, run.vars),
    buttonLabel: interpolateVars(cfg.button_label, run.vars),
    headerText: interpolateOptionalVars(cfg.header_text, run.vars),
    footerText: interpolateOptionalVars(cfg.footer_text, run.vars),
    sections: cfg.sections.map((s) => ({
      title: interpolateOptionalVars(s.title, run.vars),
      rows: s.rows.map((r) => ({
        id: r.reply_id,
        title: interpolateVars(r.title, run.vars),
        description: interpolateOptionalVars(r.description, run.vars),
      })),
    })),
  });
  await recordPromptSent(db, run, node.node_key, "send_list", sent);
  return { outcome: "advanced", node_key: node.node_key };
}

async function executeHandoff(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<void> {
  const cfg = node.config as HandoffNodeConfig;
  const convUpdate: Record<string, unknown> = {
    status: "pending",
    updated_at: new Date().toISOString(),
  };
  let assignedTo: string | null = cfg.assign_to || null;
  if (!assignedTo && cfg.assign_mode === "round_robin" && run.contact_id) {
    assignedTo = await pickRoundRobinForRun(db, run);
  }
  if (assignedTo) convUpdate.assigned_agent_id = assignedTo;
  if (run.conversation_id) {
    await db
      .from("conversations")
      .update(convUpdate)
      .eq("id", run.conversation_id);
  }
  await logEvent(db, run.id, "handoff", node.node_key, {
    note: cfg.note ?? null,
    assigned_to: assignedTo,
    assign_mode: cfg.assign_mode ?? "fixed",
  });
  await endRun(db, run.id, "handed_off", "handoff_node");
}

/** Same least-loaded picker and queries as the automations engine. */
async function pickRoundRobinForRun(
  db: AdminClient,
  run: FlowRunRow,
): Promise<string | null> {
  const [{ data: members }, { data: open }, { data: current }] = await Promise.all([
    db
      .from("profiles")
      .select("user_id, account_role")
      .eq("account_id", run.account_id)
      .in("account_role", [...ASSIGNABLE_ROLES]),
    db
      .from("conversations")
      .select("assigned_agent_id")
      .eq("account_id", run.account_id)
      .neq("status", "closed")
      .not("assigned_agent_id", "is", null),
    db
      .from("conversations")
      .select("assigned_agent_id")
      .eq("account_id", run.account_id)
      .eq("contact_id", run.contact_id!)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle(),
  ]);
  return pickRoundRobinAgent(
    (members ?? []) as AssignableMember[],
    ((open ?? []) as { assigned_agent_id: string | null }[]).map((r) => r.assigned_agent_id),
    (current as { assigned_agent_id: string | null } | null)?.assigned_agent_id,
  );
}

/**
 * Write an update_contact node's fields and note. Custom field ids are
 * checked against the run's account first (the service-role client
 * bypasses RLS). Returns how many fields were written.
 */
async function applyUpdateContact(
  db: AdminClient,
  run: FlowRunRow,
  cfg: UpdateContactNodeConfig,
): Promise<{ fields: number; note: boolean }> {
  const now = new Date();
  const builtIns: Record<string, string> = {};
  // Keyed by field id: one upsert can't touch the same row twice.
  const customById = new Map<string, string>();
  for (const field of cfg.fields ?? []) {
    const value = resolveContactFieldValue(field.value, run.vars, field.value_map, now);
    if (!value) continue;
    if (field.target.startsWith("custom:")) {
      const id = field.target.slice("custom:".length);
      if (id) customById.set(id, value.slice(0, MAX_CAPTURED_TEXT_LENGTH));
    } else if (["name", "email", "company"].includes(field.target)) {
      builtIns[field.target] = value.slice(0, 200);
    }
  }
  const custom = [...customById].map(([id, value]) => ({ id, value }));

  // The three writes touch different tables, so they run concurrently;
  // all of them settle before the flow moves on.
  const writeBuiltIns = async (): Promise<number> => {
    if (Object.keys(builtIns).length === 0) return 0;
    await db
      .from("contacts")
      .update({ ...builtIns, updated_at: now.toISOString() })
      .eq("id", run.contact_id!)
      .eq("account_id", run.account_id);
    return Object.keys(builtIns).length;
  };
  const writeCustom = async (): Promise<number> => {
    if (custom.length === 0) return 0;
    const { data: owned } = await db
      .from("custom_fields")
      .select("id")
      .eq("account_id", run.account_id)
      .in(
        "id",
        custom.map((c) => c.id),
      );
    const ownedIds = new Set(((owned ?? []) as { id: string }[]).map((r) => r.id));
    const rows = custom
      .filter((c) => ownedIds.has(c.id))
      .map((c) => ({ contact_id: run.contact_id!, custom_field_id: c.id, value: c.value }));
    if (rows.length === 0) return 0;
    const { error } = await db
      .from("contact_custom_values")
      .upsert(rows, { onConflict: "contact_id,custom_field_id" });
    if (error) throw new Error(error.message);
    return rows.length;
  };
  const writeNote = async (): Promise<boolean> => {
    if (!cfg.note?.trim()) return false;
    const text = renderLeadNote(cfg.note, run.vars, now);
    if (!text) return false;
    const { error } = await db.from("contact_notes").insert({
      contact_id: run.contact_id!,
      account_id: run.account_id,
      user_id: run.user_id,
      note_text: text,
    });
    if (error) throw new Error(error.message);
    return true;
  };

  const [builtInCount, customCount, note] = await Promise.allSettled([
    writeBuiltIns(),
    writeCustom(),
    writeNote(),
  ]);
  for (const r of [builtInCount, customCount, note]) {
    if (r.status === "rejected") throw r.reason;
  }
  return {
    fields:
      (builtInCount as PromiseFulfilledResult<number>).value +
      (customCount as PromiseFulfilledResult<number>).value,
    note: (note as PromiseFulfilledResult<boolean>).value,
  };
}

async function persistRunVars(
  db: AdminClient,
  run: FlowRunRow,
  vars: Record<string, unknown>,
): Promise<void> {
  const { error } = await db
    .from("flow_runs")
    .update({ vars })
    .eq("id", run.id)
    .eq("status", "active");
  if (error) throw new Error(error.message);
  run.vars = vars;
}

/**
 * Resolve a condition node's subject value from DB / run state, then
 * call the pure `evaluateConditionPredicate`. Splits out so the
 * predicate itself stays unit-testable without a Supabase mock.
 *
 * Subject sources:
 *   - `var` → `flow_runs.vars[subject_key]` (captured by collect_input
 *     or http_fetch in v2).
 *   - `tag` → present iff `contact_tags(contact_id, tag_id)` exists.
 *     `subject_key` IS the tag UUID; the SELECT returns 1 row or 0.
 *   - `contact_field` → one of name/email/phone/company on `contacts`.
 */
async function evaluateConditionNode(
  db: AdminClient,
  run: FlowRunRow,
  cfg: ConditionNodeConfig,
): Promise<boolean> {
  let subjectValue: string | undefined;
  if (cfg.subject === "var") {
    const v = run.vars[cfg.subject_key];
    subjectValue = typeof v === "string" ? v : v === undefined ? undefined : String(v);
  } else if (cfg.subject === "tag") {
    const { count } = await db
      .from("contact_tags")
      .select("contact_id", { count: "exact", head: true })
      .eq("contact_id", run.contact_id!)
      .eq("tag_id", cfg.subject_key);
    // For tags, "present" really is the only meaningful test — the
    // `present`/`absent` operators are the natural fit. equals/contains
    // against a tag UUID would still work mechanically (compare its
    // existence to the value).
    subjectValue = (count ?? 0) > 0 ? cfg.subject_key : undefined;
  } else {
    const ALLOWED = ["name", "email", "phone", "company"] as const;
    type AllowedField = (typeof ALLOWED)[number];
    if (!ALLOWED.includes(cfg.subject_key as AllowedField)) {
      throw new Error(`unsupported contact_field: ${cfg.subject_key}`);
    }
    const { data } = await db
      .from("contacts")
      .select(cfg.subject_key)
      .eq("id", run.contact_id!)
      .maybeSingle();
    const raw = (data as Record<string, unknown> | null)?.[cfg.subject_key];
    subjectValue = typeof raw === "string" && raw.length > 0 ? raw : undefined;
  }
  return evaluateConditionPredicate({
    operator: cfg.operator,
    subjectValue,
    configValue: cfg.value,
  });
}

/**
 * Tiny `{{vars.foo}}` interpolation. Used by send_message + collect_input
 * prompt text so a captured `name` can show up in the next prompt
 * ("Thanks {{vars.name}}, what's your email?"). Missing vars render as
 * empty string — the same behavior as the automations engine.
 */
function interpolateVars(template: string, vars: Record<string, unknown>): string {
  if (!template) return "";
  return template.replace(/\{\{vars\.([a-zA-Z0-9_]+)\}\}/g, (_, key) => {
    const v = vars[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

/**
 * `interpolateVars` for optional config fields (header_text, footer_text,
 * list section titles, row descriptions). An absent field stays absent
 * — `interpolateVars(undefined)` would return "" and meta-api treats
 * header/footer/description by truthiness, so "" is harmless there, but
 * keeping `undefined` means the payload we log and send matches what
 * the author configured rather than sprouting empty strings.
 */
function interpolateOptionalVars(
  template: string | undefined,
  vars: Record<string, unknown>,
): string | undefined {
  return template === undefined || template === null
    ? undefined
    : interpolateVars(template, vars);
}

async function endRun(
  db: AdminClient,
  runId: string,
  status: "completed" | "handed_off" | "cancelled" | "failed",
  reason: string,
): Promise<void> {
  await db
    .from("flow_runs")
    .update({
      status,
      ended_at: new Date().toISOString(),
      end_reason: reason,
    })
    .eq("id", runId)
    .eq("status", "active");
}

// ============================================================
// The synchronous advance loop. Walks through auto-advance nodes
// until it hits one that suspends (send_buttons/send_list) or
// terminates (handoff/end). Each suspending node persists the
// new current_node_key before returning.
// ============================================================

export const MAX_NODES_PER_ADVANCE = 25;

async function advanceFromNodeKey(
  db: AdminClient,
  run: FlowRunRow,
  startNodeKey: string,
  nodes: Map<string, FlowNodeRow>,
): Promise<{ outcome: "advanced" | "completed" | "handed_off" }> {
  // Plain node_entered audit rows are written alongside the node's work
  // instead of before it; all are flushed before this returns.
  const pendingEvents: Promise<void>[] = [];
  try {
    return await advanceLoop(db, run, startNodeKey, nodes, pendingEvents);
  } finally {
    await Promise.all(pendingEvents);
  }
}

async function advanceLoop(
  db: AdminClient,
  run: FlowRunRow,
  startNodeKey: string,
  nodes: Map<string, FlowNodeRow>,
  pendingEvents: Promise<void>[],
): Promise<{ outcome: "advanced" | "completed" | "handed_off" }> {
  let currentKey: string | null = startNodeKey;
  for (let safety = 0; safety < MAX_NODES_PER_ADVANCE; safety += 1) {
    if (!currentKey) {
      await logEvent(db, run.id, "error", null, {
        reason: "next_node_key was null mid-advance",
      });
      await endRun(db, run.id, "failed", "missing_next_node");
      return { outcome: "completed" };
    }
    const node: FlowNodeRow | null = nodes.get(currentKey) ?? null;
    if (!node) {
      await logEvent(db, run.id, "error", currentKey, {
        reason: "node_not_found",
      });
      await endRun(db, run.id, "failed", "node_not_found");
      return { outcome: "completed" };
    }
    pendingEvents.push(
      logEvent(db, run.id, "node_entered", node.node_key, {
        node_type: node.node_type,
      }),
    );

    if (node.node_type === "start") {
      currentKey = (node.config as unknown as StartNodeConfig).next_node_key;
      continue;
    }
    if (node.node_type === "send_message") {
      const cfg = node.config as unknown as SendMessageNodeConfig;
      try {
        const { whatsapp_message_id } = await engineSendText({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.text, run.vars),
        });
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "send_message",
          whatsapp_message_id,
        });
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_text_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "send_text_failed");
        return { outcome: "completed" };
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "send_media") {
      const cfg = node.config as unknown as SendMediaNodeConfig;
      try {
        const { whatsapp_message_id } = await engineSendMedia({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          kind: cfg.media_type,
          link: cfg.media_url,
          caption: cfg.caption
            ? interpolateVars(cfg.caption, run.vars)
            : undefined,
          filename: cfg.filename,
        });
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "send_media",
          media_type: cfg.media_type,
          whatsapp_message_id,
        });
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_media_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "send_media_failed");
        return { outcome: "completed" };
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "collect_input") {
      // Send the prompt and suspend. Customer's next TEXT reply will
      // wake us up via handleReplyForActiveRun's collect_input branch.
      const cfg = node.config as unknown as CollectInputNodeConfig;
      try {
        const sent = await engineSendText({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.prompt_text, run.vars),
        });
        await recordPromptSent(db, run, node.node_key, "collect_input", sent);
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "collect_input_prompt_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "collect_input_prompt_failed");
        return { outcome: "completed" };
      }
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "condition") {
      const cfg = node.config as unknown as ConditionNodeConfig;
      let branch: "true" | "false";
      try {
        branch = (await evaluateConditionNode(db, run, cfg))
          ? "true"
          : "false";
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "condition_evaluation_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "condition_evaluation_failed");
        return { outcome: "completed" };
      }
      currentKey =
        branch === "true" ? cfg.true_next : cfg.false_next;
      pendingEvents.push(
        logEvent(db, run.id, "node_entered", node.node_key, {
          condition_result: branch,
          advancing_to: currentKey,
        }),
      );
      continue;
    }
    if (node.node_type === "set_tag") {
      const cfg = node.config as unknown as SetTagNodeConfig;
      try {
        if (cfg.mode === "add") {
          await addContactTagAndDispatch({
            db,
            accountId: run.account_id,
            contactId: run.contact_id!,
            tagId: cfg.tag_id,
            context: {
              conversation_id: run.conversation_id ?? undefined,
              vars: run.vars,
            },
          });
        } else {
          await removeContactTag(db, {
            accountId: run.account_id,
            contactId: run.contact_id!,
            tagId: cfg.tag_id,
          });
        }
      } catch (err) {
        // Non-fatal — log + advance. A tag-write failure shouldn't
        // strand the customer mid-flow.
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "set_tag_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "update_contact") {
      const cfg = node.config as unknown as UpdateContactNodeConfig;
      try {
        const written = await applyUpdateContact(db, run, cfg);
        pendingEvents.push(
          logEvent(db, run.id, "node_entered", node.node_key, {
            updated_fields: written.fields,
            note_added: written.note,
          }),
        );
      } catch (err) {
        // Non-fatal like set_tag: a CRM write failure must not strand
        // the customer mid-conversation.
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "update_contact_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "score_lead") {
      const cfg = node.config as unknown as ScoreLeadNodeConfig;
      const result = scoreLead(run.vars, cfg);
      try {
        await persistRunVars(db, run, {
          ...run.vars,
          [cfg.score_var]: result.score,
          [cfg.category_var]: result.category,
          [`${cfg.category_var}_reasons`]: result.reasons.join("; "),
        });
        pendingEvents.push(
          logEvent(db, run.id, "node_entered", node.node_key, {
            score: result.score,
            category: result.category,
            reasons: result.reasons,
          }),
        );
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "score_lead_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "send_buttons") {
      // Same failure contract as send_message / send_media /
      // collect_input above: log + fail the run. Previously an
      // exception here (Meta error, or meta-api's length validation —
      // now reachable via interpolation, see sendButtonsAndSuspend)
      // escaped to dispatchInboundToFlows' catch, which only
      // console.error'd and left the run active + stuck on the prior
      // node with nothing in flow_run_events.
      try {
        await sendButtonsAndSuspend(db, run, node);
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_buttons_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "send_buttons_failed");
        return { outcome: "completed" };
      }
      // Persist the new current_node_key via optimistic UPDATE.
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "send_list") {
      try {
        await sendListAndSuspend(db, run, node);
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_list_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "send_list_failed");
        return { outcome: "completed" };
      }
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "handoff") {
      await executeHandoff(db, run, node);
      return { outcome: "handed_off" };
    }
    if (node.node_type === "end") {
      await logEvent(db, run.id, "completed", node.node_key);
      await endRun(db, run.id, "completed", "end_node");
      return { outcome: "completed" };
    }
    // Unknown node type — shouldn't happen given the CHECK constraint.
    await logEvent(db, run.id, "error", node.node_key, {
      reason: `unknown_node_type:${node.node_type}`,
    });
    await endRun(db, run.id, "failed", "unknown_node_type");
    return { outcome: "completed" };
  }
  // Safety break — log + fail.
  await logEvent(db, run.id, "error", currentKey, {
    reason: "advance_loop_safety_break",
  });
  await endRun(db, run.id, "failed", "advance_loop_overflow");
  return { outcome: "completed" };
}

/**
 * Optimistic UPDATE — only advance current_node_key when it matches
 * the value we read at the top of dispatch. If another webhook beat
 * us, the row's pointer has already moved and our UPDATE returns
 * zero rows; we treat that as a no-op and let the other run continue.
 */
async function advanceCurrentNodeKey(
  db: AdminClient,
  runId: string,
  expectedOldKey: string | null,
  newKey: string,
): Promise<boolean> {
  // PostgREST: when expectedOldKey is null we can't `.eq` (would match
  // any row); use `.is('current_node_key', null)` instead.
  let q = db
    .from("flow_runs")
    .update({
      current_node_key: newKey,
      last_advanced_at: new Date().toISOString(),
    })
    .eq("id", runId)
    .eq("status", "active");
  if (expectedOldKey === null) {
    q = q.is("current_node_key", null);
  } else {
    q = q.eq("current_node_key", expectedOldKey);
  }
  const { data, error } = await q.select("id");
  if (error) {
    console.error("[flows] advanceCurrentNodeKey error:", error.message);
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

async function claimReplyTransition(
  db: AdminClient,
  run: FlowRunRow,
  nextNodeKey: string,
  extra: Record<string, unknown> = {},
): Promise<boolean> {
  const fromKey = run.current_node_key;
  if (fromKey === null) return false;
  const nextSeq = (run.transition_seq ?? 0) + 1;
  const { data, error } = await db
    .from("flow_runs")
    .update({
      ...extra,
      current_node_key: nextNodeKey,
      transition_seq: nextSeq,
      reprompt_count: 0,
      last_advanced_at: new Date().toISOString(),
    })
    .eq("id", run.id)
    .eq("status", "active")
    .eq("current_node_key", fromKey)
    .eq("transition_seq", run.transition_seq ?? 0)
    .select("id");
  if (error) {
    console.error("[flows] claimReplyTransition error:", error.message);
    return false;
  }
  if (!Array.isArray(data) || data.length !== 1) return false;
  run.current_node_key = nextNodeKey;
  run.transition_seq = nextSeq;
  run.reprompt_count = 0;
  return true;
}

async function closeActiveRun(
  db: AdminClient,
  run: FlowRunRow,
  closure: ActiveRunClosure,
  now: Date,
): Promise<void> {
  if (closure.kind === "timeout") {
    await markRunTimedOut(db, run.id, closure.check, "timed_out_on_reply", now);
    return;
  }
  await endRun(
    db,
    run.id,
    closure.kind === "cancel" ? "cancelled" : "failed",
    closure.reason,
  );
}

// ============================================================
// Public entry point — the webhook calls this on every inbound.
// ============================================================

interface ActiveRunReads {
  run: FlowRunRow | null;
  dupe: boolean;
  flow: FlowRow | null;
  nodes: Map<string, FlowNodeRow>;
}

/** Reads started before dispatch, for one contact and one inbound message. */
export interface ActiveRunPrefetch {
  accountId: string;
  contactId: string;
  metaMessageId: string;
  reads: Promise<ActiveRunReads>;
}

async function loadActiveRunReads(
  db: AdminClient,
  accountId: string,
  contactId: string,
  metaMessageId: string,
): Promise<ActiveRunReads> {
  const [run, runIds] = await Promise.all([
    loadActiveRunForContact(db, accountId, contactId),
    loadContactRunIds(db, accountId, contactId),
  ]);
  if (!run) return { run: null, dupe: false, flow: null, nodes: new Map() };
  // Idempotency only matters when a run exists; for new runs the
  // partial unique index catches duplicate starts at INSERT time. The
  // check is read-only, so the flow + node loads run alongside it and
  // are discarded on a duplicate.
  const [dupe, flow, nodes] = await Promise.all([
    isDuplicateInbound(db, metaMessageId, runIds),
    loadFlow(db, run.flow_id),
    loadAllNodes(db, run.flow_id),
  ]);
  return { run, dupe, flow, nodes };
}

/**
 * Starts the active-run reads for an inbound message as soon as the
 * contact is known, so they overlap the webhook's own persistence work
 * instead of following it. Read-only and scoped to this one message;
 * an outdated snapshot is harmless because every reply transition is a
 * conditional claim on `transition_seq`. When dispatch never runs (an
 * opted-out contact, a replayed delivery) the result is discarded.
 */
export function prefetchActiveRunReads(
  accountId: string,
  contactId: string,
  metaMessageId: string,
): ActiveRunPrefetch {
  const reads = loadActiveRunReads(supabaseAdmin(), accountId, contactId, metaMessageId);
  reads.catch(() => {});
  return { accountId, contactId, metaMessageId, reads };
}

/** The account's active flows, read before dispatch. */
export interface ActiveFlowsPrefetch {
  accountId: string;
  flows: Promise<FlowRow[] | null>;
}

/**
 * Starts the active-flows read as soon as the account is known, so the
 * entry-flow decision only waits for the first-inbound claim rather
 * than the claim followed by this read. Same freshness as reading it
 * after the claim: it is fetched while this message is being handled.
 */
export function prefetchActiveFlows(accountId: string): ActiveFlowsPrefetch {
  const flows = loadActiveFlows(supabaseAdmin(), accountId);
  flows.catch(() => {});
  return { accountId, flows };
}

export async function dispatchInboundToFlows(
  input: DispatchInboundInput & {
    /** May still be resolving; only the entry-flow lookup waits for it. */
    isFirstInboundMessage: boolean | Promise<boolean>;
    prefetch?: ActiveRunPrefetch;
    activeFlows?: ActiveFlowsPrefetch;
  },
): Promise<DispatchInboundResult> {
  const db = supabaseAdmin();
  markLatency("flow_dispatch_started");
  try {
    // The entry-flow lookup doesn't depend on the active run, so it is
    // issued alongside it; its result is only used when no run is active.
    // The flows read itself doesn't depend on the first-inbound claim
    // either — only the choice between them does.
    const activeFlows = input.testFlowId
      ? undefined
      : input.activeFlows?.accountId === input.accountId
        ? input.activeFlows.flows
        : loadActiveFlows(db, input.accountId);
    activeFlows?.catch(() => {});
    const entryFlowLookup = Promise.resolve(input.isFirstInboundMessage)
      .then((isFirst) =>
        findEntryFlow(
          db,
          input.accountId,
          input.message,
          isFirst,
          input.testFlowId,
          activeFlows,
        ),
      )
      .catch(() => null);
    const { prefetch } = input;
    const prefetched =
      prefetch &&
      prefetch.accountId === input.accountId &&
      prefetch.contactId === input.contactId &&
      prefetch.metaMessageId === input.message.meta_message_id
        ? await prefetch.reads.catch(() => null)
        : null;
    const {
      run: activeRun,
      dupe,
      flow: loadedRunFlow,
      nodes,
    } = prefetched ??
      (await loadActiveRunReads(
        db,
        input.accountId,
        input.contactId,
        input.message.meta_message_id,
      ));

    if (activeRun) {
      if (dupe) {
        return {
          consumed: true,
          flow_run_id: activeRun.id,
          outcome: "duplicate_inbound_ignored",
        };
      }
      const runFlow =
        loadedRunFlow && input.testFlowId === loadedRunFlow.id
          ? { ...loadedRunFlow, status: "active" as const }
          : loadedRunFlow;
      if (
        runFlow &&
        runFlow.status === "active" &&
        matchesRestartKeyword(input.message, runFlow.trigger_config)
      ) {
        await logEvent(db, activeRun.id, "reply_received", activeRun.current_node_key, {
          meta_message_id: input.message.meta_message_id,
          reply_kind: input.message.kind,
          restart: true,
        });
        await endRun(db, activeRun.id, "cancelled", "restarted_by_customer");
        if (!runFlow.entry_node_id) return { consumed: false, outcome: "no_match" };
        return startNewRun(db, runFlow, input, nodes);
      }
      const now = new Date();
      const closure = closureForActiveRun({
        run: activeRun,
        flow: runFlow,
        nodeKeys: nodes,
        now,
      });
      if (!closure) {
        return handleReplyForActiveRun(
          db,
          activeRun,
          runFlow!,
          input.message,
          nodes,
        );
      }
      await closeActiveRun(db, activeRun, closure, now);
    }

    // No active run → look for a flow whose entry trigger matches.
    const flow = await entryFlowLookup;
    if (!flow || !flow.entry_node_id) {
      return { consumed: false, outcome: "no_match" };
    }
    return startNewRun(db, flow, input, loadAllNodes(db, flow.id));
  } catch (err) {
    console.error(
      "[flows] dispatchInboundToFlows threw:",
      err instanceof Error ? err.message : err,
    );
    return { consumed: false, outcome: "no_match" };
  }
}

async function handleReplyForActiveRun(
  db: AdminClient,
  run: FlowRunRow,
  flow: FlowRow,
  message: ParsedInbound,
  nodes: Map<string, FlowNodeRow>,
): Promise<DispatchInboundResult> {
  // Note: we intentionally do NOT persist the raw customer text. A
  // `collect_input` prompt that asks "what's your card number?" would
  // otherwise leave the PAN sitting in flow_run_events.payload forever,
  // visible to anyone with access to the runs viewer or the events
  // table. Length is enough for "did they actually reply?" debugging;
  // for the captured value itself, the `node_entered` event already
  // records `captured_key` + `captured_length` after the var is stored.
  //
  // Issued without waiting: the transition claim below is what guards
  // against a concurrent second advance, not this audit row. Flushed
  // before returning.
  const pendingEvents: Promise<void>[] = [
    logEvent(db, run.id, "reply_received", run.current_node_key, {
      meta_message_id: message.meta_message_id,
      reply_kind: message.kind,
      reply_id: message.kind === "interactive_reply" ? message.reply_id : null,
      text_length: message.kind === "text" ? message.text.length : null,
    }),
  ];
  try {
    return await advanceActiveRunOnReply(db, run, flow, message, nodes, pendingEvents);
  } finally {
    await Promise.all(pendingEvents);
  }
}

async function advanceActiveRunOnReply(
  db: AdminClient,
  run: FlowRunRow,
  flow: FlowRow,
  message: ParsedInbound,
  nodes: Map<string, FlowNodeRow>,
  pendingEvents: Promise<void>[],
): Promise<DispatchInboundResult> {
  const currentNode = nodes.get(run.current_node_key!)!;

  // Two ways a reply can advance:
  //   1. Interactive button/list tap on a send_buttons/send_list node.
  //   2. Text reply on a collect_input node — capture into vars.
  //
  // Everything else falls through to the fallback policy below.
  let matched: string | null = null;
  let matchedVars: Record<string, unknown> | null = null;
  const capture = answerCaptureConfig(currentNode);
  if (
    message.kind === "interactive_reply" &&
    (currentNode.node_type === "send_buttons" ||
      currentNode.node_type === "send_list")
  ) {
    matched = matchReplyId(currentNode, message.reply_id);
    if (matched) markLatency("button_id_resolved");
    if (matched && capture.save_as) {
      matchedVars = {
        ...run.vars,
        [capture.save_as]: message.reply_id,
        [`${capture.save_as}_label`]: message.reply_title,
      };
    }
  } else if (
    message.kind === "text" &&
    capture.text_reply_next &&
    message.text.trim().length > 0
  ) {
    const captured = message.text.trim().slice(0, MAX_CAPTURED_TEXT_LENGTH);
    matched = capture.text_reply_next;
    if (capture.save_as) {
      matchedVars = {
        ...run.vars,
        [capture.save_as]: captured,
        [`${capture.save_as}_label`]: captured,
      };
    }
  } else if (
    message.kind === "text" &&
    currentNode.node_type === "collect_input"
  ) {
    const cfg = currentNode.config as unknown as CollectInputNodeConfig;
    const captured = message.text.trim();
    if (captured.length > 0 && cfg.var_key && cfg.next_node_key) {
      const newVars = { ...run.vars, [cfg.var_key]: captured };
      if (!(await claimReplyTransition(db, run, cfg.next_node_key, { vars: newVars }))) {
        return lostReplyRace(db, run, currentNode.node_key);
      }
      run.vars = newVars;
      await logEvent(db, run.id, "node_entered", currentNode.node_key, {
        captured_key: cfg.var_key,
        captured_length: captured.length,
      });
      const outcome = await advanceFromNodeKey(db, run, cfg.next_node_key, nodes);
      return { consumed: true, flow_run_id: run.id, outcome: outcome.outcome };
    }
  }

  if (matched) {
    const extra = matchedVars ? { vars: matchedVars } : {};
    if (!(await claimReplyTransition(db, run, matched, extra))) {
      return lostReplyRace(db, run, currentNode.node_key);
    }
    markLatency("flow_step_selected");
    if (matchedVars) {
      run.vars = matchedVars;
      pendingEvents.push(
        logEvent(db, run.id, "node_entered", currentNode.node_key, {
          captured_key: capture.save_as,
        }),
      );
    }
    const outcome = await advanceFromNodeKey(db, run, matched, nodes);
    return {
      consumed: true,
      flow_run_id: run.id,
      outcome: outcome.outcome,
    };
  }

  // No match → fallback. Apply the policy.
  const policy = resolveFallbackPolicy(flow.fallback_policy);
  const newReprompts = run.reprompt_count + 1;
  const action = decideFallback({ policy, reprompt_count: newReprompts });
  // Independent writes: one round trip instead of two, both still
  // persisted before any re-prompt is sent.
  await Promise.all([
    db.from("flow_runs").update({ reprompt_count: newReprompts }).eq("id", run.id),
    logEvent(db, run.id, "fallback_fired", run.current_node_key, {
      action: action.type,
      reprompt_count: newReprompts,
    }),
  ]);
  if (action.type === "ignore") {
    // Don't consume — let automations have a shot at it.
    return { consumed: false, flow_run_id: run.id, outcome: "no_match" };
  }
  if (action.type === "reprompt") {
    // Re-send the same prompt. Same node, no current_node_key change.
    // The interactive helpers interpolate run.vars themselves, so a
    // reprompt renders the same text the original prompt did. A send
    // failure here is logged but does not end the run — the customer
    // still has the original prompt on screen and can retry.
    try {
      if (currentNode.node_type === "send_buttons") {
        await sendButtonsAndSuspend(db, run, currentNode);
      } else if (currentNode.node_type === "send_list") {
        await sendListAndSuspend(db, run, currentNode);
      } else if (currentNode.node_type === "collect_input") {
        // Customer typed something we couldn't accept (empty after trim,
        // or var_key missing — rare). Re-send the prompt so they try again.
        const cfg = currentNode.config as unknown as CollectInputNodeConfig;
        await engineSendText({
          accountId: run.account_id,
          userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.prompt_text, run.vars),
        });
      }
    } catch (err) {
      await logEvent(db, run.id, "error", currentNode.node_key, {
        reason: "reprompt_send_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    return { consumed: true, flow_run_id: run.id, outcome: "fallback_fired" };
  }
  if (action.type === "handoff") {
    if (run.conversation_id) {
      await db
        .from("conversations")
        .update({ status: "pending", updated_at: new Date().toISOString() })
        .eq("id", run.conversation_id);
    }
    await logEvent(db, run.id, "handoff", run.current_node_key, {
      reason: "fallback_exhausted",
    });
    await endRun(db, run.id, "handed_off", "fallback_exhausted");
    return { consumed: true, flow_run_id: run.id, outcome: "handed_off" };
  }
  // action.type === 'end'
  await endRun(db, run.id, "completed", "fallback_exhausted_end");
  return { consumed: true, flow_run_id: run.id, outcome: "completed" };
}

async function lostReplyRace(
  db: AdminClient,
  run: FlowRunRow,
  nodeKey: string,
): Promise<DispatchInboundResult> {
  await logEvent(db, run.id, "error", nodeKey, {
    reason: "lost_race_during_reply",
  });
  return {
    consumed: true,
    flow_run_id: run.id,
    outcome: "duplicate_inbound_ignored",
  };
}

async function startNewRun(
  db: AdminClient,
  flow: FlowRow,
  input: DispatchInboundInput,
  nodesOrLoad: Map<string, FlowNodeRow> | Promise<Map<string, FlowNodeRow>>,
): Promise<DispatchInboundResult> {
  // INSERT — partial unique index `idx_one_active_run_per_contact`
  // catches concurrent inserts with 23505. We catch and return as
  // consumed:true (the parallel webhook handles it). A node load the
  // caller started is awaited alongside it.
  const [{ data: inserted, error: insErr }, nodes] = await Promise.all([
    insertRun(db, flow, input),
    nodesOrLoad,
  ]);
  if (insErr) {
    // 23505 = unique_violation → another webhook is starting the run.
    const msg = insErr.message ?? "";
    if (msg.includes("23505") || msg.includes("duplicate key")) {
      return { consumed: true, outcome: "duplicate_inbound_ignored" };
    }
    console.error("[flows] startNewRun insert error:", insErr.message);
    return { consumed: false, outcome: "no_match" };
  }
  return advanceNewRun(db, flow, input, inserted as FlowRunRow, nodes);
}

function insertRun(db: AdminClient, flow: FlowRow, input: DispatchInboundInput) {
  return db
    .from("flow_runs")
    .insert({
      flow_id: flow.id,
      // Tenancy: NOT NULL post-017. The partial unique index
      // `idx_one_active_run_per_contact` is over (account_id,
      // contact_id) WHERE status='active', so two accounts sharing
      // a contact phone number each run their own flows independently.
      account_id: flow.account_id,
      // Audit: preserves the flow's author on the run row for log
      // attribution.
      user_id: flow.user_id,
      contact_id: input.contactId,
      conversation_id: input.conversationId,
      status: "active",
      current_node_key: flow.entry_node_id,
    })
    .select("*")
    .maybeSingle();
}

async function advanceNewRun(
  db: AdminClient,
  flow: FlowRow,
  input: DispatchInboundInput,
  run: FlowRunRow,
  nodes: Map<string, FlowNodeRow>,
): Promise<DispatchInboundResult> {
  markLatency("flow_run_started");
  // The audit row and the counter don't gate the first reply, so they
  // run alongside the advance loop and are awaited after it.
  const startBookkeeping = Promise.all([
    logEvent(db, run.id, "started", flow.entry_node_id, {
      flow_id: flow.id,
      trigger_type: flow.trigger_type,
      meta_message_id: input.message.meta_message_id,
      ...(input.testFlowId ? { test_run: true } : {}),
    }),
    // Bump the flow's execution counter — used by the builder UI to
    // surface "X runs since activation" on the flow card.
    //
    // Atomic RPC (migration 012) rather than read-modify-write: two
    // concurrent webhooks starting runs for different contacts on the
    // same flow would otherwise both read N and both write N+1, losing
    // a count. Mirrors the automations engine's use of
    // `increment_automation_execution_count` (migration 007).
    (input.testFlowId
      ? Promise.resolve({ error: null })
      : db.rpc("increment_flow_execution_count", { p_flow_id: flow.id })
    ).then(({ error: incErr }: { error: { message: string } | null }) => {
      if (incErr) {
        // Non-fatal — the run itself succeeded; only the counter is off.
        console.error("[flows] execution_count rpc error:", incErr.message);
      }
    }),
  ]);

  // Run the advance loop starting from the entry node.
  let outcome: Awaited<ReturnType<typeof advanceFromNodeKey>>;
  try {
    outcome = await advanceFromNodeKey(db, run, flow.entry_node_id!, nodes);
  } finally {
    await startBookkeeping;
  }
  return {
    consumed: true,
    flow_run_id: run.id,
    outcome: outcome.outcome === "advanced" ? "started" : outcome.outcome,
  };
}
