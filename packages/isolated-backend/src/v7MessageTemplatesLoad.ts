import { randomUUID } from "node:crypto";
import {
  MESSAGE_TEMPLATE_BODY_MAX, MESSAGE_TEMPLATE_REGISTRY, MESSAGE_TEMPLATE_SUBJECT_MAX, messageTemplateRequiredIssues, messageTemplateTokenIssues, tokensIn,
  type MessageTemplateDefinition,
} from "@nzi/contracts";
import { withTenantWrite, type PoolLike, type Queryable } from "./postgres";
import { IMPORT_ACTOR, SOURCE_SYSTEM } from "./v7ClientImport";
import type { V7Row, V7Table } from "./v7ClientExtract";

/**
 * The v7 message-template import (admin Phase F1, `load:v7-message-templates`; ruled `phaseF-comms-crm-plan.md` F-Q2/F-Q3):
 * v7's `message_templates` content onto the console's **known keys** — never inventing one.
 *
 * **The plan (pure)** takes each v7 template and:
 * - finds the console key it is for — the same key, or the one whose registry entry names it as its v7 template. A v7 key
 *   with no console send-site is **reported, not imported** (F-Q3);
 * - renames v7's tokens to the key's (the registry's mapping); a v7 token the key does not supply **refuses the template**,
 *   naming the token — a message that would send a blank, or a value the console never issues, is not guessed at;
 * - turns v7's HTML body into the plain text the console sends (line breaks and paragraphs kept, tags dropped, entities
 *   decoded) — noted, so the wording can be read before it is committed.
 *
 * **The load**: per key, its v7 identity; else the organisation's own wording for that key, which is **stamped and kept**
 * (a person's wording is never overwritten by an import); else inserted, active as v7 has it. Re-runs (R4): v7 unchanged →
 * left alone; changed and still as an import wrote it → v7 wins; edited here since → refused and reported. Nothing is
 * deleted or deactivated. The report names keys, never wording.
 *
 * **An imported active template is what that message sends from the moment it is committed** — which is why the dry run
 * goes to `_handoff` first.
 *
 * One transaction; a dry run is the whole load, rolled back.
 */

export const MESSAGE_TEMPLATES_RUN_PREFIX = "v7-message-templates-";
export const V7_MESSAGE_TEMPLATE_TABLES: readonly V7Table[] = ["message_templates"];

const text = (value: string | null | undefined) => { const trimmed = value?.trim(); return trimmed ? trimmed : null; };
const flag = (value: string | null | undefined): boolean | null => {
  const v = value?.trim().toLowerCase();
  return v === "t" || v === "true" || v === "1" ? true : v === "f" || v === "false" || v === "0" ? false : null;
};

/** v7's HTML body as the plain text the console's mailer sends. */
export function htmlToText(html: string): string {
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", "#39": "'", apos: "'", nbsp: " " };
  return html
    .replace(/\r\n?/g, "\n")
    .replace(/\n/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|ul|ol|table|tr)>/gi, "\n\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, name: string) => entities[name]!)
    .split("\n").map((line) => line.replace(/[ \t]+/g, " ").trim()).join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const looksLikeHtml = (value: string) => /<\/?[a-z][^>]*>/i.test(value);

// ── The plan (pure) ────────────────────────────────────────────────────────────────────────────────────────────────

export type PlannedMessageTemplate = {
  legacyDbId: string; v7Key: string; templateKey: string; subject: string; body: string; active: boolean; convertedFromHtml: boolean;
  legacyValues: Record<string, unknown>;
};
export type MessageTemplatesPlan = {
  values: PlannedMessageTemplate[];
  /** v7 templates for no console send-site — reported, never invented (F-Q3). */
  unknownKeys: string[];
  /** v7 templates for a known key that cannot be taken as they stand, and why — by key, never quoting the wording. */
  refused: Array<{ v7Key: string; reason: string }>;
};

const definitionFor = (v7Key: string): MessageTemplateDefinition | undefined =>
  MESSAGE_TEMPLATE_REGISTRY.find((definition) => definition.key === v7Key)
  ?? MESSAGE_TEMPLATE_REGISTRY.find((definition) => definition.v7 && definition.v7.key.toLowerCase() === v7Key.toLowerCase());

export function planV7MessageTemplates(extract: Partial<Record<V7Table, readonly V7Row[]>>): MessageTemplatesPlan {
  const plan: MessageTemplatesPlan = { values: [], unknownKeys: [], refused: [] };
  const taken = new Map<string, string>();
  for (const row of [...(extract.message_templates ?? [])].sort((a, b) => Number(a.template_id) - Number(b.template_id))) {
    const legacyDbId = text(row.template_id);
    const v7Key = text(row.template_key);
    if (!legacyDbId || !v7Key) { plan.refused.push({ v7Key: v7Key ?? "(blank)", reason: "a row with no id or no key" }); continue; }
    const refuse = (reason: string) => plan.refused.push({ v7Key, reason });
    const definition = definitionFor(v7Key);
    if (!definition) { plan.unknownKeys.push(v7Key); continue; }
    if ((text(row.channel) ?? "email").toLowerCase() !== definition.channel) { refuse(`its channel is ${row.channel}, not ${definition.channel}`); continue; }
    if (taken.has(definition.key)) { refuse(`a second v7 template for ${definition.key} (v7 ${taken.get(definition.key)} is taken)`); continue; }

    const mapping = definition.key === v7Key ? Object.fromEntries(definition.tokens.map((token) => [token.name, token.name])) : (definition.v7?.tokens ?? {});
    const rename = (value: string) => value.replace(/\{\{([^{}]*)\}\}/g, (whole, name: string) => mapping[name.trim()] ? `{{${mapping[name.trim()]}}}` : whole);
    const rawSubject = text(row.subject_template);
    const rawBody = text(row.body_template);
    if (!rawSubject || !rawBody) { refuse("no subject or no body in v7"); continue; }
    const unmapped = [...new Set([...tokensIn(rawSubject), ...tokensIn(rawBody)].map((name) => name.trim()).filter((name) => !mapping[name]))];
    if (unmapped.length) { refuse(`uses ${unmapped.map((name) => `{{${name}}}`).join(", ")}, which ${definition.key} does not supply`); continue; }
    const convertedFromHtml = looksLikeHtml(rawBody);
    const subject = rename(rawSubject);
    const body = rename(convertedFromHtml ? htmlToText(rawBody) : rawBody);
    const issues = [...messageTemplateTokenIssues(subject, definition), ...messageTemplateTokenIssues(body, definition), ...messageTemplateRequiredIssues(body, definition)];
    if (issues.length) { refuse(issues.join(" ")); continue; }
    if (subject.length > MESSAGE_TEMPLATE_SUBJECT_MAX || body.length > MESSAGE_TEMPLATE_BODY_MAX) { refuse("longer than a console template holds"); continue; }

    taken.set(definition.key, v7Key);
    plan.values.push({
      legacyDbId, v7Key, templateKey: definition.key, subject, body, active: flag(row.is_active) ?? true, convertedFromHtml,
      legacyValues: { key: v7Key, subject: rawSubject, body: rawBody, channel: row.channel ?? null, isActive: row.is_active ?? null },
    });
  }
  return plan;
}

// ── Loading ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type MessageTemplatesOutcome = {
  committed: boolean; runId: string;
  inserted: number; stamped: number; updated: number; unchanged: number;
  /** R4 conflicts, by key. */
  refused: string[];
  notes: string[];
  /** Console keys that will send the built-in wording after this load (no active template of the organisation's own). */
  builtIn: string[];
};

class DryRunRollback extends Error {}
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]))
  : value;
const same = (a: unknown, b: unknown) => a !== null && a !== undefined && JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const byImport = (actor: string) => actor.startsWith(MESSAGE_TEMPLATES_RUN_PREFIX);

type Held = { template_key: string; source_system: string | null; legacy_db_id: string | null; legacy_values: unknown; updated_by: string; active: boolean };

export async function loadV7MessageTemplates(pool: PoolLike, organisationId: string, plan: MessageTemplatesPlan, options: { commit: boolean; runId?: string }): Promise<MessageTemplatesOutcome> {
  const runId = options.runId ?? `${MESSAGE_TEMPLATES_RUN_PREFIX}${randomUUID()}`;
  if (!runId.startsWith(MESSAGE_TEMPLATES_RUN_PREFIX)) throw new Error(`A message-templates run id must start ${MESSAGE_TEMPLATES_RUN_PREFIX} — it is how a re-run knows a row is still as an import wrote it.`);
  const outcome: MessageTemplatesOutcome = { committed: options.commit, runId, inserted: 0, stamped: 0, updated: 0, unchanged: 0, refused: [], notes: [], builtIn: [] };
  try {
    await withTenantWrite(pool, organisationId, async (db) => {
      await reconcile(db, organisationId, plan, runId, outcome);
      if (outcome.inserted + outcome.stamped + outcome.updated > 0) {
        await db.query(
          `INSERT INTO nzi_console.audit_events (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, reason, after_json)
           VALUES ($1, $2, $3, 'system', 'message_templates.imported', 'message_templates', 'message_templates', $4, $5, $6::jsonb)`,
          [organisationId, randomUUID(), IMPORT_ACTOR, runId, "Message templates reconciled from NZ Insights Pro v7 (admin F1)",
            JSON.stringify({ run: runId, sourceSystem: SOURCE_SYSTEM, inserted: outcome.inserted, stamped: outcome.stamped, updated: outcome.updated,
              unchanged: outcome.unchanged, refused: outcome.refused.length, unknownKeys: plan.unknownKeys.length })]);
      }
      if (!options.commit) throw new DryRunRollback();
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  }
  return outcome;
}

async function reconcile(db: Queryable, org: string, plan: MessageTemplatesPlan, runId: string, outcome: MessageTemplatesOutcome) {
  const { rows: held } = await db.query<Held>(
    `SELECT template_key, source_system, legacy_db_id, legacy_values, updated_by, active FROM nzi_console.message_templates WHERE organisation_id = $1 ORDER BY template_key FOR UPDATE`, [org]);
  for (const value of plan.values) {
    if (value.convertedFromHtml) outcome.notes.push(`${value.templateKey} (v7 ${value.v7Key}): v7's HTML body converted to plain text — read it in the console before relying on it`);
    const row = held.find((candidate) => candidate.template_key === value.templateKey);
    const provenance = [SOURCE_SYSTEM, value.legacyDbId, JSON.stringify(value.legacyValues)] as const;
    if (!row) {
      await db.query(
        `INSERT INTO nzi_console.message_templates (organisation_id, template_key, channel, subject, body, active, source_system, legacy_db_id, legacy_values, created_by, updated_by)
         VALUES ($1, $2, 'email', $3, $4, $5, $6, $7, $8::jsonb, $9, $9)`,
        [org, value.templateKey, value.subject, value.body, value.active, ...provenance, runId]);
      outcome.inserted += 1;
      continue;
    }
    if (row.source_system === SOURCE_SYSTEM && row.legacy_db_id === value.legacyDbId) {
      if (same(row.legacy_values, value.legacyValues)) { outcome.unchanged += 1; continue; }
      if (!byImport(row.updated_by)) { outcome.refused.push(`${value.templateKey}: changed in v7 since the last load, and edited here since (R4)`); continue; }
      await db.query(
        `UPDATE nzi_console.message_templates SET subject = $3, body = $4, active = $5, source_system = $6, legacy_db_id = $7, legacy_values = $8::jsonb,
                version = version + 1, updated_at = now(), updated_by = $9 WHERE organisation_id = $1 AND template_key = $2`,
        [org, value.templateKey, value.subject, value.body, value.active, ...provenance, runId]);
      outcome.updated += 1;
      continue;
    }
    if (row.source_system !== null) { outcome.refused.push(`${value.templateKey}: already holds another v7 template's wording`); continue; }
    // The organisation's own wording: it stands; it takes v7's identity so the next run reconciles onto it.
    await db.query(
      `UPDATE nzi_console.message_templates SET source_system = $3, legacy_db_id = $4, legacy_values = $5::jsonb, version = version + 1, updated_at = now()
        WHERE organisation_id = $1 AND template_key = $2`, [org, value.templateKey, ...provenance]);
    outcome.notes.push(`${value.templateKey}: the organisation already has its own wording — stamped with v7's identity; its wording stands`);
    outcome.stamped += 1;
  }
  const { rows: active } = await db.query<{ template_key: string }>(`SELECT template_key FROM nzi_console.message_templates WHERE organisation_id = $1 AND active`, [org]);
  outcome.builtIn = MESSAGE_TEMPLATE_REGISTRY.map((definition) => definition.key).filter((key) => !active.some((row) => row.template_key === key));
}
