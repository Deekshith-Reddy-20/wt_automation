import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeTables } from "@/lib/flows/fake-db.test-helper";

// ============================================================
// Runs the generated Suraj Solar flow through the real Flows engine
// (`dispatchInboundToFlows`) against an in-memory Supabase, with the
// WhatsApp senders replaced by recorders. Proves the journey end to
// end at the engine level: trigger, language routing, answer capture,
// idempotency, resume, restart, scoring, CRM writes and handoff.
// ============================================================

type Sent = { kind: "text" | "buttons" | "list"; body: string; options: string[] };

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  sent: [] as Sent[],
  counter: 0,
}));

vi.mock("@/lib/flows/admin-client", async () => {
  const { createFakeDb } = await import("@/lib/flows/fake-db.test-helper");
  return { supabaseAdmin: () => createFakeDb(h.tables as FakeTables) };
});

vi.mock("@/lib/flows/meta-send", () => {
  const id = () => ({ whatsapp_message_id: `wamid.out.${++h.counter}` });
  return {
    engineSendText: vi.fn(async (a: { text: string }) => {
      h.sent.push({ kind: "text", body: a.text, options: [] });
      return id();
    }),
    engineSendMedia: vi.fn(async () => id()),
    engineSendInteractiveButtons: vi.fn(async (a: { bodyText: string; buttons: Array<{ id: string }> }) => {
      h.sent.push({ kind: "buttons", body: a.bodyText, options: a.buttons.map((b) => b.id) });
      return id();
    }),
    engineSendInteractiveList: vi.fn(
      async (a: { bodyText: string; sections: Array<{ rows: Array<{ id: string }> }> }) => {
        h.sent.push({ kind: "list", body: a.bodyText, options: a.sections.flatMap((s) => s.rows.map((r) => r.id)) });
        return id();
      },
    ),
  };
});

vi.mock("@/lib/automations/engine", () => ({
  runAutomationsForTrigger: vi.fn(async () => undefined),
}));

import { dispatchInboundToFlows } from "@/lib/flows/engine";
import type { ParsedInbound } from "@/lib/flows/types";
import {
  CATEGORIES,
  CATEGORY_QUESTIONS,
  LANGS,
  LEAD_FLOW_CUSTOM_FIELDS,
  LEAD_FLOW_TAGS,
  MESSAGES,
  NAME_QUESTION,
  TALK_TO_SALES,
  languageReplyId,
  WELCOME_TEXT,
  buildLeadFlow,
} from "./lead-flow";

const CONTACT = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const TAG_NEW = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const TAG_HOT = "9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f";
const FIELD_IDS = Object.fromEntries(LEAD_FLOW_CUSTOM_FIELDS.map(([name], i) => [name, `cf-${i}`]));
const fieldId = (name: string) => FIELD_IDS[name];

function setup(opts: { contactName?: string | null } = {}) {
  const def = buildLeadFlow({
    fields: FIELD_IDS,
    tags: { [LEAD_FLOW_TAGS.newEnquiry]: TAG_NEW, [LEAD_FLOW_TAGS.hot]: TAG_HOT },
  });
  h.sent = [];
  h.tables = {
    flows: [
      {
        id: "flow-suraj",
        account_id: "acct-1",
        user_id: "owner-1",
        name: def.name,
        status: "active",
        trigger_type: def.trigger_type,
        trigger_config: def.trigger_config,
        entry_node_id: def.entry_node_id,
        fallback_policy: def.fallback_policy,
        execution_count: 0,
        created_at: "2026-10-01T00:00:00Z",
      },
    ],
    flow_nodes: def.nodes.map((n, i) => ({ id: `node-${i}`, flow_id: "flow-suraj", ...n })),
    flow_runs: [],
    flow_run_events: [],
    messages: [],
    contacts: [{ id: CONTACT, account_id: "acct-1", name: opts.contactName === undefined ? "Ravi" : opts.contactName }],
    conversations: [{ id: "cv-1", account_id: "acct-1", contact_id: CONTACT, status: "open", assigned_agent_id: null, created_at: "2026-10-17T00:00:00Z" }],
    custom_fields: Object.values(FIELD_IDS).map((id) => ({ id, account_id: "acct-1" })),
    contact_custom_values: [],
    contact_notes: [],
    contact_tags: [],
    tags: [
      { id: TAG_NEW, account_id: "acct-1" },
      { id: TAG_HOT, account_id: "acct-1" },
    ],
    profiles: [{ user_id: "agent-1", account_id: "acct-1", account_role: "agent" }],
  };
}

let seq = 0;
type InboundInput = ParsedInbound extends infer M
  ? M extends ParsedInbound
    ? Omit<M, "meta_message_id"> & { meta_message_id?: string }
    : never
  : never;
function send(message: InboundInput, first = false) {
  return dispatchInboundToFlows({
    accountId: "acct-1",
    userId: "owner-1",
    contactId: CONTACT,
    conversationId: "cv-1",
    message: { meta_message_id: `wamid.in.${++seq}`, ...message } as ParsedInbound,
    isFirstInboundMessage: first,
  });
}
const text = (t: string, first = false) => send({ kind: "text", text: t }, first);
const tap = (id: string) => send({ kind: "interactive_reply", reply_id: id, reply_title: id });
const lastSent = () => h.sent.at(-1)!;
const run = () => h.tables.flow_runs.at(-1)!;
const runVars = () => run().vars as Record<string, unknown>;
const customValue = (name: string) =>
  h.tables.contact_custom_values.find((r) => r.custom_field_id === fieldId(name))?.value;

beforeEach(() => setup());

describe("Suraj Solar flow on the real engine — trigger", () => {
  it("starts on the first inbound message, whatever the text", async () => {
    const result = await text("Do you install solar in Guntur?", true);
    expect(result).toMatchObject({ consumed: true, outcome: "started" });
    expect(h.sent).toHaveLength(1);
    expect(lastSent()).toEqual({
      kind: "buttons",
      body: WELCOME_TEXT,
      options: ["lang_te", "lang_en", "lang_hi"],
    });
  });

  it("does not greet on a later message of an existing conversation", async () => {
    const result = await text("hello", false);
    expect(result).toEqual({ consumed: false, outcome: "no_match" });
    expect(h.sent).toEqual([]);
  });

  it("ignores a webhook retry of the same message id", async () => {
    await send({ kind: "text", text: "hi", meta_message_id: "wamid.dup" }, true);
    await tap("lang_en");
    const before = h.sent.length;
    const replay = await send({ kind: "interactive_reply", reply_id: "lang_en", reply_title: "English", meta_message_id: `wamid.in.${seq}` });
    expect(replay.outcome).toBe("duplicate_inbound_ignored");
    expect(h.sent).toHaveLength(before);
    expect(h.tables.flow_runs.filter((r) => r.status === "active")).toHaveLength(1);
  });

  it("re-prompts instead of guessing when the language reply is typed", async () => {
    await text("hi", true);
    const result = await text("Telugu please");
    expect(result.outcome).toBe("fallback_fired");
    expect(run().current_node_key).toBe("welcome");
  });
});

describe("Suraj Solar flow on the real engine — journeys", () => {
  it("completes a Telugu residential journey and writes the lead to the CRM", async () => {
    await text("namaskaram", true);
    await tap("lang_te");
    expect(lastSent().body).toBe(MESSAGES.categoryPrompt.te);
    await tap("solar_residential");
    const res = CATEGORY_QUESTIONS.solar_residential;
    expect(lastSent().body).toBe(res[0].text.te);
    await tap("res_prop_house");
    await tap("res_bill_gt_15000");
    expect(lastSent().body).toBe(res[2].text.te);
    await text("Vijayawada");
    await tap("res_roof_rcc");
    await tap("timeline_1m");
    expect(lastSent().body).toBe(MESSAGES.confirmation.te);
    await tap("callback_yes");

    expect(lastSent()).toEqual({ kind: "text", body: MESSAGES.finalCallback.te, options: [] });
    expect(run()).toMatchObject({ status: "handed_off" });
    expect(run().vars).toMatchObject({
      language: "lang_te",
      solar_category: "solar_residential",
      city: "Vijayawada",
      lead_score: 85,
      lead_priority: "HOT",
    });

    expect(customValue("Preferred language")).toBe("Telugu");
    expect(customValue("Solar requirement")).toBe("Residential rooftop");
    expect(customValue("Property type")).toBe("Independent house");
    expect(customValue("Electricity bill amount")).toBe("Above ₹15,000");
    expect(customValue("Location")).toBe("Vijayawada");
    expect(customValue("Installation timeline")).toBe("Within 1 month");
    expect(customValue("Lead priority")).toBe("HOT");
    expect(customValue("Lead score")).toBe("85");
    expect(customValue("Callback preference")).toBe("Yes, call me");
    expect(customValue("Lead source")).toBe("WhatsApp");
    expect(customValue("Follow-up date")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(customValue("Preferred callback time")).toBeUndefined();

    const note = String(h.tables.contact_notes[0]?.note_text);
    expect(note).toContain("Location: Vijayawada");
    expect(note).toContain("Priority: HOT (85 points)");
    expect(note).not.toContain("Pump capacity");

    expect(h.tables.flow_run_events.filter((e) => e.event_type === "error")).toEqual([]);
    expect(h.tables.contact_tags.map((t) => t.tag_id).sort()).toEqual([TAG_HOT, TAG_NEW].sort());
    expect(h.tables.conversations[0]).toMatchObject({ status: "pending", assigned_agent_id: "agent-1" });
  });

  it("runs the Hindi pump path with a chosen callback time", async () => {
    await text("hello", true);
    await tap("lang_hi");
    expect(lastSent().body).toBe(MESSAGES.categoryPrompt.hi);
    await tap("solar_pump");
    for (const q of CATEGORY_QUESTIONS.solar_pump) {
      expect(lastSent().body).toBe(q.text.hi);
      await tap(lastSent().options[0]);
    }
    await tap("callback_choose_time");
    expect(lastSent().body).toBe(MESSAGES.callbackTimePrompt.hi);
    await tap("callback_evening");
    expect(lastSent().body).toBe(MESSAGES.finalCallback.hi);
    expect(customValue("Preferred callback time")).toBe("Evening (4pm–7pm)");
    expect(customValue("Location")).toBeUndefined();
  });

  it("hands a 'talk to sales' request straight to the sales queue without qualifying", async () => {
    await text("hi", true);
    await tap("lang_en");
    expect(lastSent().options).toContain("solar_talk_sales");
    await tap("solar_talk_sales");

    expect(lastSent()).toEqual({ kind: "text", body: TALK_TO_SALES.reply.en, options: [] });
    expect(run()).toMatchObject({ status: "handed_off" });
    expect(customValue("Solar requirement")).toBe("Talk to sales team");
    expect(customValue("Preferred language")).toBe("English");
    expect(customValue("Lead score")).toBeUndefined();
    expect(String(h.tables.contact_notes[0]?.note_text)).toContain("talk to the sales team");
    expect(h.tables.conversations[0]).toMatchObject({ status: "pending", assigned_agent_id: "agent-1" });
  });

  it("asks an unnamed English contact for their name and saves it", async () => {
    setup({ contactName: null });
    await text("hi", true);
    await tap("lang_en");
    await tap("solar_battery");
    for (const _ of CATEGORY_QUESTIONS.solar_battery) await tap(lastSent().options[0]);
    expect(lastSent().body).toBe(NAME_QUESTION.text.en);
    await text("Sita Devi");
    expect(lastSent().body).toBe(MESSAGES.confirmation.en);
    await tap("callback_not_now");
    expect(lastSent().body).toBe(MESSAGES.finalNotNow.en);
    expect(h.tables.contacts[0].name).toBe("Sita Devi");
    expect(customValue("Callback preference")).toBe("Not now");
  });

  it("resumes from the saved step, using only database state", async () => {
    await text("hi", true);
    await tap("lang_en");
    await tap("solar_commercial");
    await tap("com_biz_factory");
    // Nothing is held in memory between dispatches: the next reply is
    // matched against flow_runs.current_node_key loaded from the DB.
    expect(run().current_node_key).toBe("en_com_2");
    await tap("com_bill_gt_500000");
    expect(run().current_node_key).toBe("en_com_3");
    expect(run().vars).toMatchObject({ com_business: "com_biz_factory", com_bill: "com_bill_gt_500000" });
  });

  it("restarts from the welcome step on a restart keyword", async () => {
    await text("hi", true);
    await tap("lang_en");
    await tap("solar_society");
    const result = await text("Menu");
    expect(result.consumed).toBe(true);
    expect(h.tables.flow_runs[0]).toMatchObject({ status: "cancelled", end_reason: "restarted_by_customer" });
    expect(run()).toMatchObject({ status: "active", current_node_key: "welcome" });
    expect(lastSent().body).toBe(WELCOME_TEXT);
  });
});

describe("Suraj Solar flow on the real engine — language buttons", () => {
  const welcomes = () => h.sent.filter((s) => s.body === WELCOME_TEXT).length;

  for (const lang of LANGS) {
    for (const cat of CATEGORIES) {
      it(`${lang}: language tap then ${cat.id} continues in ${lang} without restarting`, async () => {
        setup();
        await text("hi", true);
        await tap(languageReplyId(lang));
        expect(lastSent()).toMatchObject({ kind: "list", body: MESSAGES.categoryPrompt[lang] });
        expect(run().vars).toMatchObject({ language: languageReplyId(lang) });
        await tap(cat.id);
        expect(lastSent().body).toBe(CATEGORY_QUESTIONS[cat.id][0].text[lang]);
        expect(run()).toMatchObject({ status: "active", current_node_key: `${lang}_${cat.short}_1` });
        expect(run().vars).toMatchObject({ language: languageReplyId(lang), solar_category: cat.id });
        expect(welcomes()).toBe(1);
      });
    }

    it(`${lang}: completes the whole journey in ${lang} and hands off`, async () => {
      setup();
      await text("hi", true);
      await tap(languageReplyId(lang));
      await tap("solar_residential");
      for (const q of CATEGORY_QUESTIONS.solar_residential) {
        expect(lastSent().body).toBe(q.text[lang]);
        await tap(lastSent().options[0]);
      }
      expect(lastSent().body).toBe(MESSAGES.confirmation[lang]);
      await tap("callback_yes");
      expect(lastSent()).toEqual({ kind: "text", body: MESSAGES.finalCallback[lang], options: [] });
      expect(run()).toMatchObject({ status: "handed_off" });
      expect(customValue("Preferred language")).toBe({ te: "Telugu", en: "English", hi: "Hindi" }[lang]);
      expect(welcomes()).toBe(1);
    });
  }

  it("handles an unknown button id safely: re-shows the menu and leaves no language saved", async () => {
    await text("hi", true);
    const sentBefore = h.sent.length;
    const result = await tap("lang_xx");
    expect(result.outcome).toBe("fallback_fired");
    expect(h.sent).toHaveLength(sentBefore + 1);
    expect(lastSent()).toEqual({ kind: "buttons", body: WELCOME_TEXT, options: ["lang_te", "lang_en", "lang_hi"] });
    expect(run()).toMatchObject({ status: "active", current_node_key: "welcome" });
    expect(runVars().language).toBeUndefined();
    await tap("lang_hi");
    expect(lastSent().body).toBe(MESSAGES.categoryPrompt.hi);
  });

  it("treats a tap on an old-style language button (language_te) as unknown, not as a language", async () => {
    await text("hi", true);
    expect((await tap("language_te")).outcome).toBe("fallback_fired");
    expect(runVars().language).toBeUndefined();
    expect(lastSent().body).toBe(WELCOME_TEXT);
  });

  it("keeps the existing retry limit: hands off after repeated unknown ids", async () => {
    await text("hi", true);
    await tap("bogus_1");
    await tap("bogus_2");
    const result = await tap("bogus_3");
    expect(result.outcome).toBe("handed_off");
    expect(run()).toMatchObject({ status: "handed_off", end_reason: "fallback_exhausted" });
  });

  it("ignores an unknown category id without saving it", async () => {
    await text("hi", true);
    await tap("lang_en");
    expect((await tap("solar_unknown")).outcome).toBe("fallback_fired");
    expect(run()).toMatchObject({ current_node_key: "en_category" });
    expect(runVars().solar_category).toBeUndefined();
    expect(lastSent().body).toBe(MESSAGES.categoryPrompt.en);
  });

  it("sends nothing extra when Meta redelivers a category tap", async () => {
    await text("hi", true);
    await tap("lang_te");
    await send({ kind: "interactive_reply", reply_id: "solar_pump", reply_title: "x", meta_message_id: "wamid.cat" });
    const before = h.sent.length;
    const replay = await send({ kind: "interactive_reply", reply_id: "solar_pump", reply_title: "x", meta_message_id: "wamid.cat" });
    expect(replay.outcome).toBe("duplicate_inbound_ignored");
    expect(h.sent).toHaveLength(before);
    expect(run().current_node_key).toBe("te_pump_1");
  });

  it("sends nothing while the flow is a draft", async () => {
    h.tables.flows[0].status = "draft";
    const result = await text("hi", true);
    expect(result.consumed).toBe(false);
    expect(h.sent).toEqual([]);
    expect(h.tables.flow_runs).toEqual([]);
    expect((await tap("lang_en")).consumed).toBe(false);
    expect(h.sent).toEqual([]);
  });
});
