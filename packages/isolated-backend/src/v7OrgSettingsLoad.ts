import { createHash, randomUUID } from "node:crypto";
import { normaliseProfile, profileIssues, type ClientLogoContentType, type OrganisationProfileFields } from "@nzi/contracts";
import { inspectClientLogo } from "./clientLogo";
import { withTenantWrite, type PoolLike } from "./postgres";
import { IMPORT_ACTOR, SOURCE_SYSTEM } from "./v7ClientImport";
import type { V7Row, V7Table } from "./v7ClientExtract";

/**
 * The v7 organisation-profile import (admin Phase D, D2, `load:v7-org-settings`; ruled `phaseD-org-settings-plan.md` Q4).
 * v7's `system_settings` profile and logo keys → the organisation's one profile row, **once, fill-empty-only**: the
 * console is the profile's source from day one (admin-plan R4's exception), so an import never overwrites a value here.
 *
 * - **The bank details are never read.** The extract's `keys` filter copies only the allow-listed profile and logo keys;
 *   should a `bank_*` row ever arrive regardless, the whole load is refused (fail-closed). They are hand-entered.
 * - **A field** is filled when the profile's is empty; the same value is "unchanged"; a different one is "differs" and
 *   reported, never applied. The one exception is the display name 0142 provisioned from the organisation's name: while
 *   no person has edited the profile, v7's display name may replace it.
 * - **Every value is normalised and checked by the profile's own rules** (`normaliseProfile`, `profileIssues`); one they
 *   refuse is reported as invalid and left out.
 * - **The logo** arrives as an `organisation_logo_assets` row through the client-logo inspector, when there is none here.
 * - **`legacy_values`** records a sha256 of each v7 value imported — never the value — so a re-run can say "v7 has
 *   changed since the import" without holding a second copy of anything.
 * - **Nothing reports a value.** The outcome, the report and the audit name fields and states only.
 *
 * One transaction; a dry run is the whole load, rolled back.
 */

export const ORG_SETTINGS_RUN_PREFIX = "v7-org-settings-";
export const V7_ORG_SETTINGS_TABLES: readonly V7Table[] = ["system_settings"];

type ProfileField = Exclude<keyof OrganisationProfileFields, "shortName" | "footerOverride" | "signatoryUserId" | "signatoryTitle">;
/** v7's key for each profile field (`services/company_profile.py`). */
export const V7_PROFILE_KEYS: Record<string, ProfileField> = {
  company_legal_name: "legalName", company_display_name: "displayName", company_registration_number: "registrationNumber", vat_number: "vatNumber",
  registered_address_line_1: "addressLine1", registered_address_line_2: "addressLine2", registered_address_city: "addressCity",
  registered_address_region: "addressRegion", registered_address_postcode: "addressPostcode", registered_address_country: "addressCountry",
  contact_email: "contactEmail", contact_phone: "contactPhone", website_url: "websiteUrl",
};
const LOGO_KEYS = ["nzi_logo_b64", "nzi_logo_mime", "nzi_logo_file"];
const COLUMN: Record<ProfileField, string> = {
  legalName: "legal_name", displayName: "display_name", registrationNumber: "registration_number", vatNumber: "vat_number",
  addressLine1: "address_line_1", addressLine2: "address_line_2", addressCity: "address_city", addressRegion: "address_region",
  addressPostcode: "address_postcode", addressCountry: "address_country", contactEmail: "contact_email", contactPhone: "contact_phone", websiteUrl: "website_url",
};
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

// ── The plan (pure; values in memory only) ────────────────────────────────────────────────────────────────────

export type OrgSettingsPlan = {
  /** Normalised v7 values that pass the profile's rules. */
  fields: Partial<Record<ProfileField, string>>;
  /** v7 fields the profile's rules refuse — by field and rule, never the value. */
  invalid: Array<{ field: ProfileField; code: string }>;
  /** v7 fields held blank. */
  blank: ProfileField[];
  logo: { contentType: ClientLogoContentType; fileName: string; dataBase64: string } | { problem: string } | null;
  /** Keys the extract carried that this import does not read — names only. */
  unknownKeys: string[];
  /** Set when the extract carries anything that must never be here: the load is refused whole. */
  refused: string | null;
};

export function planV7OrgSettings(extract: Partial<Record<V7Table, readonly V7Row[]>>): OrgSettingsPlan {
  const rows = extract.system_settings ?? [];
  const byKey = new Map(rows.map((row) => [String(row.setting_key ?? "").trim(), row.setting_value ?? ""]));
  const plan: OrgSettingsPlan = { fields: {}, invalid: [], blank: [], logo: null, unknownKeys: [], refused: null };
  const bank = [...byKey.keys()].filter((key) => key.startsWith("bank_"));
  if (bank.length > 0) {
    plan.refused = `the extract carries ${bank.length} bank-detail row(s); bank details are hand-entered and must never be extracted — delete the extract and re-run it with the keys filter`;
    return plan;
  }
  const raw: Partial<Record<ProfileField, string>> = {};
  for (const [key, value] of byKey) {
    const field = V7_PROFILE_KEYS[key];
    if (field) { if (value.trim()) raw[field] = value; else plan.blank.push(field); continue; }
    if (!LOGO_KEYS.includes(key)) plan.unknownKeys.push(key);
  }
  const blankFields: OrganisationProfileFields = {
    legalName: null, displayName: null, shortName: null, registrationNumber: null, vatNumber: null, addressLine1: null, addressLine2: null, addressCity: null, addressRegion: null,
    addressPostcode: null, addressCountry: null, contactEmail: null, contactPhone: null, websiteUrl: null, footerOverride: null, signatoryUserId: null, signatoryTitle: null,
  };
  const normalised = normaliseProfile({ ...blankFields, ...raw });
  const refused = new Map(profileIssues(normalised).map((issue) => [issue.field, issue.code]));
  for (const field of Object.keys(raw) as ProfileField[]) {
    const value = normalised[field];
    if (value === null) plan.blank.push(field);
    else if (refused.has(field)) plan.invalid.push({ field, code: refused.get(field)! });
    else plan.fields[field] = value;
  }
  const b64 = (byKey.get("nzi_logo_b64") ?? "").replace(/\s+/g, "");
  if (b64) {
    const mime = (byKey.get("nzi_logo_mime") ?? "").trim();
    plan.logo = mime === "image/png" || mime === "image/svg+xml"
      ? { contentType: mime, fileName: (byKey.get("nzi_logo_file") ?? "").trim() || "logo", dataBase64: b64 }
      : { problem: `a logo of type ${mime || "unknown"} (only PNG or SVG)` };
  }
  return plan;
}

// ── The load ──────────────────────────────────────────────────────────────────────────────────────────────────

export type FieldState = "filled" | "unchanged" | "differs" | "blank-in-v7" | "invalid-in-v7" | "not-in-v7";
export type OrgSettingsOutcome = {
  committed: boolean; runId: string; refused: string | null;
  fields: Array<{ field: ProfileField; state: FieldState; v7ChangedSinceImport?: boolean; rule?: string }>;
  logo: "filled" | "unchanged" | "differs" | "none-in-v7" | "refused";
  logoProblem?: string;
  unknownKeys: string[];
  version: { before: number; after: number };
};

class DryRunRollback extends Error {}

export async function loadV7OrgSettings(pool: PoolLike, organisationId: string, plan: OrgSettingsPlan, options: { commit: boolean; runId?: string }): Promise<OrgSettingsOutcome> {
  const runId = options.runId ?? `${ORG_SETTINGS_RUN_PREFIX}${randomUUID()}`;
  if (!runId.startsWith(ORG_SETTINGS_RUN_PREFIX)) throw new Error(`An organisation-settings run id must start ${ORG_SETTINGS_RUN_PREFIX}.`);
  const outcome: OrgSettingsOutcome = { committed: options.commit, runId, refused: plan.refused, fields: [], logo: "none-in-v7", unknownKeys: plan.unknownKeys, version: { before: 0, after: 0 } };
  if (plan.refused) return outcome;
  try {
    await withTenantWrite(pool, organisationId, async (db) => {
      const { rows: [profile] } = await db.query<Record<string, unknown> & { version: number; updated_by: string; logo_asset_id: string | null; legacy_values: Record<string, string> | null }>(
        `SELECT *, version FROM nzi_console.organisation_profiles WHERE organisation_id = $1 FOR UPDATE`, [organisationId]);
      if (!profile) throw new Error(`${organisationId} has no profile row; 0142 provisions one.`);
      outcome.version = { before: profile.version, after: profile.version };
      // Not yet edited by a person: last written by a migration (0142 provisioning it, 0143 setting the short name) or by this import.
      const neverEdited = profile.updated_by.startsWith("migration:") || profile.updated_by.startsWith(ORG_SETTINGS_RUN_PREFIX);
      const previous = profile.legacy_values ?? {};
      const legacy: Record<string, string> = { ...previous };
      const sets: Array<[string, string]> = [];

      for (const field of Object.values(V7_PROFILE_KEYS)) {
        const current = profile[COLUMN[field]] as string | null;
        const v7 = plan.fields[field];
        const invalid = plan.invalid.find((entry) => entry.field === field);
        if (invalid) { outcome.fields.push({ field, state: "invalid-in-v7", rule: invalid.code }); continue; }
        if (v7 === undefined) { outcome.fields.push({ field, state: plan.blank.includes(field) ? "blank-in-v7" : "not-in-v7" }); continue; }
        const changedSinceImport = previous[field] !== undefined && previous[field] !== digest(v7);
        const replaceProvisioned = field === "displayName" && neverEdited && current !== null && previous[field] === undefined;
        if (current === null || (replaceProvisioned && current !== v7)) {
          sets.push([COLUMN[field], v7]);
          legacy[field] = digest(v7);
          outcome.fields.push({ field, state: "filled" });
        } else if (current === v7) {
          legacy[field] = digest(v7);
          outcome.fields.push({ field, state: "unchanged", ...(changedSinceImport ? { v7ChangedSinceImport: true } : {}) });
        } else {
          // Kept as the console has it; the digest stays what was imported, so "v7 changed since" remains visible.
          outcome.fields.push({ field, state: "differs", ...(changedSinceImport ? { v7ChangedSinceImport: true } : {}) });
        }
      }

      let logoAssetId: string | null = null;
      if (plan.logo && "problem" in plan.logo) { outcome.logo = "refused"; outcome.logoProblem = plan.logo.problem; }
      else if (plan.logo) {
        const { bytes, issues } = inspectClientLogo(plan.logo.contentType, plan.logo.dataBase64);
        if (issues.length) { outcome.logo = "refused"; outcome.logoProblem = issues.join(" "); }
        else {
          const sha256 = digest(bytes);
          if (profile.logo_asset_id === null) {
            logoAssetId = randomUUID();
            await db.query(
              `INSERT INTO nzi_console.organisation_logo_assets (organisation_id, asset_id, file_name, content_type, byte_size, sha256, content, uploaded_by)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
              [organisationId, logoAssetId, plan.logo.fileName.slice(0, 200), plan.logo.contentType, bytes.length, sha256, bytes, runId]);
            legacy.logo = sha256;
            outcome.logo = "filled";
          } else {
            const { rows: [asset] } = await db.query<{ sha256: string }>(`SELECT sha256 FROM nzi_console.organisation_logo_assets WHERE organisation_id = $1 AND asset_id = $2`, [organisationId, profile.logo_asset_id]);
            outcome.logo = asset?.sha256 === sha256 ? "unchanged" : "differs";
          }
        }
      }

      const changed = outcome.fields.filter((entry) => entry.state === "filled").map((entry) => entry.field as string).concat(outcome.logo === "filled" ? ["logo"] : []);
      const stamp = JSON.stringify(legacy) !== JSON.stringify(previous) || profile.source_system === null;
      if (changed.length > 0 || stamp) {
        const assignments = sets.map(([column], index) => `${column} = $${index + 5}`);
        const { rows: [saved] } = await db.query<{ version: number }>(
          `UPDATE nzi_console.organisation_profiles SET ${[...assignments, "logo_asset_id = coalesce($4, logo_asset_id)"].join(", ")},
                  source_system = $2, legacy_values = $3::jsonb, version = version + 1, updated_at = now(), updated_by = $${sets.length + 5}
            WHERE organisation_id = $1 RETURNING version`,
          [organisationId, SOURCE_SYSTEM, JSON.stringify(legacy), logoAssetId, ...sets.map(([, value]) => value), runId]);
        outcome.version.after = saved!.version;
        await db.query(
          `INSERT INTO nzi_console.audit_events (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, reason, before_json, after_json)
           VALUES ($1, $2, $3, 'system', 'organisation.profile.imported', 'organisation', $1, $4, $5, $6::jsonb, $7::jsonb)`,
          [organisationId, randomUUID(), IMPORT_ACTOR, runId, "Organisation profile imported from NZ Insights Pro v7 (admin D2), fill-empty-only",
            JSON.stringify({ version: profile.version }),
            JSON.stringify({ run: runId, sourceSystem: SOURCE_SYSTEM, version: saved!.version, changed,
              differs: outcome.fields.filter((entry) => entry.state === "differs").map((entry) => entry.field) })]);
      }
      if (!options.commit) throw new DryRunRollback();
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  }
  return outcome;
}
