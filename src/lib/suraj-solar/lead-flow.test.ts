import { describe, expect, it } from "vitest";

import { resolveContactFieldValue, scoreLead } from "@/lib/flows/engine";
import type { ScoreLeadNodeConfig } from "@/lib/flows/types";
import { validateFlowForActivation } from "@/lib/flows/validate";
import { INTERACTIVE_LIMITS } from "@/lib/whatsapp/meta-api";
import {
  CALLBACK_CONSENT,
  CALLBACK_TIME,
  CATEGORIES,
  CATEGORY_QUESTIONS,
  NAME_QUESTION,
  TALK_TO_SALES,
  type L10n,
  LANGS,
  LANGUAGE_OPTIONS,
  LEAD_FLOW_CUSTOM_FIELDS,
  LEAD_FLOW_NAME,
  LEAD_FLOW_TAGS,
  MESSAGES,
  RESTART_KEYWORDS,
  WELCOME_TEXT,
  buildLeadFlow,
  crmValueMap,
  type CategoryId,
  type Lang,
  type LeadFlowNode,
} from "./lead-flow";

const ids = {
  fields: Object.fromEntries(LEAD_FLOW_CUSTOM_FIELDS.map(([name], i) => [name, `field-${i}`])),
  tags: { [LEAD_FLOW_TAGS.newEnquiry]: "tag-new", [LEAD_FLOW_TAGS.hot]: "tag-hot" },
};
const flow = buildLeadFlow(ids);
const byKey = new Map(flow.nodes.map((n) => [n.node_key, n]));

type WalkConfig = Partial<ScoreLeadNodeConfig> & {
  next_node_key?: string;
  text?: string;
  save_as?: string;
  text_reply_next?: string;
  subject?: string;
  subject_key?: string;
  operator?: string;
  value?: string;
  true_next?: string;
  false_next?: string;
};
type Row = { reply_id: string; title: string; description?: string; next_node_key: string };
type Btn = { reply_id: string; title: string; next_node_key: string };

function options(node: LeadFlowNode): Array<Btn | Row> {
  const cfg = node.config as { buttons?: Btn[]; sections?: Array<{ rows: Row[] }> };
  return node.node_type === "send_buttons"
    ? (cfg.buttons ?? [])
    : (cfg.sections ?? []).flatMap((s) => s.rows);
}

/**
 * Walks the generated graph the way the engine does: taps pick an
 * option by reply id, typed answers follow text_reply_next, conditions
 * read run vars / the contact name, score_lead uses the real scorer.
 */
function walk(answers: (node: LeadFlowNode) => string, opts: { hasName?: boolean } = {}) {
  const vars: Record<string, unknown> = {};
  const sent: Array<{ key: string; text: string; type: string }> = [];
  let key: string | undefined = flow.entry_node_id;
  for (let steps = 0; key && steps < 200; steps++) {
    const node = byKey.get(key);
    if (!node) throw new Error(`dangling edge to ${key}`);
    const cfg = node.config as WalkConfig;
    switch (node.node_type) {
      case "start":
      case "update_contact":
      case "set_tag":
        key = cfg.next_node_key;
        break;
      case "send_message":
        sent.push({ key: node.node_key, text: cfg.text ?? "", type: node.node_type });
        key = cfg.next_node_key;
        break;
      case "send_buttons":
      case "send_list": {
        sent.push({ key: node.node_key, text: cfg.text ?? "", type: node.node_type });
        const answer = answers(node);
        const picked = options(node).find((o) => o.reply_id === answer);
        if (picked) {
          if (cfg.save_as) {
            vars[cfg.save_as] = picked.reply_id;
            vars[`${cfg.save_as}_label`] = picked.title;
          }
          key = picked.next_node_key;
        } else {
          if (typeof cfg.text_reply_next !== "string") throw new Error(`typed reply not accepted at ${node.node_key}`);
          vars[cfg.save_as!] = answer;
          vars[`${cfg.save_as}_label`] = answer;
          key = cfg.text_reply_next;
        }
        break;
      }
      case "condition": {
        const value =
          cfg.subject === "contact_field" ? (opts.hasName ? "Ravi" : undefined) : (vars[cfg.subject_key!] as string | undefined);
        const ok =
          cfg.operator === "present" ? Boolean(value) : cfg.operator === "equals" ? value === cfg.value : false;
        key = ok ? cfg.true_next : cfg.false_next;
        break;
      }
      case "score_lead": {
        const r = scoreLead(vars, cfg as ScoreLeadNodeConfig);
        vars[cfg.score_var!] = r.score;
        vars[cfg.category_var!] = r.category;
        vars[`${cfg.category_var}_reasons`] = r.reasons.join("; ");
        key = cfg.next_node_key;
        break;
      }
      case "handoff":
        return { vars, sent, ended: node.node_key };
      default:
        throw new Error(`unexpected node type ${node.node_type}`);
    }
  }
  throw new Error("walk did not reach a handoff");
}

const languageId = (lang: Lang) => LANGUAGE_OPTIONS.find((l) => l.lang === lang)!.id;

/** Picks language + category, then the first option everywhere else. */
const firstOptionAnswers =
  (lang: Lang, category: CategoryId, overrides: Record<string, string> = {}) =>
  (node: LeadFlowNode) => {
    if (node.node_key === "welcome") return languageId(lang);
    if (node.node_key.endsWith("_category")) return category;
    const saveAs = (node.config as { save_as?: string }).save_as ?? "";
    if (overrides[saveAs] !== undefined) return overrides[saveAs];
    return options(node)[0].reply_id;
  };

describe("Suraj Solar lead flow — definition", () => {
  it("uses the exact welcome text and language buttons", () => {
    const welcome = byKey.get("welcome")!;
    expect(welcome.config.text).toBe(WELCOME_TEXT);
    expect(options(welcome).map((o) => [o.reply_id, o.title])).toEqual([
      ["lang_te", "తెలుగు"],
      ["lang_en", "English"],
      ["lang_hi", "हिंदी"],
    ]);
    expect(welcome.config.save_as).toBe("language");
  });

  it("shows the language menu as Telugu, English, Hindi and routes each id to its own branch", () => {
    expect(LANGS).toEqual(["te", "en", "hi"]);
    expect(LANGUAGE_OPTIONS.map((l) => l.lang)).toEqual(["te", "en", "hi"]);
    expect(WELCOME_TEXT).toBe(
      "Hi! 👋 Welcome to Suraj Solar.\n\nWe can help you choose the right solar solution for your home, business or farm.\n\nPlease select your preferred language to continue.",
    );
    const routes = Object.fromEntries(
      (byKey.get("welcome")!.config.buttons as Array<{ reply_id: string; next_node_key: string }>).map((b) => [b.reply_id, b.next_node_key]),
    );
    expect(routes).toEqual({ lang_te: "te_category", lang_en: "en_category", lang_hi: "hi_category" });
    expect(byKey.get("lang_te_check")!.config.value).toBe("lang_te");
    expect(byKey.get("lang_hi_check")!.config.value).toBe("lang_hi");
    expect(crmValueMap("language")).toEqual({ lang_te: "Telugu", lang_en: "English", lang_hi: "Hindi" });
  });

  it("has every message in all three languages, written in the right script", () => {
    const TELUGU = /[\u0C00-\u0C7F]/;
    const DEVANAGARI = /[\u0900-\u097F]/;
    const strings: Array<[string, L10n]> = [
      ...Object.entries(MESSAGES).map(([k, v]) => [`MESSAGES.${k}`, v] as [string, L10n]),
      ...CATEGORIES.flatMap((c) => [[`${c.id}.title`, c.title], [`${c.id}.description`, c.description]] as Array<[string, L10n]>),
      [`talk_sales.title`, TALK_TO_SALES.title],
      [`talk_sales.description`, TALK_TO_SALES.description],
      [`talk_sales.reply`, TALK_TO_SALES.reply],
      ...[...Object.values(CATEGORY_QUESTIONS).flat(), NAME_QUESTION, CALLBACK_CONSENT, CALLBACK_TIME].flatMap((q) => [
        [`${q.key}.text`, q.text] as [string, L10n],
        ...q.options.map((o) => [`${q.key}.${o.id}`, o.title] as [string, L10n]),
      ]),
    ];
    for (const [ctx, l10n] of strings) {
      for (const lang of LANGS) expect(l10n[lang]?.trim(), `${ctx}.${lang}`).toBeTruthy();
      // Purely numeric labels (₹ ranges, HP, home counts) are the same in every language.
      if (/^[\d₹.,–+\s()HPEV-]+$/.test(l10n.en)) continue;
      expect(TELUGU.test(l10n.te), `${ctx}.te`).toBe(true);
      expect(DEVANAGARI.test(l10n.hi), `${ctx}.hi`).toBe(true);
      expect(TELUGU.test(l10n.en) || DEVANAGARI.test(l10n.en), `${ctx}.en`).toBe(false);
    }
  });

  it("never promises subsidy, savings, eligibility, financing or dates", () => {
    const all = JSON.stringify(flow.nodes.map((n) => n.config));
    expect(all).not.toMatch(/guarantee|free|assured|you will save|eligible|approved|loan|subsidy/i);
  });

  it("triggers on the first inbound message with restart keywords", () => {
    expect(flow.name).toBe(LEAD_FLOW_NAME);
    expect(flow.trigger_type).toBe("first_inbound_message");
    expect(flow.trigger_config.restart_keywords).toEqual(RESTART_KEYWORDS);
    expect(RESTART_KEYWORDS).not.toContain("hi");
  });

  it("passes the activation validator with no errors or warnings", () => {
    const issues = validateFlowForActivation(
      { name: flow.name, trigger_type: flow.trigger_type, trigger_config: flow.trigger_config, entry_node_id: flow.entry_node_id },
      flow.nodes,
    );
    expect(issues).toEqual([]);
  });

  it("respects Meta interactive-message limits on every node", () => {
    for (const node of flow.nodes) {
      if (node.node_type !== "send_buttons" && node.node_type !== "send_list") continue;
      const cfg = node.config as { text: string; footer_text?: string; button_label?: string };
      const ctx = node.node_key;
      expect(cfg.text.length, ctx).toBeLessThanOrEqual(INTERACTIVE_LIMITS.bodyMaxLength);
      if (cfg.footer_text) expect(cfg.footer_text.length, ctx).toBeLessThanOrEqual(INTERACTIVE_LIMITS.footerMaxLength);
      const opts = options(node);
      expect(new Set(opts.map((o) => o.reply_id)).size, ctx).toBe(opts.length);
      if (node.node_type === "send_buttons") {
        expect(opts.length, ctx).toBeGreaterThanOrEqual(1);
        expect(opts.length, ctx).toBeLessThanOrEqual(INTERACTIVE_LIMITS.maxButtons);
        for (const o of opts) expect(o.title.length, `${ctx}:${o.reply_id}`).toBeLessThanOrEqual(INTERACTIVE_LIMITS.buttonTitleMaxLength);
      } else {
        expect(cfg.button_label!.length, ctx).toBeLessThanOrEqual(INTERACTIVE_LIMITS.buttonTitleMaxLength);
        expect(opts.length, ctx).toBeLessThanOrEqual(INTERACTIVE_LIMITS.maxListRowsTotal);
        for (const o of opts as Row[]) {
          expect(o.title.length, `${ctx}:${o.reply_id}`).toBeLessThanOrEqual(INTERACTIVE_LIMITS.listRowTitleMaxLength);
          if (o.description) expect(o.description.length, ctx).toBeLessThanOrEqual(INTERACTIVE_LIMITS.listRowDescriptionMaxLength);
        }
      }
    }
  });

  it("is deterministic and refuses to build without custom field ids", () => {
    expect(buildLeadFlow(ids)).toEqual(flow);
    expect(() => buildLeadFlow({ fields: {} })).toThrow(/Missing custom field id/);
  });

  it("skips tag steps when tag ids are not provided", () => {
    const noTags = buildLeadFlow({ fields: ids.fields });
    expect(noTags.nodes.some((n) => n.node_type === "set_tag")).toBe(false);
    expect(validateFlowForActivation({ ...noTags, entry_node_id: noTags.entry_node_id }, noTags.nodes).filter((i) => i.severity === "error")).toEqual([]);
  });

  it("lets every category question accept a typed answer and offer a skip / not-sure option", () => {
    for (const [cat, questions] of Object.entries(CATEGORY_QUESTIONS)) {
      for (const q of questions) {
        expect(q.options.some((o) => o.crm === "" || o.crm === "Not sure" || o.crm === "Other"), `${cat}:${q.key}`).toBe(true);
      }
    }
    for (const node of flow.nodes) {
      if (!/_(res|com|soc|pump|bat)_(\d+|name)$/.test(node.node_key)) continue;
      expect(typeof node.config.text_reply_next, node.node_key).toBe("string");
    }
  });
});

describe("Suraj Solar lead flow — language paths", () => {
  for (const lang of LANGS) {
    it(`continues in ${lang} after the language tap`, () => {
      const run = walk(firstOptionAnswers(lang, "solar_residential"));
      expect(run.vars.language).toBe(languageId(lang));
      expect(run.sent[0].text).toBe(WELCOME_TEXT);
      expect(run.sent[1].text).toBe(MESSAGES.categoryPrompt[lang]);
      // Every later prompt comes from this language's catalogue entries.
      for (const s of run.sent.slice(1)) expect(s.key.startsWith(`${lang}_`), s.key).toBe(true);
      expect(run.sent.at(-1)!.text).toBe(MESSAGES.finalCallback[lang]);
    });
  }
});

describe("Suraj Solar lead flow — category paths", () => {
  for (const cat of CATEGORIES) {
    it(`${cat.id} asks its own questions in order and hands off`, () => {
      const run = walk(firstOptionAnswers("en", cat.id), { hasName: true });
      const asked = run.sent
        .filter((s) => s.key.startsWith(`en_${cat.short}_`))
        .map((s) => s.text);
      expect(asked).toEqual(CATEGORY_QUESTIONS[cat.id].map((q) => q.text.en));
      expect(run.vars.solar_category).toBe(cat.id);
      expect(run.ended).toBe("handoff");
    });
  }

  it("asks for the name only when the contact has none", () => {
    const withName = walk(firstOptionAnswers("te", "solar_pump", { customer_name: "Lakshmi" }), { hasName: true });
    expect(withName.sent.some((s) => s.key === "te_pump_name")).toBe(false);
    const noName = walk(firstOptionAnswers("te", "solar_pump", { customer_name: "Lakshmi" }));
    expect(noName.sent.some((s) => s.key === "te_pump_name")).toBe(true);
    expect(noName.vars.customer_name).toBe("Lakshmi");
  });

  it("stores typed free-text answers and routes the callback-time choice", () => {
    const run = walk(
      firstOptionAnswers("hi", "solar_commercial", {
        city: "Vijayawada",
        com_bill: "around 30000",
        callback_consent: "callback_choose_time",
        callback_time: "callback_evening",
      }),
      { hasName: true },
    );
    expect(run.vars.city).toBe("Vijayawada");
    expect(run.vars.com_bill).toBe("around 30000");
    expect(run.sent.some((s) => s.key === "hi_callback_time")).toBe(true);
    expect(run.sent.at(-1)!.text).toBe(MESSAGES.finalCallback.hi);
  });

  it("sends the not-now closing message without claiming a booking", () => {
    const run = walk(firstOptionAnswers("en", "solar_battery", { callback_consent: "callback_not_now" }), { hasName: true });
    expect(run.sent.at(-1)!.text).toBe(MESSAGES.finalNotNow.en);
    for (const text of Object.values(MESSAGES.finalNotNow).concat(Object.values(MESSAGES.finalCallback))) {
      expect(text).not.toMatch(/booked|within \d+|guarantee/i);
    }
  });
});

describe("Suraj Solar lead flow — scoring and CRM", () => {
  const hot = { timeline: "timeline_1m", res_bill: "res_bill_gt_15000", res_roof: "res_roof_rcc", callback_consent: "callback_yes" };

  it("scores a ready, high-bill residential lead as HOT", () => {
    const run = walk(firstOptionAnswers("en", "solar_residential", hot), { hasName: true });
    expect(run.vars.lead_score).toBe(85);
    expect(run.vars.lead_priority).toBe("HOT");
    expect(String(run.vars.lead_priority_reasons)).toContain("Install within 1 month (+30)");
  });

  it("does not let the language choice change the score", () => {
    const scores = LANGS.map((lang) => walk(firstOptionAnswers(lang, "solar_residential", hot), { hasName: true }).vars.lead_score);
    expect(new Set(scores).size).toBe(1);
  });

  it("scores an unsure, exploring lead as NURTURE", () => {
    const run = walk(
      firstOptionAnswers("en", "solar_residential", {
        res_bill: "res_bill_unsure",
        res_roof: "res_roof_unsure",
        timeline: "timeline_exploring",
        callback_consent: "callback_not_now",
      }),
      { hasName: true },
    );
    expect(run.vars.lead_priority).toBe("NURTURE");
  });

  it("maps answers to English CRM labels and never writes a skip", () => {
    expect(crmValueMap("language")).toEqual({ lang_te: "Telugu", lang_hi: "Hindi", lang_en: "English" });
    expect(crmValueMap("city").city_skip).toBe("");
    const crm = byKey.get("crm_update")!.config as { fields: Array<{ target: string; value: string; value_map?: Record<string, string> }> };
    const location = crm.fields.find((f) => f.value === "{{vars.city}}")!;
    expect(resolveContactFieldValue(location.value, { city: "city_skip" }, location.value_map)).toBe("");
    expect(resolveContactFieldValue(location.value, { city: "Guntur" }, location.value_map)).toBe("Guntur");
    const bill = crm.fields.find((f) => f.value === "{{vars.res_bill}}")!;
    expect(resolveContactFieldValue(bill.value, { res_bill: "res_bill_2500_4000" }, bill.value_map)).toBe("₹2,500–₹4,000");
    for (const f of crm.fields) expect(f.target === "name" || f.target.startsWith("custom:field-")).toBe(true);
  });

  it("hands off to the sales queue with round-robin assignment", () => {
    expect(byKey.get("handoff")!.config).toMatchObject({ assign_mode: "round_robin" });
  });
});
