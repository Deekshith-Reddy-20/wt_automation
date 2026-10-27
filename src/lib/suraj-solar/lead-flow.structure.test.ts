import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildLeadFlow, LEAD_FLOW_CUSTOM_FIELDS, LEAD_FLOW_TAGS, LEAD_SCORING, type LeadFlowNode } from "./lead-flow";

/**
 * Guards the qualification flow's structure against wording changes.
 *
 * The fixture is the flow graph with every display string removed: node
 * keys and types, option ids in order, every transition, conditions,
 * CRM mappings and scoring. Rewording a message must leave it untouched.
 * Regenerate only for an intentional flow change:
 *   WRITE_LEAD_FLOW_FIXTURE=1 npx vitest run src/lib/suraj-solar/lead-flow.structure.test.ts
 */

const FIXTURE = join(__dirname, "__fixtures__", "lead-flow-structure.json");

/** Language reply ids were renamed language_* → lang_*; nothing else changed. */
const RENAMED_IDS: Record<string, string> = { language_te: "lang_te", language_en: "lang_en", language_hi: "lang_hi" };

const DISPLAY_KEYS = new Set(["text", "header_text", "footer_text", "button_label", "title", "description"]);

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !DISPLAY_KEYS.has(k))
        .map(([k, v]) => [k, strip(v)]),
    );
  }
  return typeof value === "string" ? (RENAMED_IDS[value] ?? value) : value;
}

function renameKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(renameKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [RENAMED_IDS[k] ?? k, renameKeys(v)]),
    );
  }
  return value;
}

function fingerprint(nodes: LeadFlowNode[]) {
  return Object.fromEntries(
    [...nodes]
      .sort((a, b) => a.node_key.localeCompare(b.node_key))
      .map((n) => {
        const config = renameKeys(strip(n.config)) as Record<string, unknown>;
        // The language menu order is the one intentional change; compare its routes as a set.
        if (n.node_key === "welcome") {
          config.buttons = [...(config.buttons as Array<{ reply_id: string }>)].sort((a, b) => a.reply_id.localeCompare(b.reply_id));
        }
        return [n.node_key, { type: n.node_type, config }];
      }),
  );
}

const ids = {
  fields: Object.fromEntries(LEAD_FLOW_CUSTOM_FIELDS.map(([name], i) => [name, `field-${i}`])),
  tags: { [LEAD_FLOW_TAGS.newEnquiry]: "tag-new", [LEAD_FLOW_TAGS.hot]: "tag-hot" },
};

describe("Suraj Solar lead flow — structure is unchanged", () => {
  const flow = buildLeadFlow(ids);
  const current = {
    trigger_type: flow.trigger_type,
    trigger_config: flow.trigger_config,
    fallback_policy: flow.fallback_policy,
    entry_node_id: flow.entry_node_id,
    scoring: LEAD_SCORING,
    nodes: fingerprint(flow.nodes),
  };

  if (process.env.WRITE_LEAD_FLOW_FIXTURE === "1") writeFileSync(FIXTURE, `${JSON.stringify(current, null, 2)}\n`);
  const baseline = JSON.parse(readFileSync(FIXTURE, "utf8"));

  it("keeps the same nodes, types and node count", () => {
    expect(Object.keys(current.nodes)).toEqual(Object.keys(baseline.nodes));
    for (const [key, node] of Object.entries(current.nodes)) expect(node.type, key).toBe(baseline.nodes[key].type);
  });

  it("keeps every option id, transition, condition and CRM mapping", () => {
    for (const [key, node] of Object.entries(current.nodes)) expect(node.config, key).toEqual(baseline.nodes[key].config);
  });

  it("keeps the trigger, fallback policy, entry node and lead scoring", () => {
    expect(current.trigger_type).toBe(baseline.trigger_type);
    expect(current.trigger_config).toEqual(baseline.trigger_config);
    expect(current.fallback_policy).toEqual(baseline.fallback_policy);
    expect(current.entry_node_id).toBe(baseline.entry_node_id);
    expect(current.scoring).toEqual(baseline.scoring);
  });
});
