"use client";

/**
 * Builder forms for lead-capture features: answer capture on
 * send_buttons / send_list, the update_contact and score_lead nodes,
 * and the handoff assignment mode.
 */

import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createClient } from "@/lib/supabase/client";
import type { BuilderNode } from "../shared";
import { NextNodeRow, TextRow } from "./fields";

type T = ReturnType<typeof useTranslations>;
type Patch = (patch: Record<string, unknown>) => void;

const sanitizeVarKey = (v: string) => v.replace(/[^a-zA-Z0-9_]/g, "");

// ------------------------------------------------------------
// Answer capture (send_buttons / send_list)
// ------------------------------------------------------------

export function AnswerCaptureFields({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
  t,
}: {
  cfg: { save_as?: string; text_reply_next?: string };
  allNodes: BuilderNode[];
  currentKey: string;
  onUpdateConfig: Patch;
  t: T;
}) {
  const acceptsText = typeof cfg.text_reply_next === "string";
  return (
    <div className="grid grid-cols-1 gap-3 rounded-md border border-dashed border-border p-3 md:grid-cols-2">
      <div>
        <label className="mb-1 block text-xs text-muted-foreground">{t("saveAsLabel")}</label>
        <Input
          value={cfg.save_as ?? ""}
          onChange={(e) => onUpdateConfig({ save_as: sanitizeVarKey(e.target.value) })}
          placeholder={t("saveAsPlaceholder")}
          className="bg-muted font-mono text-xs"
        />
        <p className="mt-1 text-[10px] text-muted-foreground">{t("saveAsHelp")}</p>
      </div>
      <div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={acceptsText}
            onChange={(e) =>
              onUpdateConfig({ text_reply_next: e.target.checked ? "" : undefined })
            }
          />
          {t("acceptTypedReply")}
        </label>
        {acceptsText && (
          <div className="mt-2">
            <NextNodeRow
              value={cfg.text_reply_next ?? ""}
              allNodes={allNodes}
              currentKey={currentKey}
              onChange={(v) => onUpdateConfig({ text_reply_next: v })}
              label={t("typedReplyAdvancesTo")}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------
// update_contact
// ------------------------------------------------------------

interface UpdateContactCfg {
  fields?: Array<{ target: string; value: string; value_map?: Record<string, string> }>;
  note?: string;
  next_node_key?: string;
}

function useCustomFields(): Array<{ id: string; field_name: string }> {
  const [fields, setFields] = useState<Array<{ id: string; field_name: string }>>([]);
  useEffect(() => {
    let cancelled = false;
    createClient()
      .from("custom_fields")
      .select("id, field_name")
      .order("field_name")
      .then(({ data }) => {
        if (!cancelled && data) setFields(data as Array<{ id: string; field_name: string }>);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return fields;
}

export function UpdateContactForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
  t,
}: {
  cfg: UpdateContactCfg;
  allNodes: BuilderNode[];
  currentKey: string;
  onUpdateConfig: Patch;
  t: T;
}) {
  const customFields = useCustomFields();
  const fields = cfg.fields ?? [];
  const update = (idx: number, patch: Partial<(typeof fields)[number]>) =>
    onUpdateConfig({ fields: fields.map((f, i) => (i === idx ? { ...f, ...patch } : f)) });

  return (
    <>
      <div>
        <label className="mb-2 block text-xs text-muted-foreground">{t("updateFieldsHelp")}</label>
        <div className="flex flex-col gap-2">
          {fields.map((f, i) => (
            <div
              key={i}
              className="grid grid-cols-1 gap-2 rounded-md border border-border bg-muted/40 p-3 md:grid-cols-[2fr_3fr_auto]"
            >
              <Select value={f.target} onValueChange={(v) => update(i, { target: v ?? "name" })}>
                <SelectTrigger className="bg-muted">
                  <SelectValue placeholder={t("pickField")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="name">name</SelectItem>
                  <SelectItem value="email">email</SelectItem>
                  <SelectItem value="company">company</SelectItem>
                  {customFields.map((cf) => (
                    <SelectItem key={cf.id} value={`custom:${cf.id}`}>
                      {cf.field_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div>
                <Input
                  value={f.value}
                  onChange={(e) => update(i, { value: e.target.value })}
                  placeholder="{{vars.answer}}"
                  className="bg-muted font-mono text-xs"
                />
                {f.value_map && Object.keys(f.value_map).length > 0 && (
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    {t("valueMapCount", { count: Object.keys(f.value_map).length })}
                  </p>
                )}
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onUpdateConfig({ fields: fields.filter((_, j) => j !== i) })}
                className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="mt-2"
          onClick={() => onUpdateConfig({ fields: [...fields, { target: "name", value: "" }] })}
        >
          <Plus className="h-3.5 w-3.5" />
          {t("addField")}
        </Button>
        <p className="mt-1 text-[10px] text-muted-foreground">{t("updateValueHelp")}</p>
      </div>
      <TextRow
        label={t("contactNoteLabel")}
        value={cfg.note ?? ""}
        onChange={(v) => onUpdateConfig({ note: v })}
        rows={4}
      />
      <NextNodeRow
        value={cfg.next_node_key ?? ""}
        allNodes={allNodes}
        currentKey={currentKey}
        onChange={(v) => onUpdateConfig({ next_node_key: v })}
        label={t("thenAdvanceTo")}
      />
    </>
  );
}

// ------------------------------------------------------------
// score_lead
// ------------------------------------------------------------

interface ScoreLeadCfg {
  rules?: Array<{ var_key: string; values?: string[]; points: number; label?: string }>;
  bands?: Array<{ label: string; min_score: number }>;
  fallback_label?: string;
  score_var?: string;
  category_var?: string;
  next_node_key?: string;
}

export function ScoreLeadForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
  t,
}: {
  cfg: ScoreLeadCfg;
  allNodes: BuilderNode[];
  currentKey: string;
  onUpdateConfig: Patch;
  t: T;
}) {
  const rules = cfg.rules ?? [];
  const bands = cfg.bands ?? [];
  const updateRule = (idx: number, patch: Partial<(typeof rules)[number]>) =>
    onUpdateConfig({ rules: rules.map((r, i) => (i === idx ? { ...r, ...patch } : r)) });
  const updateBand = (idx: number, patch: Partial<(typeof bands)[number]>) =>
    onUpdateConfig({ bands: bands.map((b, i) => (i === idx ? { ...b, ...patch } : b)) });

  return (
    <>
      <div>
        <label className="mb-2 block text-xs text-muted-foreground">{t("scoreRulesHelp")}</label>
        <div className="flex flex-col gap-2">
          {rules.map((r, i) => (
            <div
              key={i}
              className="grid grid-cols-1 gap-2 rounded-md border border-border bg-muted/40 p-3 md:grid-cols-[1.2fr_2fr_0.7fr_2fr_auto]"
            >
              <Input
                value={r.var_key}
                onChange={(e) => updateRule(i, { var_key: sanitizeVarKey(e.target.value) })}
                placeholder={t("varName")}
                className="bg-muted font-mono text-xs"
              />
              <Input
                value={(r.values ?? []).join(", ")}
                onChange={(e) =>
                  updateRule(i, {
                    values: e.target.value
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
                placeholder={t("ruleValuesPlaceholder")}
                className="bg-muted font-mono text-xs"
              />
              <Input
                type="number"
                value={Number.isFinite(r.points) ? r.points : 0}
                onChange={(e) => updateRule(i, { points: Number(e.target.value) })}
                className="bg-muted"
              />
              <Input
                value={r.label ?? ""}
                onChange={(e) => updateRule(i, { label: e.target.value })}
                placeholder={t("ruleLabelPlaceholder")}
                className="bg-muted"
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onUpdateConfig({ rules: rules.filter((_, j) => j !== i) })}
                className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="mt-2"
          onClick={() =>
            onUpdateConfig({ rules: [...rules, { var_key: "", values: [], points: 10, label: "" }] })
          }
        >
          <Plus className="h-3.5 w-3.5" />
          {t("addRule")}
        </Button>
      </div>
      <div>
        <label className="mb-2 block text-xs text-muted-foreground">{t("scoreBandsHelp")}</label>
        <div className="flex flex-col gap-2">
          {bands.map((b, i) => (
            <div key={i} className="grid grid-cols-[2fr_1fr_auto] gap-2">
              <Input
                value={b.label}
                onChange={(e) => updateBand(i, { label: e.target.value })}
                className="bg-muted"
              />
              <Input
                type="number"
                value={b.min_score}
                onChange={(e) => updateBand(i, { min_score: Number(e.target.value) })}
                className="bg-muted"
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onUpdateConfig({ bands: bands.filter((_, j) => j !== i) })}
                className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="mt-2"
          onClick={() => onUpdateConfig({ bands: [...bands, { label: "", min_score: 0 }] })}
        >
          <Plus className="h-3.5 w-3.5" />
          {t("addBand")}
        </Button>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <TextRow
          label={t("fallbackCategory")}
          value={cfg.fallback_label ?? ""}
          onChange={(v) => onUpdateConfig({ fallback_label: v })}
        />
        <TextRow
          label={t("scoreVar")}
          value={cfg.score_var ?? ""}
          onChange={(v) => onUpdateConfig({ score_var: sanitizeVarKey(v) })}
        />
        <TextRow
          label={t("categoryVar")}
          value={cfg.category_var ?? ""}
          onChange={(v) => onUpdateConfig({ category_var: sanitizeVarKey(v) })}
        />
      </div>
      <NextNodeRow
        value={cfg.next_node_key ?? ""}
        allNodes={allNodes}
        currentKey={currentKey}
        onChange={(v) => onUpdateConfig({ next_node_key: v })}
        label={t("thenAdvanceTo")}
      />
    </>
  );
}

// ------------------------------------------------------------
// handoff
// ------------------------------------------------------------

export function HandoffForm({
  cfg,
  onUpdateConfig,
  t,
}: {
  cfg: { note?: string; assign_mode?: "fixed" | "round_robin" };
  onUpdateConfig: Patch;
  t: T;
}) {
  return (
    <>
      <TextRow
        label={t("internalNote")}
        value={cfg.note ?? ""}
        onChange={(v) => onUpdateConfig({ note: v })}
        rows={2}
      />
      <div>
        <label className="mb-1 block text-xs text-muted-foreground">{t("assignModeLabel")}</label>
        <Select
          value={cfg.assign_mode ?? "fixed"}
          onValueChange={(v) => onUpdateConfig({ assign_mode: v })}
        >
          <SelectTrigger className="bg-muted">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="fixed">{t("assignNone")}</SelectItem>
            <SelectItem value="round_robin">{t("assignRoundRobin")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </>
  );
}
