import { randomUUID } from "node:crypto";
import {
  supplierListSpec,
  type CommandContext, type CommandInputMap, type ListPage, type SupplierListFilterKey, type SupplierListQuery, type SupplierListSortKey,
} from "@nzi/contracts";
import { VersionConflictError } from "./errors";
import { defineListSql, readListPage } from "./listPage";
import { sealSupplierContactRow } from "./piiWriteThrough";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";
import type { PoolLike, Queryable } from "./postgres";

/**
 * Suppliers and their rate card (admin Phase E4; ruled `phaseE-commercial-catalogue-plan.md`, E-Q6–E-Q9): 0148's
 * `suppliers`, `supplier_contacts` and `supplier_service_items`, through the command runner — never deleted (R3).
 *
 * - **The company** (admin.lookups): a name unique per organisation, case-insensitively, inactive included; a website.
 * - **Its people** (admin.lookups; E-Q6): written in plaintext and sealed under the contact's own subject key in the same
 *   transaction (NZC-119), so each is erasable by key-shred on its own. A contact command's result — and so its audit
 *   event, idempotency record and outbox payload — says **which** fields were set, never their values.
 * - **The rate card** (admin.lookups for the line; finance.manage for the agreed rate, E-Q8): the rate is written only by
 *   `supplier_item.rate.set`, whose result says it was set or cleared, never the figure (NZC-120); a reader without
 *   finance.manage is given `rate: null`, never 0. One currency (E-Q9).
 * - **References** — a unit must be a `units_of_measure` value, a VAT rate one of E1's; each active to be chosen, and one
 *   a line already holds still stands (R3). A contact or a line is added only to an active supplier.
 */

const blank = (value: string | null | undefined) => { const trimmed = value?.trim(); return trimmed ? trimmed : null; };
const cleanName = (value: string) => value.trim().replace(/\s+/g, " ");
const iso = (date: unknown) => date instanceof Date ? date.toISOString() : String(date);
const amount = (value: unknown) => value === null || value === undefined ? null : Number(value);
const nullable = (value: unknown) => value === null || value === undefined ? null : String(value);

export type SupplierProvenance = "v7" | "added";
const PROVENANCE = `CASE WHEN source_system IS NOT NULL THEN 'v7' ELSE 'added' END`;

// ── The list ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type SupplierRow = {
  supplierId: string; name: string; website: string | null; active: boolean; version: number; provenance: SupplierProvenance; updatedAt: string;
  /** Active contacts and active rate-card lines. */
  contacts: number; items: number;
};
export type SupplierPage = ListPage<SupplierRow, SupplierListFilterKey, Record<string, never>>;

const supplierSql = defineListSql<SupplierListSortKey, SupplierListFilterKey>({
  base: `SELECT s.organisation_id, s.supplier_id, s.name, s.website, s.active, s.version, s.updated_at,
      CASE WHEN s.active THEN 'active' ELSE 'inactive' END AS status,
      CASE WHEN s.source_system IS NOT NULL THEN 'v7' ELSE 'added' END AS provenance,
      (SELECT count(*) FROM nzi_console.supplier_contacts c WHERE (c.organisation_id, c.supplier_id) = (s.organisation_id, s.supplier_id) AND c.active)::int AS contacts,
      (SELECT count(*) FROM nzi_console.supplier_service_items i WHERE (i.organisation_id, i.supplier_id) = (s.organisation_id, s.supplier_id) AND i.active)::int AS items
    FROM nzi_console.suppliers s`,
  search: ["name"],
  filters: { status: { kind: "equals", column: "status", facet: { noneLabel: "—", values: ["active", "inactive"] } } },
  sort: { name: { column: "name", text: true }, contacts: { column: "contacts" }, items: { column: "items" }, status: { column: "status", text: true } },
  tiebreak: "supplier_id",
});

export async function listSuppliersPage(db: Queryable, query: SupplierListQuery): Promise<SupplierPage> {
  return readListPage(db, supplierSql, supplierListSpec, query, {
    mapRow: (row) => ({
      supplierId: String(row.supplier_id), name: String(row.name), website: nullable(row.website), active: row.active === true,
      version: Number(row.version), provenance: row.provenance as SupplierProvenance, updatedAt: iso(row.updated_at),
      contacts: Number(row.contacts), items: Number(row.items),
    }),
    mapSummary: () => ({}),
  });
}

// ── Suppliers' people and rate cards, for the drawer ──────────────────────────────────────────────────────────────────

export type SupplierContactRow = {
  contactId: string;
  /** Null once erased (the plaintext is nulled and the key shredded) — shown as such, never as blank. */
  fullName: string | null; email: string | null; phone: string | null;
  erased: boolean; active: boolean; version: number; provenance: SupplierProvenance;
};
export type SupplierItemRow = {
  serviceItemId: string; costType: string | null; name: string; description: string | null;
  unitValueId: string | null; unit: string | null; vatRateId: string | null; vatRate: string | null; currency: string;
  /** Null when the reader may not see it (finance.manage) — never 0 for "hidden". Within, null is "not yet agreed". */
  rate: { agreedRate: number | null } | null;
  active: boolean; version: number; provenance: SupplierProvenance;
};
export type SupplierParts = { contacts: SupplierContactRow[]; items: SupplierItemRow[] };
export type SupplierDetail = SupplierParts & { supplier: SupplierRow };

/**
 * The contacts and rate card of the suppliers named — a page's worth, in two queries. Contacts are read in plaintext, as
 * every screen reads personal data (NZC-119: the sealed copy serves export and erasure); an erased one reads as such.
 */
export async function readSupplierParts(db: Queryable, organisationId: string, supplierIds: readonly string[], options: { showRates: boolean }): Promise<Record<string, SupplierParts>> {
  const parts: Record<string, SupplierParts> = Object.fromEntries(supplierIds.map((id) => [id, { contacts: [], items: [] }]));
  if (supplierIds.length === 0) return parts;
  const [contacts, items] = await Promise.all([
    db.query<Record<string, unknown>>(
      `SELECT supplier_id, contact_id, full_name, email, phone, (full_name IS NULL AND full_name_sealed IS NOT NULL) AS erased, active, version, ${PROVENANCE} AS provenance
         FROM nzi_console.supplier_contacts WHERE organisation_id = $1 AND supplier_id = ANY($2::text[]) ORDER BY active DESC, lower(full_name) NULLS LAST, contact_id`,
      [organisationId, supplierIds]),
    db.query<Record<string, unknown>>(
      `SELECT i.supplier_id, i.service_item_id, i.cost_type, i.name, i.description, i.unit_value_id, uom.label AS unit, i.vat_rate_id,
              vat.name || ' · ' || trim_scale(vat.rate_pct)::text || '%' AS vat_rate, i.currency_code, i.agreed_rate::text AS agreed_rate,
              i.active, i.version, CASE WHEN i.source_system IS NOT NULL THEN 'v7' ELSE 'added' END AS provenance
         FROM nzi_console.supplier_service_items i
         LEFT JOIN nzi_console.reference_values uom ON (uom.organisation_id, uom.value_id) = (i.organisation_id, i.unit_value_id)
         LEFT JOIN nzi_console.vat_rates vat ON (vat.organisation_id, vat.vat_rate_id) = (i.organisation_id, i.vat_rate_id)
        WHERE i.organisation_id = $1 AND i.supplier_id = ANY($2::text[]) ORDER BY i.active DESC, lower(i.cost_type) NULLS LAST, lower(i.name), i.service_item_id`,
      [organisationId, supplierIds]),
  ]);
  for (const row of contacts.rows) parts[String(row.supplier_id)]?.contacts.push({
    contactId: String(row.contact_id), fullName: nullable(row.full_name), email: nullable(row.email), phone: nullable(row.phone),
    erased: row.erased === true, active: row.active === true, version: Number(row.version), provenance: row.provenance as SupplierProvenance,
  });
  for (const row of items.rows) parts[String(row.supplier_id)]?.items.push({
    serviceItemId: String(row.service_item_id), costType: nullable(row.cost_type), name: String(row.name), description: nullable(row.description),
    unitValueId: nullable(row.unit_value_id), unit: nullable(row.unit), vatRateId: nullable(row.vat_rate_id), vatRate: nullable(row.vat_rate),
    currency: String(row.currency_code), rate: options.showRates ? { agreedRate: amount(row.agreed_rate) } : null,
    active: row.active === true, version: Number(row.version), provenance: row.provenance as SupplierProvenance,
  });
  return parts;
}

/** One supplier, whole. */
export async function readSupplier(db: Queryable, organisationId: string, supplierId: string, options: { showRates: boolean }): Promise<SupplierDetail | null> {
  const { rows: [supplier] } = await db.query<Record<string, unknown>>(
    `SELECT supplier_id, name, website, active, version, updated_at, ${PROVENANCE} AS provenance,
       (SELECT count(*) FROM nzi_console.supplier_contacts c WHERE c.organisation_id = s.organisation_id AND c.supplier_id = s.supplier_id AND c.active)::int AS contacts,
       (SELECT count(*) FROM nzi_console.supplier_service_items i WHERE i.organisation_id = s.organisation_id AND i.supplier_id = s.supplier_id AND i.active)::int AS items
     FROM nzi_console.suppliers s WHERE organisation_id = $1 AND supplier_id = $2`, [organisationId, supplierId]);
  if (!supplier) return null;
  const parts = await readSupplierParts(db, organisationId, [supplierId], options);
  return {
    supplier: {
      supplierId: String(supplier.supplier_id), name: String(supplier.name), website: nullable(supplier.website), active: supplier.active === true,
      version: Number(supplier.version), provenance: supplier.provenance as SupplierProvenance, updatedAt: iso(supplier.updated_at),
      contacts: Number(supplier.contacts), items: Number(supplier.items),
    },
    ...parts[supplierId]!,
  };
}

// ── Commands: the company (admin.lookups) ────────────────────────────────────────────────────────────────────────

type StoredSupplier = { name: string; website: string | null; active: boolean; version: number };
type SupplierSnapshot = { name: string; website: string | null; active: boolean };
const supplierSnapshot = (row: StoredSupplier): SupplierSnapshot => ({ name: row.name, website: row.website, active: row.active });
export type SupplierResult = SupplierSnapshot & { supplierId: string; version: number };
const SUPPLIER_RETURNING = "RETURNING name, website, active, version";

async function lockSupplier(db: Queryable, context: CommandContext, supplierId: string, expectedVersion?: number): Promise<StoredSupplier> {
  const { rows: [row] } = await db.query<StoredSupplier>(
    `SELECT name, website, active, version FROM nzi_console.suppliers WHERE organisation_id = $1 AND supplier_id = $2 FOR UPDATE`, [context.organisationId, supplierId]);
  if (!row) throw new CommandValidationError([{ field: "supplierId", code: "NOT_FOUND", message: "That supplier is not here." }]);
  if (expectedVersion !== undefined && row.version !== expectedVersion) throw new VersionConflictError(expectedVersion, row.version);
  return row;
}

async function assertNameFree(db: Queryable, context: CommandContext, name: string, supplierId: string | null) {
  const { rows: [taken] } = await db.query<{ taken: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM nzi_console.suppliers WHERE organisation_id = $1 AND lower(name) = lower($2) AND supplier_id IS DISTINCT FROM $3) AS taken`,
    [context.organisationId, name, supplierId]);
  if (taken?.taken) throw new CommandValidationError([{ field: "name", code: "DUPLICATE", message: "Another supplier — active or not — already has that name." }]);
}

export function createSupplier(pool: PoolLike, input: CommandInputMap["supplier.create"], context: CommandContext): Promise<StoredOutcome<SupplierResult>> {
  return runPostgresCommand(pool, "supplier.create", input, context, async (db) => {
    const name = cleanName(input.name);
    await assertNameFree(db, context, name, null);
    const supplierId = `supplier:${randomUUID()}`;
    const { rows: [saved] } = await db.query<StoredSupplier>(
      `INSERT INTO nzi_console.suppliers (organisation_id, supplier_id, name, website, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $5) ${SUPPLIER_RETURNING}`,
      [context.organisationId, supplierId, name, blank(input.website), context.actorId]);
    return { data: { supplierId, version: saved!.version, ...supplierSnapshot(saved!) }, entityType: "supplier", entityId: supplierId, topic: "supplier.created" };
  });
}

export function updateSupplier(pool: PoolLike, input: CommandInputMap["supplier.update"], context: CommandContext): Promise<StoredOutcome<SupplierResult>> {
  return runPostgresCommand(pool, "supplier.update", input, context, async (db) => {
    const current = await lockSupplier(db, context, input.supplierId, input.expectedVersion);
    const name = cleanName(input.name);
    const website = blank(input.website);
    if (name === current.name && website === current.website) throw new CommandValidationError([{ field: "name", code: "UNCHANGED", message: "That is what the supplier already holds." }]);
    await assertNameFree(db, context, name, input.supplierId);
    const { rows: [saved] } = await db.query<StoredSupplier>(
      `UPDATE nzi_console.suppliers SET name = $3, website = $4, version = version + 1, updated_at = now(), updated_by = $5
        WHERE organisation_id = $1 AND supplier_id = $2 ${SUPPLIER_RETURNING}`,
      [context.organisationId, input.supplierId, name, website, context.actorId]);
    return { data: { supplierId: input.supplierId, version: saved!.version, ...supplierSnapshot(saved!) }, entityType: "supplier", entityId: input.supplierId,
      topic: "supplier.updated", before: supplierSnapshot(current) };
  });
}

function setSupplierActive(key: "supplier.deactivate" | "supplier.reinstate", active: boolean) {
  return (pool: PoolLike, input: CommandInputMap[typeof key], context: CommandContext): Promise<StoredOutcome<SupplierResult>> =>
    runPostgresCommand(pool, key, input, context, async (db) => {
      const current = await lockSupplier(db, context, input.supplierId, input.expectedVersion);
      if (current.active === active) throw new CommandValidationError([{ field: "supplierId", code: active ? "ALREADY_ACTIVE" : "ALREADY_INACTIVE", message: `That supplier is already ${active ? "active" : "inactive"}.` }]);
      const { rows: [saved] } = await db.query<StoredSupplier>(
        `UPDATE nzi_console.suppliers SET active = $3, version = version + 1, updated_at = now(), updated_by = $4 WHERE organisation_id = $1 AND supplier_id = $2 ${SUPPLIER_RETURNING}`,
        [context.organisationId, input.supplierId, active, context.actorId]);
      return { data: { supplierId: input.supplierId, version: saved!.version, ...supplierSnapshot(saved!) }, entityType: "supplier", entityId: input.supplierId,
        topic: active ? "supplier.reinstated" : "supplier.deactivated", before: supplierSnapshot(current) };
    });
}
/** Deactivating a supplier leaves its contacts and rate card as they are: it only stops new ones being added. */
export const deactivateSupplier = setSupplierActive("supplier.deactivate", false);
export const reinstateSupplier = setSupplierActive("supplier.reinstate", true);

async function assertSupplierOpen(db: Queryable, context: CommandContext, supplierId: string) {
  const supplier = await lockSupplier(db, context, supplierId);
  if (!supplier.active) throw new CommandValidationError([{ field: "supplierId", code: "INACTIVE", message: "That supplier is inactive; reinstate it to add to it." }]);
}

// ── Commands: the people (admin.lookups; sealed) ─────────────────────────────────────────────────────────────────

type ContactField = "fullName" | "email" | "phone";
/**
 * What a contact command returns — and so what its audit, idempotency record and outbox hold: the contact, its supplier,
 * its version and state, and **which** fields it holds or changed. Never a name, an address or a number (E-Q6).
 */
export type SupplierContactResult = { contactId: string; supplierId: string; version: number; active: boolean; fields: ContactField[] };
type StoredContact = { supplier_id: string; full_name: string | null; email: string | null; phone: string | null; active: boolean; version: number };

const contactValues = (input: { fullName: string; email?: string | null; phone?: string | null }) =>
  ({ fullName: cleanName(input.fullName), email: blank(input.email), phone: blank(input.phone) });

async function lockContact(db: Queryable, context: CommandContext, contactId: string, expectedVersion: number): Promise<StoredContact> {
  const { rows: [row] } = await db.query<StoredContact>(
    `SELECT supplier_id, full_name, email, phone, active, version FROM nzi_console.supplier_contacts WHERE organisation_id = $1 AND contact_id = $2 FOR UPDATE`,
    [context.organisationId, contactId]);
  if (!row) throw new CommandValidationError([{ field: "contactId", code: "NOT_FOUND", message: "That contact is not here." }]);
  if (row.version !== expectedVersion) throw new VersionConflictError(expectedVersion, row.version);
  return row;
}

export function addSupplierContact(pool: PoolLike, input: CommandInputMap["supplier.contact.add"], context: CommandContext): Promise<StoredOutcome<SupplierContactResult>> {
  return runPostgresCommand(pool, "supplier.contact.add", input, context, async (db) => {
    await assertSupplierOpen(db, context, input.supplierId);
    const values = contactValues(input);
    const contactId = `supplier-contact:${randomUUID()}`;
    const { rows: [saved] } = await db.query<{ version: number }>(
      `INSERT INTO nzi_console.supplier_contacts (organisation_id, contact_id, supplier_id, full_name, email, phone, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING version`,
      [context.organisationId, contactId, input.supplierId, values.fullName, values.email, values.phone, context.actorId]);
    // Sealed in the same transaction, straight after the plaintext: no contact is ever committed without ciphertext.
    await sealSupplierContactRow({ db, organisationId: context.organisationId, actorId: context.actorId }, { contactId, ...values });
    const fields = (["fullName", "email", "phone"] as const).filter((field) => values[field] !== null);
    return { data: { contactId, supplierId: input.supplierId, version: saved!.version, active: true, fields }, entityType: "supplier_contact", entityId: contactId, topic: "supplier.contact_added" };
  });
}

export function updateSupplierContact(pool: PoolLike, input: CommandInputMap["supplier.contact.update"], context: CommandContext): Promise<StoredOutcome<SupplierContactResult>> {
  return runPostgresCommand(pool, "supplier.contact.update", input, context, async (db) => {
    const current = await lockContact(db, context, input.contactId, input.expectedVersion);
    if (current.full_name === null) throw new CommandValidationError([{ field: "contactId", code: "ERASED", message: "That contact has been erased and cannot be edited." }]);
    const values = contactValues(input);
    const held = { fullName: current.full_name, email: current.email, phone: current.phone };
    const fields = (["fullName", "email", "phone"] as const).filter((field) => values[field] !== held[field]);
    if (fields.length === 0) throw new CommandValidationError([{ field: "fullName", code: "UNCHANGED", message: "Those are the details the contact already holds." }]);
    const { rows: [saved] } = await db.query<{ version: number; active: boolean }>(
      `UPDATE nzi_console.supplier_contacts SET full_name = $3, email = $4, phone = $5, version = version + 1, updated_at = now(), updated_by = $6
        WHERE organisation_id = $1 AND contact_id = $2 RETURNING version, active`,
      [context.organisationId, input.contactId, values.fullName, values.email, values.phone, context.actorId]);
    await sealSupplierContactRow({ db, organisationId: context.organisationId, actorId: context.actorId }, { contactId: input.contactId, ...values });
    return { data: { contactId: input.contactId, supplierId: current.supplier_id, version: saved!.version, active: saved!.active, fields },
      entityType: "supplier_contact", entityId: input.contactId, topic: "supplier.contact_updated" };
  });
}

function setContactActive(key: "supplier.contact.deactivate" | "supplier.contact.reinstate", active: boolean) {
  return (pool: PoolLike, input: CommandInputMap[typeof key], context: CommandContext): Promise<StoredOutcome<SupplierContactResult>> =>
    runPostgresCommand(pool, key, input, context, async (db) => {
      const current = await lockContact(db, context, input.contactId, input.expectedVersion);
      if (current.active === active) throw new CommandValidationError([{ field: "contactId", code: active ? "ALREADY_ACTIVE" : "ALREADY_INACTIVE", message: `That contact is already ${active ? "active" : "inactive"}.` }]);
      if (active && current.full_name === null) throw new CommandValidationError([{ field: "contactId", code: "ERASED", message: "That contact has been erased and cannot be reinstated." }]);
      const { rows: [saved] } = await db.query<{ version: number }>(
        `UPDATE nzi_console.supplier_contacts SET active = $3, version = version + 1, updated_at = now(), updated_by = $4 WHERE organisation_id = $1 AND contact_id = $2 RETURNING version`,
        [context.organisationId, input.contactId, active, context.actorId]);
      return { data: { contactId: input.contactId, supplierId: current.supplier_id, version: saved!.version, active, fields: [] },
        entityType: "supplier_contact", entityId: input.contactId, topic: active ? "supplier.contact_reinstated" : "supplier.contact_deactivated" };
    });
}
export const deactivateSupplierContact = setContactActive("supplier.contact.deactivate", false);
export const reinstateSupplierContact = setContactActive("supplier.contact.reinstate", true);

// ── Commands: the rate card — the line (admin.lookups) ───────────────────────────────────────────────────────────

type StoredItem = {
  supplier_id: string; cost_type: string | null; name: string; description: string | null; unit_value_id: string | null;
  vat_rate_id: string | null; currency_code: string; active: boolean; version: number;
};
/** A line as the audit records it, before and after. No rate: it is never written here (E-Q8). */
type ItemSnapshot = { supplierId: string; costType: string | null; name: string; description: string | null; unitValueId: string | null; vatRateId: string | null; currency: string; active: boolean };
const itemSnapshot = (row: StoredItem): ItemSnapshot => ({
  supplierId: row.supplier_id, costType: row.cost_type, name: row.name, description: row.description, unitValueId: row.unit_value_id,
  vatRateId: row.vat_rate_id, currency: row.currency_code, active: row.active,
});
export type SupplierItemResult = ItemSnapshot & { serviceItemId: string; version: number };
const ITEM_COLUMNS = "supplier_id, cost_type, name, description, unit_value_id, vat_rate_id, currency_code, active, version";

async function lockItem(db: Queryable, context: CommandContext, serviceItemId: string, expectedVersion: number): Promise<StoredItem> {
  const { rows: [row] } = await db.query<StoredItem>(
    `SELECT ${ITEM_COLUMNS} FROM nzi_console.supplier_service_items WHERE organisation_id = $1 AND service_item_id = $2 FOR UPDATE`, [context.organisationId, serviceItemId]);
  if (!row) throw new CommandValidationError([{ field: "serviceItemId", code: "NOT_FOUND", message: "That rate-card service is not here." }]);
  if (row.version !== expectedVersion) throw new VersionConflictError(expectedVersion, row.version);
  return row;
}

/** A unit must be a units_of_measure value and a VAT rate one of E1's, each active — unless the line already holds it (R3). */
async function assertItemReferences(db: Queryable, context: CommandContext, next: { unitValueId: string | null; vatRateId: string | null },
  held: { unitValueId: string | null; vatRateId: string | null } | null) {
  const issues: Array<{ field: string; code: string; message: string }> = [];
  if (next.unitValueId !== null && next.unitValueId !== held?.unitValueId) {
    const { rows: [row] } = await db.query<{ category_key: string; active: boolean }>(
      `SELECT category_key, active FROM nzi_console.reference_values WHERE organisation_id = $1 AND value_id = $2`, [context.organisationId, next.unitValueId]);
    if (!row || row.category_key !== "units_of_measure") issues.push({ field: "unitValueId", code: "NOT_FOUND", message: "That unit is not one of this organisation's units of measure." });
    else if (!row.active) issues.push({ field: "unitValueId", code: "INACTIVE", message: "That unit is deactivated; reinstate it in Lookups to choose it." });
  }
  if (next.vatRateId !== null && next.vatRateId !== held?.vatRateId) {
    const { rows: [row] } = await db.query<{ active: boolean }>(`SELECT active FROM nzi_console.vat_rates WHERE organisation_id = $1 AND vat_rate_id = $2`, [context.organisationId, next.vatRateId]);
    if (!row) issues.push({ field: "vatRateId", code: "NOT_FOUND", message: "That VAT rate is not one of this organisation's." });
    else if (!row.active) issues.push({ field: "vatRateId", code: "INACTIVE", message: "That VAT rate is deactivated; reinstate it in Tax & currency to choose it." });
  }
  if (issues.length) throw new CommandValidationError(issues);
}

async function assertItemNameFree(db: Queryable, context: CommandContext, supplierId: string, name: string, serviceItemId: string | null) {
  const { rows: [taken] } = await db.query<{ taken: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM nzi_console.supplier_service_items WHERE organisation_id = $1 AND supplier_id = $2 AND lower(name) = lower($3)
        AND service_item_id IS DISTINCT FROM $4) AS taken`, [context.organisationId, supplierId, name, serviceItemId]);
  if (taken?.taken) throw new CommandValidationError([{ field: "name", code: "DUPLICATE", message: "This supplier already has a service — active or not — with that name." }]);
}

const itemDefinition = (input: CommandInputMap["supplier_item.create"] | CommandInputMap["supplier_item.update"]) => ({
  name: cleanName(input.name), costType: blank(input.costType), description: blank(input.description), unitValueId: blank(input.unitValueId), vatRateId: blank(input.vatRateId),
});

export function createSupplierItem(pool: PoolLike, input: CommandInputMap["supplier_item.create"], context: CommandContext): Promise<StoredOutcome<SupplierItemResult>> {
  return runPostgresCommand(pool, "supplier_item.create", input, context, async (db) => {
    await assertSupplierOpen(db, context, input.supplierId);
    const fields = itemDefinition(input);
    await assertItemNameFree(db, context, input.supplierId, fields.name, null);
    await assertItemReferences(db, context, fields, null);
    // E-Q9: a line is made in the organisation's selling currency.
    const { rows: [currency] } = await db.query<{ code: string }>(`SELECT code FROM nzi_console.currencies WHERE organisation_id = $1 AND is_default`, [context.organisationId]);
    if (!currency) throw new CommandValidationError([{ field: "currency", code: "NO_DEFAULT_CURRENCY", message: "This organisation has no default currency; set one in Tax & currency first." }]);
    const serviceItemId = `supplier-item:${randomUUID()}`;
    const { rows: [saved] } = await db.query<StoredItem>(
      `INSERT INTO nzi_console.supplier_service_items (organisation_id, service_item_id, supplier_id, cost_type, name, description, unit_value_id, vat_rate_id, currency_code, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10) RETURNING ${ITEM_COLUMNS}`,
      [context.organisationId, serviceItemId, input.supplierId, fields.costType, fields.name, fields.description, fields.unitValueId, fields.vatRateId, currency.code, context.actorId]);
    return { data: { serviceItemId, version: saved!.version, ...itemSnapshot(saved!) }, entityType: "supplier_item", entityId: serviceItemId, topic: "supplier_item.created" };
  });
}

export function updateSupplierItem(pool: PoolLike, input: CommandInputMap["supplier_item.update"], context: CommandContext): Promise<StoredOutcome<SupplierItemResult>> {
  return runPostgresCommand(pool, "supplier_item.update", input, context, async (db) => {
    const current = await lockItem(db, context, input.serviceItemId, input.expectedVersion);
    const fields = itemDefinition(input);
    const before = itemSnapshot(current);
    if ((["name", "costType", "description", "unitValueId", "vatRateId"] as const).every((field) => fields[field] === before[field])) {
      throw new CommandValidationError([{ field: "name", code: "UNCHANGED", message: "That is what the service already holds." }]);
    }
    await assertItemNameFree(db, context, current.supplier_id, fields.name, input.serviceItemId);
    await assertItemReferences(db, context, fields, { unitValueId: current.unit_value_id, vatRateId: current.vat_rate_id });
    const { rows: [saved] } = await db.query<StoredItem>(
      `UPDATE nzi_console.supplier_service_items SET cost_type = $3, name = $4, description = $5, unit_value_id = $6, vat_rate_id = $7,
              version = version + 1, updated_at = now(), updated_by = $8
        WHERE organisation_id = $1 AND service_item_id = $2 RETURNING ${ITEM_COLUMNS}`,
      [context.organisationId, input.serviceItemId, fields.costType, fields.name, fields.description, fields.unitValueId, fields.vatRateId, context.actorId]);
    return { data: { serviceItemId: input.serviceItemId, version: saved!.version, ...itemSnapshot(saved!) }, entityType: "supplier_item", entityId: input.serviceItemId,
      topic: "supplier_item.updated", before };
  });
}

function setItemActive(key: "supplier_item.deactivate" | "supplier_item.reinstate", active: boolean) {
  return (pool: PoolLike, input: CommandInputMap[typeof key], context: CommandContext): Promise<StoredOutcome<SupplierItemResult>> =>
    runPostgresCommand(pool, key, input, context, async (db) => {
      const current = await lockItem(db, context, input.serviceItemId, input.expectedVersion);
      if (current.active === active) throw new CommandValidationError([{ field: "serviceItemId", code: active ? "ALREADY_ACTIVE" : "ALREADY_INACTIVE", message: `That service is already ${active ? "active" : "inactive"}.` }]);
      const { rows: [saved] } = await db.query<StoredItem>(
        `UPDATE nzi_console.supplier_service_items SET active = $3, version = version + 1, updated_at = now(), updated_by = $4
          WHERE organisation_id = $1 AND service_item_id = $2 RETURNING ${ITEM_COLUMNS}`,
        [context.organisationId, input.serviceItemId, active, context.actorId]);
      return { data: { serviceItemId: input.serviceItemId, version: saved!.version, ...itemSnapshot(saved!) }, entityType: "supplier_item", entityId: input.serviceItemId,
        topic: active ? "supplier_item.reinstated" : "supplier_item.deactivated", before: itemSnapshot(current) };
    });
}
export const deactivateSupplierItem = setItemActive("supplier_item.deactivate", false);
export const reinstateSupplierItem = setItemActive("supplier_item.reinstate", true);

// ── Command: the agreed rate (finance.manage) ────────────────────────────────────────────────────────────────────

/**
 * What the rate command returns — and so what its audit event, idempotency record and outbox event hold: which line,
 * its new version and currency, and whether the rate was **set** or **cleared**. Never the figure (E-Q8, NZC-120).
 */
export type SupplierItemRateResult = { serviceItemId: string; version: number; currency: string; rate: "set" | "cleared" };

export function setSupplierItemRate(pool: PoolLike, input: CommandInputMap["supplier_item.rate.set"], context: CommandContext): Promise<StoredOutcome<SupplierItemRateResult>> {
  return runPostgresCommand(pool, "supplier_item.rate.set", input, context, async (db) => {
    const { rows: [current] } = await db.query<{ version: number; currency_code: string; rate: string | null }>(
      `SELECT version, currency_code, agreed_rate::text AS rate FROM nzi_console.supplier_service_items
        WHERE organisation_id = $1 AND service_item_id = $2 FOR UPDATE`, [context.organisationId, input.serviceItemId]);
    if (!current) throw new CommandValidationError([{ field: "serviceItemId", code: "NOT_FOUND", message: "That rate-card service is not here." }]);
    if (current.version !== input.expectedVersion) throw new VersionConflictError(input.expectedVersion, current.version);
    if (amount(current.rate) === input.agreedRate) throw new CommandValidationError([{ field: "agreedRate", code: "UNCHANGED", message: "That is the rate it already holds." }]);
    const { rows: [saved] } = await db.query<{ version: number }>(
      `UPDATE nzi_console.supplier_service_items SET agreed_rate = $3, version = version + 1, updated_at = now(), updated_by = $4
        WHERE organisation_id = $1 AND service_item_id = $2 RETURNING version`,
      [context.organisationId, input.serviceItemId, input.agreedRate, context.actorId]);
    return { data: { serviceItemId: input.serviceItemId, version: saved!.version, currency: current.currency_code, rate: input.agreedRate === null ? "cleared" : "set" },
      entityType: "supplier_item", entityId: input.serviceItemId, topic: "supplier_item.rate_set" };
  });
}
