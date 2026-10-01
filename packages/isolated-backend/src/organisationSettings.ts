import { createHash, randomUUID } from "node:crypto";
import {
  formatSortCode, maskAccountNumber, maskSortCode, normaliseBank, normaliseProfile, organisationFooter, organisationShortName, ORGANISATION_BANK_FIELDS, ORGANISATION_PROFILE_FIELDS,
  type CapabilityGrant, type CommandContext, type CommandInputMap, type OrganisationBankFields, type OrganisationProfileFields,
} from "@nzi/contracts";
import { capabilityScope } from "./access";
import { AuthorizationError } from "./auth";
import { inspectClientLogo, type ClientLogoAsset } from "./clientLogo";
import { VersionConflictError } from "./errors";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";
import type { PoolLike, Queryable } from "./postgres";

/**
 * Organisation settings (admin Phase D, D1; ruled `phaseD-org-settings-plan.md`). The company profile (typed, one
 * provisioned row per organisation), its logo (0068's asset pattern), its bank details (apart), and the intensity
 * metrics a new client starts with — all `admin.settings`.
 *
 * - **The profile read never touches the bank table** (Q2). Bank details are read by `readOrganisationBank` alone, which
 *   checks `admin.settings` itself and masks unless asked to reveal (the screen's explicit "Show" route).
 * - **No command payload carries a bank value** — nor, by the same discipline, a profile value: every result (and so
 *   every audit event, idempotency record and outbox event) names the fields changed and the version. The record is
 *   the row; the audit says who changed which field, when and why.
 * - **The footer is derived** (Q11): `organisationFooter`, unless the override is set.
 * - **The signatory is a membership** (Q6), named from the membership, and must be active when chosen.
 * - **Intensity defaults** are versioned and append-only, like a client's own metrics. `client.create` applies the active
 *   ones; existing clients with none get them only through `organisation.intensityDefaults.apply` (Q5), for the count
 *   the admin confirmed.
 */

// ── Reads ─────────────────────────────────────────────────────────────────────────────────────────────────────

type ProfileRow = {
  legal_name: string | null; display_name: string | null; short_name: string | null; registration_number: string | null; vat_number: string | null;
  address_line_1: string | null; address_line_2: string | null; address_city: string | null; address_region: string | null; address_postcode: string | null;
  address_country: string | null; contact_email: string | null; contact_phone: string | null; website_url: string | null; footer_override: string | null;
  signatory_user_id: string | null; signatory_title: string | null; logo_asset_id: string | null; version: number; updated_at: Date; updated_by: string;
  source_system: string | null;
};
const PROFILE_COLUMNS = `legal_name, display_name, short_name, registration_number, vat_number, address_line_1, address_line_2, address_city, address_region,
  address_postcode, address_country, contact_email, contact_phone, website_url, footer_override, signatory_user_id, signatory_title, logo_asset_id,
  version, updated_at, updated_by, source_system`;
const COLUMN: Record<keyof OrganisationProfileFields, keyof ProfileRow> = {
  legalName: "legal_name", displayName: "display_name", shortName: "short_name", registrationNumber: "registration_number", vatNumber: "vat_number",
  addressLine1: "address_line_1", addressLine2: "address_line_2", addressCity: "address_city", addressRegion: "address_region",
  addressPostcode: "address_postcode", addressCountry: "address_country", contactEmail: "contact_email", contactPhone: "contact_phone",
  websiteUrl: "website_url", footerOverride: "footer_override", signatoryUserId: "signatory_user_id", signatoryTitle: "signatory_title",
};
const fieldsOf = (row: ProfileRow): OrganisationProfileFields =>
  Object.fromEntries(ORGANISATION_PROFILE_FIELDS.map((key) => [key, row[COLUMN[key]] as string | null])) as OrganisationProfileFields;

export type OrganisationProfileView = {
  organisationId: string; organisationName: string;
  fields: OrganisationProfileFields;
  /** The footer consumers print: the override, or derived from the profile (Q11). */
  footer: string; footerDerived: boolean;
  logo: { assetId: string; fileName: string; contentType: string; byteSize: number } | null;
  signatory: { userId: string; name: string; active: boolean } | null;
  version: number; updatedAt: string; updatedBy: string; provenance: "v7" | "console";
};

export async function readOrganisationProfile(db: Queryable, organisationId: string): Promise<OrganisationProfileView | null> {
  // Not joined to `organisations`: the application role cannot read it, and 0142 provisioned display_name from its name.
  const { rows: [row] } = await db.query<ProfileRow>(`SELECT ${PROFILE_COLUMNS} FROM nzi_console.organisation_profiles WHERE organisation_id = $1`, [organisationId]);
  if (!row) return null;
  const fields = fieldsOf(row);
  const { rows: [logo] } = row.logo_asset_id ? await db.query<{ asset_id: string; file_name: string; content_type: string; byte_size: number }>(
    `SELECT asset_id, file_name, content_type, byte_size FROM nzi_console.organisation_logo_assets WHERE organisation_id = $1 AND asset_id = $2`,
    [organisationId, row.logo_asset_id]) : { rows: [] };
  const { rows: [signatory] } = row.signatory_user_id ? await db.query<{ display_name: string | null; status: string }>(
    `SELECT display_name, status FROM nzi_console.memberships WHERE organisation_id = $1 AND user_id = $2`, [organisationId, row.signatory_user_id]) : { rows: [] };
  const { rows: [actor] } = await db.query<{ display_name: string | null }>(
    `SELECT display_name FROM nzi_console.memberships WHERE organisation_id = $1 AND user_id = $2`, [organisationId, row.updated_by]);
  return {
    organisationId, organisationName: fields.displayName ?? fields.legalName ?? organisationId, fields,
    footer: organisationFooter(fields), footerDerived: fields.footerOverride === null,
    logo: logo ? { assetId: logo.asset_id, fileName: logo.file_name, contentType: logo.content_type, byteSize: logo.byte_size } : null,
    signatory: row.signatory_user_id ? { userId: row.signatory_user_id, name: signatory?.display_name?.trim() || row.signatory_user_id, active: signatory?.status === "active" } : null,
    version: row.version, updatedAt: row.updated_at.toISOString(), updatedBy: actor?.display_name?.trim() || row.updated_by,
    provenance: row.source_system ? "v7" : "console",
  };
}

/** What a client-facing surface names the organisation with (D3): names, footer and whether there is a logo — never the bank details. */
export type OrganisationBrand = { displayName: string; shortName: string; legalName: string; footer: string; logoAssetId: string | null };

export async function readOrganisationBrand(db: Queryable, organisationId: string): Promise<OrganisationBrand> {
  const profile = await readOrganisationProfile(db, organisationId);
  if (!profile) throw new Error(`${organisationId} has no organisation profile; 0142 provisions one.`);
  const displayName = profile.fields.displayName ?? profile.fields.legalName ?? organisationId;
  return {
    displayName, shortName: organisationShortName(profile.fields) || displayName, legalName: profile.fields.legalName ?? displayName,
    footer: profile.footer || displayName, logoAssetId: profile.logo?.assetId ?? null,
  };
}

export type OrganisationBankView = {
  version: number; configured: boolean; revealed: boolean;
  accountName: string | null; sortCode: string | null; accountNumber: string | null; updatedAt: string;
};

/** The bank details — admin.settings only, refused (never emptied) without it; masked unless `reveal`. */
export async function readOrganisationBank(db: Queryable, holder: { capabilities: readonly CapabilityGrant[] }, organisationId: string, options: { reveal: boolean }): Promise<OrganisationBankView> {
  if (capabilityScope(holder, "admin.settings") === null) throw new AuthorizationError("admin.settings", "The organisation's bank details need admin.settings.");
  const { rows: [row] } = await db.query<{ account_name: string | null; sort_code: string | null; account_number: string | null; version: number; updated_at: Date }>(
    `SELECT account_name, sort_code, account_number, version, updated_at FROM nzi_console.organisation_bank_details WHERE organisation_id = $1`, [organisationId]);
  if (!row) throw new Error("The organisation has no bank-details row; 0142 provisions one.");
  return {
    version: row.version, configured: row.account_number !== null, revealed: options.reveal,
    accountName: row.account_name,
    sortCode: options.reveal ? formatSortCode(row.sort_code) : maskSortCode(row.sort_code),
    accountNumber: options.reveal ? row.account_number : maskAccountNumber(row.account_number),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** The organisation's current logo, for `logoResponse` — or null (the monogram). */
export async function readOrganisationLogo(db: Queryable, organisationId: string): Promise<ClientLogoAsset | null> {
  const { rows: [row] } = await db.query<{ asset_id: string; content_type: ClientLogoAsset["contentType"]; sha256: string; content: Buffer }>(
    `SELECT a.asset_id, a.content_type, a.sha256, a.content FROM nzi_console.organisation_profiles p
       JOIN nzi_console.organisation_logo_assets a ON (a.organisation_id, a.asset_id) = (p.organisation_id, p.logo_asset_id)
      WHERE p.organisation_id = $1`, [organisationId]);
  return row ? { assetId: row.asset_id, contentType: row.content_type, sha256: row.sha256, content: row.content } : null;
}

/** One logo asset by id — the logo frozen onto a report version (0143), which may no longer be the current one. */
export async function readOrganisationLogoAsset(db: Queryable, organisationId: string, assetId: string): Promise<ClientLogoAsset | null> {
  const { rows: [row] } = await db.query<{ asset_id: string; content_type: ClientLogoAsset["contentType"]; sha256: string; content: Buffer }>(
    `SELECT asset_id, content_type, sha256, content FROM nzi_console.organisation_logo_assets WHERE organisation_id = $1 AND asset_id = $2`,
    [organisationId, assetId]);
  return row ? { assetId: row.asset_id, contentType: row.content_type, sha256: row.sha256, content: row.content } : null;
}

export type IntensityDefault = {
  metricKey: string; version: number; label: string; unitWording: string; divider: number; iconKey: string;
  /** `currency`: counts the client's currency; the defaults list reads it in GBP until Phase E (D3, Q4). */
  unitKind: "text" | "currency";
  isStandard: boolean; valueSource: "entered" | "site-floor-area"; active: boolean; ordering: number;
};
type DefaultRow = { metric_key: string; version: number; label: string; unit_wording: string; divider: number; icon_key: string; is_standard: boolean; value_source: "entered" | "site-floor-area"; active: boolean; ordering: number; unit_kind?: "text" | "currency" };
const toDefault = (row: DefaultRow): IntensityDefault => ({
  metricKey: row.metric_key, version: row.version, label: row.label, unitWording: row.unit_wording, divider: row.divider, iconKey: row.icon_key,
  unitKind: row.unit_kind ?? "text", isStandard: row.is_standard, valueSource: row.value_source, active: row.active, ordering: row.ordering,
});

/** Each default metric at its latest version, in order — active and inactive. */
export async function listIntensityDefaults(db: Queryable, organisationId: string): Promise<IntensityDefault[]> {
  const { rows } = await db.query<DefaultRow>(
    `SELECT DISTINCT ON (metric_key) metric_key, version, label, unit_wording, divider, icon_key, is_standard, value_source, active, ordering, unit_kind
       FROM nzi_console.organisation_intensity_metric_defaults WHERE organisation_id = $1 ORDER BY metric_key, version DESC`, [organisationId]);
  return rows.map(toDefault).sort((a, b) => a.ordering - b.ordering || a.metricKey.localeCompare(b.metricKey));
}

/** How many clients have no intensity metric at all — what the apply action would reach. */
export async function countClientsWithoutMetrics(db: Queryable, organisationId: string): Promise<number> {
  const { rows: [row] } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM nzi_console.clients c WHERE c.organisation_id = $1
        AND NOT EXISTS (SELECT 1 FROM nzi_console.client_intensity_metrics m WHERE (m.organisation_id, m.client_id) = (c.organisation_id, c.client_id))`, [organisationId]);
  return row?.n ?? 0;
}

export type OrganisationHistoryEntry = { action: string; at: string; actor: string; reason: string | null; changed: string[] };

/** The organisation record's audit history (profile, logo, bank, defaults), newest first. Field names only. */
export async function readOrganisationHistory(db: Queryable, organisationId: string): Promise<OrganisationHistoryEntry[]> {
  const { rows } = await db.query<{ action: string; occurred_at: Date; actor_id: string; actor_name: string | null; reason: string | null; after_json: { changed?: string[]; metricKey?: string } | null }>(
    `SELECT a.action, a.occurred_at, a.actor_id, nullif(btrim(m.display_name), '') AS actor_name, a.reason, a.after_json
       FROM nzi_console.audit_events a
       LEFT JOIN nzi_console.memberships m ON (m.organisation_id, m.user_id) = (a.organisation_id, a.actor_id)
      WHERE a.organisation_id = $1 AND a.entity_type = 'organisation' AND a.action LIKE 'organisation.%'
      ORDER BY a.occurred_at DESC, a.audit_event_id DESC LIMIT 40`, [organisationId]);
  return rows.map((row) => ({ action: row.action, at: row.occurred_at.toISOString(), actor: row.actor_name ?? row.actor_id, reason: row.reason,
    changed: row.after_json?.changed ?? (row.after_json?.metricKey ? [row.after_json.metricKey] : []) }));
}

// ── Commands ──────────────────────────────────────────────────────────────────────────────────────────────────

/** What every organisation command returns — and so what its audit event records: which fields, which version. Never a value. */
export type OrganisationResult = { organisationId: string; version: number; changed: string[] };

export function updateOrganisationProfile(pool: PoolLike, input: CommandInputMap["organisation.profile.update"], context: CommandContext): Promise<StoredOutcome<OrganisationResult>> {
  return runPostgresCommand(pool, "organisation.profile.update", input, context, async (db) => {
    const org = context.organisationId;
    const { rows: [row] } = await db.query<ProfileRow>(`SELECT ${PROFILE_COLUMNS} FROM nzi_console.organisation_profiles WHERE organisation_id = $1 FOR UPDATE`, [org]);
    if (!row) throw new CommandValidationError([{ field: "organisationId", code: "NOT_FOUND", message: "This organisation has no profile row; 0142 provisions one." }]);
    if (row.version !== input.expectedVersion) throw new VersionConflictError(input.expectedVersion, row.version);
    const next = normaliseProfile(input);
    const current = fieldsOf(row);
    const changed = ORGANISATION_PROFILE_FIELDS.filter((key) => next[key] !== current[key]);
    if (changed.length === 0) throw new CommandValidationError([{ field: "organisationId", code: "NO_CHANGE", message: "Nothing to change." }]);
    if (next.signatoryUserId !== null && next.signatoryUserId !== current.signatoryUserId) {
      const { rows: [member] } = await db.query<{ status: string }>(`SELECT status FROM nzi_console.memberships WHERE organisation_id = $1 AND user_id = $2`, [org, next.signatoryUserId]);
      if (!member) throw new CommandValidationError([{ field: "signatoryUserId", code: "NOT_FOUND", message: "The signatory must be a member of staff here." }]);
      if (member.status !== "active") throw new CommandValidationError([{ field: "signatoryUserId", code: "INACTIVE", message: "The signatory must be an active member of staff." }]);
    }
    const values = ORGANISATION_PROFILE_FIELDS.map((key) => next[key]);
    const { rows: [saved] } = await db.query<{ version: number }>(
      `UPDATE nzi_console.organisation_profiles SET ${ORGANISATION_PROFILE_FIELDS.map((key, index) => `${COLUMN[key]} = $${index + 2}`).join(", ")},
              version = version + 1, updated_at = now(), updated_by = $${values.length + 2}
        WHERE organisation_id = $1 RETURNING version`, [org, ...values, context.actorId]);
    return { data: { organisationId: org, version: saved!.version, changed }, entityType: "organisation", entityId: org, topic: "organisation.profile.updated", before: { version: row.version } };
  });
}

export function setOrganisationLogo(pool: PoolLike, input: CommandInputMap["organisation.logo.set"], context: CommandContext): Promise<StoredOutcome<OrganisationResult & { assetId: string; byteSize: number; sha256: string }>> {
  return runPostgresCommand(pool, "organisation.logo.set", input, context, async (db) => {
    const org = context.organisationId;
    // The same inspector as a client's logo: a real PNG, or an SVG with no script and no external reference.
    const { bytes, issues } = inspectClientLogo(input.contentType, input.dataBase64);
    if (issues.length) throw new CommandValidationError(issues.map((message) => ({ field: "dataBase64", code: "INVALID_LOGO", message })));
    const { rows: [prior] } = await db.query<{ logo_asset_id: string | null; version: number }>(`SELECT logo_asset_id, version FROM nzi_console.organisation_profiles WHERE organisation_id = $1 FOR UPDATE`, [org]);
    const assetId = randomUUID();
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await db.query(
      `INSERT INTO nzi_console.organisation_logo_assets (organisation_id, asset_id, file_name, content_type, byte_size, sha256, content, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [org, assetId, input.fileName.trim().slice(0, 200), input.contentType, bytes.length, sha256, bytes, context.actorId]);
    const { rows: [saved] } = await db.query<{ version: number }>(
      `UPDATE nzi_console.organisation_profiles SET logo_asset_id = $2, version = version + 1, updated_at = now(), updated_by = $3 WHERE organisation_id = $1 RETURNING version`,
      [org, assetId, context.actorId]);
    return {
      data: { organisationId: org, version: saved!.version, changed: ["logo"], assetId, byteSize: bytes.length, sha256 },
      entityType: "organisation", entityId: org, topic: "organisation.logo.set", before: { version: prior?.version ?? null, logoAssetId: prior?.logo_asset_id ?? null },
    };
  });
}

/** Clears the pointer; the asset stays (append-only) for the audit trail, as a client logo's does. */
export function removeOrganisationLogo(pool: PoolLike, input: CommandInputMap["organisation.logo.remove"], context: CommandContext): Promise<StoredOutcome<OrganisationResult>> {
  return runPostgresCommand(pool, "organisation.logo.remove", input, context, async (db) => {
    const org = context.organisationId;
    const { rows: [prior] } = await db.query<{ logo_asset_id: string | null; version: number }>(`SELECT logo_asset_id, version FROM nzi_console.organisation_profiles WHERE organisation_id = $1 FOR UPDATE`, [org]);
    if (!prior?.logo_asset_id) throw new CommandValidationError([{ field: "logo", code: "NO_LOGO", message: "There is no logo to remove." }]);
    const { rows: [saved] } = await db.query<{ version: number }>(
      `UPDATE nzi_console.organisation_profiles SET logo_asset_id = NULL, version = version + 1, updated_at = now(), updated_by = $2 WHERE organisation_id = $1 RETURNING version`, [org, context.actorId]);
    return { data: { organisationId: org, version: saved!.version, changed: ["logo"] }, entityType: "organisation", entityId: org, topic: "organisation.logo.removed", before: { version: prior.version, logoAssetId: prior.logo_asset_id } };
  });
}

/** The bank details: whole or cleared, under their own version, always with a reason — and never a value in the payload (Q2). */
export function setOrganisationBank(pool: PoolLike, input: CommandInputMap["organisation.bank.set"], context: CommandContext): Promise<StoredOutcome<OrganisationResult & { configured: boolean }>> {
  return runPostgresCommand(pool, "organisation.bank.set", input, context, async (db) => {
    const org = context.organisationId;
    const { rows: [row] } = await db.query<{ account_name: string | null; sort_code: string | null; account_number: string | null; version: number }>(
      `SELECT account_name, sort_code, account_number, version FROM nzi_console.organisation_bank_details WHERE organisation_id = $1 FOR UPDATE`, [org]);
    if (!row) throw new CommandValidationError([{ field: "organisationId", code: "NOT_FOUND", message: "This organisation has no bank-details row; 0142 provisions one." }]);
    if (row.version !== input.expectedVersion) throw new VersionConflictError(input.expectedVersion, row.version);
    const next: OrganisationBankFields = normaliseBank(input);
    const current: OrganisationBankFields = { accountName: row.account_name, sortCode: row.sort_code, accountNumber: row.account_number };
    const changed = ORGANISATION_BANK_FIELDS.filter((key) => next[key] !== current[key]);
    if (changed.length === 0) throw new CommandValidationError([{ field: "organisationId", code: "NO_CHANGE", message: "Nothing to change." }]);
    const { rows: [saved] } = await db.query<{ version: number }>(
      `UPDATE nzi_console.organisation_bank_details SET account_name = $2, sort_code = $3, account_number = $4, version = version + 1, updated_at = now(), updated_by = $5
        WHERE organisation_id = $1 RETURNING version`, [org, next.accountName, next.sortCode, next.accountNumber, context.actorId]);
    return {
      data: { organisationId: org, version: saved!.version, changed, configured: next.accountNumber !== null },
      entityType: "organisation", entityId: org, topic: "organisation.bank.set", before: { version: row.version, configured: row.account_number !== null },
    };
  });
}

/** The latest version of one default, with its writers serialised — an advisory lock, since the table is append-only (no UPDATE, so no row lock). */
async function latestDefault(db: Queryable, org: string, metricKey: string): Promise<DefaultRow | null> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('intensity-default:' || $1 || ':' || $2, 0))`, [org, metricKey]);
  const { rows: [row] } = await db.query<DefaultRow>(
    `SELECT metric_key, version, label, unit_wording, divider, icon_key, is_standard, value_source, active, ordering, unit_kind
       FROM nzi_console.organisation_intensity_metric_defaults WHERE organisation_id = $1 AND metric_key = $2 ORDER BY version DESC LIMIT 1`, [org, metricKey]);
  return row ?? null;
}

/** Define or redefine one default. A standard metric keeps its identity; only wording, divider, icon and order move. */
export function setIntensityDefault(pool: PoolLike, input: CommandInputMap["organisation.intensityDefault.set"], context: CommandContext): Promise<StoredOutcome<OrganisationResult & { metricKey: string }>> {
  return runPostgresCommand(pool, "organisation.intensityDefault.set", input, context, async (db) => {
    const org = context.organisationId;
    const previous = await latestDefault(db, org, input.metricKey);
    if ((previous?.version ?? 0) !== input.expectedVersion) throw new VersionConflictError(input.expectedVersion, previous?.version ?? 0);
    const version = (previous?.version ?? 0) + 1;
    await db.query(
      `INSERT INTO nzi_console.organisation_intensity_metric_defaults
         (organisation_id, metric_key, version, label, unit_wording, divider, icon_key, is_standard, value_source, active, ordering, set_by, correlation_id, unit_kind)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10, $11, $12, $13)`,
      [org, input.metricKey, version, input.label.trim(), input.unitWording.trim(), input.divider, input.iconKey, previous?.is_standard ?? false,
        previous?.value_source ?? "entered", input.ordering ?? previous?.ordering ?? 99, context.actorId, context.correlationId, input.unitKind ?? previous?.unit_kind ?? "text"]);
    return {
      data: { organisationId: org, version, changed: previous ? ["label", "unitWording", "divider", "iconKey", "ordering", "unitKind"].filter((field) => {
        const was = { label: previous.label, unitWording: previous.unit_wording, divider: previous.divider, iconKey: previous.icon_key, ordering: previous.ordering, unitKind: previous.unit_kind ?? "text" } as Record<string, unknown>;
        const now = { label: input.label.trim(), unitWording: input.unitWording.trim(), divider: input.divider, iconKey: input.iconKey, ordering: input.ordering ?? previous.ordering, unitKind: input.unitKind ?? previous.unit_kind ?? "text" } as Record<string, unknown>;
        return was[field] !== now[field];
      }).concat(previous.active ? [] : ["active"]) : ["created"], metricKey: input.metricKey },
      entityType: "organisation", entityId: org, topic: "organisation.intensity_default.set", before: previous ? { version: previous.version, active: previous.active } : undefined,
    };
  });
}

export function deactivateIntensityDefault(pool: PoolLike, input: CommandInputMap["organisation.intensityDefault.deactivate"], context: CommandContext): Promise<StoredOutcome<OrganisationResult & { metricKey: string }>> {
  return runPostgresCommand(pool, "organisation.intensityDefault.deactivate", input, context, async (db) => {
    const org = context.organisationId;
    const previous = await latestDefault(db, org, input.metricKey);
    if (!previous) throw new CommandValidationError([{ field: "metricKey", code: "NOT_FOUND", message: "That default metric is not defined." }]);
    if (previous.version !== input.expectedVersion) throw new VersionConflictError(input.expectedVersion, previous.version);
    if (!previous.active) throw new CommandValidationError([{ field: "metricKey", code: "ALREADY_INACTIVE", message: "That default is already inactive." }]);
    const version = previous.version + 1;
    await db.query(
      `INSERT INTO nzi_console.organisation_intensity_metric_defaults
         (organisation_id, metric_key, version, label, unit_wording, divider, icon_key, is_standard, value_source, active, ordering, set_by, correlation_id, unit_kind)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, $10, $11, $12, $13)`,
      [org, input.metricKey, version, previous.label, previous.unit_wording, previous.divider, previous.icon_key, previous.is_standard, previous.value_source,
        previous.ordering, context.actorId, context.correlationId, previous.unit_kind ?? "text"]);
    return { data: { organisationId: org, version, changed: ["active"], metricKey: input.metricKey }, entityType: "organisation", entityId: org,
      topic: "organisation.intensity_default.deactivated", before: { version: previous.version, active: true } };
  });
}

/**
 * The organisation's active defaults onto one new client, as its version-1 metrics — called by `client.create`, inside
 * its transaction. A client that already has metrics is never touched.
 */
export async function applyIntensityDefaultsToClient(db: Queryable, org: string, clientId: string, actorId: string, correlationId: string): Promise<number> {
  const inserted = await db.query(
    `INSERT INTO nzi_console.client_intensity_metrics
       (organisation_id, client_id, metric_key, version, label, unit_wording, divider, icon_key, is_standard, value_source, active, ordering, set_by, correlation_id, unit_kind)
     SELECT $1, $2, d.metric_key, 1, d.label, d.unit_wording, d.divider, d.icon_key, d.is_standard, d.value_source, true, d.ordering, $3, $4, d.unit_kind
       FROM (SELECT DISTINCT ON (metric_key) * FROM nzi_console.organisation_intensity_metric_defaults WHERE organisation_id = $1 ORDER BY metric_key, version DESC) d
      WHERE d.active
        AND NOT EXISTS (SELECT 1 FROM nzi_console.client_intensity_metrics m WHERE (m.organisation_id, m.client_id) = ($1, $2))
     RETURNING metric_key`, [org, clientId, actorId, correlationId]);
  return inserted.rows.length;
}

/**
 * Q5: the defaults onto every client with no intensity metric — only when that is still the number the admin was shown
 * and confirmed (`expectedClients`); otherwise refused, and nothing is written. One audit event, with the counts.
 */
export function applyIntensityDefaults(pool: PoolLike, input: CommandInputMap["organisation.intensityDefaults.apply"], context: CommandContext): Promise<StoredOutcome<OrganisationResult & { clients: number; metrics: number }>> {
  return runPostgresCommand(pool, "organisation.intensityDefaults.apply", input, context, async (db) => {
    const org = context.organisationId;
    // Serialise against a concurrent apply or client.create: the count, then the writes, see the same clients.
    await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('intensity-defaults-apply:' || $1, 0))`, [org]);
    const { rows: targets } = await db.query<{ client_id: string }>(
      `SELECT c.client_id FROM nzi_console.clients c WHERE c.organisation_id = $1
          AND NOT EXISTS (SELECT 1 FROM nzi_console.client_intensity_metrics m WHERE (m.organisation_id, m.client_id) = (c.organisation_id, c.client_id))
        ORDER BY c.client_id FOR UPDATE OF c`, [org]);
    if (targets.length !== input.expectedClients) {
      throw new CommandValidationError([{ field: "expectedClients", code: "COUNT_CHANGED", message: `${targets.length} clients have no intensity metric now, not ${input.expectedClients}. Review the number and confirm again.` }]);
    }
    const active = (await listIntensityDefaults(db, org)).filter((entry) => entry.active);
    if (active.length === 0) throw new CommandValidationError([{ field: "organisationId", code: "NO_DEFAULTS", message: "There are no active default metrics to apply." }]);
    let metrics = 0;
    for (const target of targets) metrics += await applyIntensityDefaultsToClient(db, org, target.client_id, context.actorId, context.correlationId);
    return {
      data: { organisationId: org, version: 0, changed: active.map((entry) => entry.metricKey), clients: targets.length, metrics },
      entityType: "organisation", entityId: org, topic: "organisation.intensity_defaults.applied",
    };
  });
}
