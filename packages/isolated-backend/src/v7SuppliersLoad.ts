import { createHmac, randomUUID } from "node:crypto";
import {
  isSupplierContactEmail, SUPPLIER_CONTACT_NAME_MAX, SUPPLIER_CONTACT_PHONE_MAX, SUPPLIER_COST_TYPE_MAX, SUPPLIER_ITEM_DESCRIPTION_MAX,
  SUPPLIER_ITEM_NAME_MAX, SUPPLIER_NAME_MAX, SUPPLIER_RATE_MAX, SUPPLIER_WEBSITE_MAX,
} from "@nzi/contracts";
import { sealSupplierContactRow } from "./piiWriteThrough";
import type { SealingKeys } from "./piiSealing";
import { withTenantWrite, type PoolLike, type Queryable } from "./postgres";
import { blindIndex } from "./subjectCrypto";
import { IMPORT_ACTOR, SOURCE_SYSTEM } from "./v7ClientImport";
import type { V7Row, V7Table } from "./v7ClientExtract";

/**
 * The v7 supplier import (admin Phase E4, `load:v7-suppliers`; ruled `phaseE-commercial-catalogue-plan.md` E-Q6–E-Q9):
 * v7's `suppliers` and `supplier_service_items` → 0148's `suppliers`, `supplier_contacts` and `supplier_service_items`.
 *
 * **The people are sealed on load (E-Q7)**, as B2's staff load was: v7 holds one contact per supplier on the supplier
 * row (name, email, phone); each becomes a `supplier_contacts` row written and sealed in the same transaction, under its
 * own subject key. The extract read is the contract's columns only — **v7's `address` and `notes` are never extracted**.
 * Nothing personal leaves this module: the outcome names suppliers and lines **by v7 id**, never by name, and a
 * contact's `legacy_values` is a keyed digest of what v7 held and the fields present — never the values.
 *
 * **The plan (pure; held in memory only)** parses each supplier (name, website, state, its contact) and each rate-card
 * line (cost type, name, description, the unit **as v7's free text**, the rate, v7's VAT flag and percentage, state).
 *
 * **The load** reconciles onto what the console holds:
 * - a supplier → its v7 identity, else **its name** among suppliers with none (stamped — a person's supplier keeps its
 *   own name and website), else inserted;
 * - its contact → the contact v7's supplier already loaded, else one here at that supplier **with the same email** (by
 *   blind index; stamped, keeping its own details), else inserted and sealed;
 * - a line → its v7 identity, else the same name at the same supplier among lines with none (stamped), else inserted. Its
 *   supplier must have loaded (else reported); its unit resolves to a `units_of_measure` value by label or singular; its
 *   VAT to the one rate with v7's percentage (0% when v7 says not vatable) — anything that does not resolve is left
 *   blank and **noted**, never guessed. Its currency is the organisation's default (E-Q9).
 * Re-runs (R4): v7 unchanged → left alone; changed and the row still as an import wrote it → v7 wins; changed **and**
 * edited here since → refused and reported. Nothing is deleted or deactivated; what is here and not in v7 is counted.
 *
 * **Rates (E-Q8).** The import writes the agreed rate as v7 holds it — but its audit event and its report say how many
 * lines are rated and which differ, **never the figures**.
 *
 * One transaction; a dry run is the whole load, rolled back.
 */

export const SUPPLIERS_RUN_PREFIX = "v7-suppliers-";
export const V7_SUPPLIER_TABLES: readonly V7Table[] = ["suppliers", "supplier_service_items"];

const text = (value: string | null | undefined) => { const trimmed = value?.trim(); return trimmed ? trimmed : null; };
const collapse = (value: string) => value.trim().replace(/\s+/g, " ");
const norm = (value: string) => collapse(value).toLowerCase();
const flag = (value: string | null | undefined): boolean | null => {
  const v = value?.trim().toLowerCase();
  return v === "t" || v === "true" || v === "1" ? true : v === "f" || v === "false" || v === "0" ? false : null;
};
/** A non-negative number held to two places, or undefined when it is not one (a blank is null). */
const twoPlaces = (value: string | null | undefined, max: number): number | null | undefined => {
  const raw = text(value);
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= max && Math.abs(Math.round(parsed * 100) - parsed * 100) < 1e-6 ? Math.round(parsed * 100) / 100 : undefined;
};

// ── The plan (pure; held in memory only — it carries people's details) ────────────────────────────────────────────

export type PlannedContact = { fullName: string; email: string | null; phone: string | null };
export type PlannedSupplier = {
  legacyDbId: string; name: string; website: string | null; active: boolean;
  /** Personal data: sealed on write, never reported. Null when v7 names nobody. */
  contact: PlannedContact | null;
  legacyValues: { name: string; website: string | null; isActive: string | null };
};
export type PlannedSupplierItem = {
  legacyDbId: string; supplierLegacyId: string; costType: string | null; name: string; description: string | null;
  unitText: string | null; agreedRate: number | null; vatable: boolean | null; vatPct: number | null; active: boolean;
  legacyValues: Record<string, unknown>;
};
export type SupplierSkip = { table: "suppliers" | "supplier_service_items"; legacyDbId: string; reason: string };
export type SuppliersPlan = { suppliers: PlannedSupplier[]; items: PlannedSupplierItem[]; skipped: SupplierSkip[]; notes: string[] };

export function planV7Suppliers(extract: Partial<Record<V7Table, readonly V7Row[]>>): SuppliersPlan {
  const plan: SuppliersPlan = { suppliers: [], items: [], skipped: [], notes: [] };
  const names = new Map<string, string>();
  for (const row of [...(extract.suppliers ?? [])].sort((a, b) => Number(a.supplier_id) - Number(b.supplier_id))) {
    const legacyDbId = text(row.supplier_id);
    if (!legacyDbId) { plan.skipped.push({ table: "suppliers", legacyDbId: "(blank)", reason: "a row with no id" }); continue; }
    const skip = (reason: string) => plan.skipped.push({ table: "suppliers", legacyDbId, reason });
    const rawName = text(row.supplier_name);
    if (!rawName) { skip("a supplier with no name"); continue; }
    const name = collapse(rawName);
    if (name.length > SUPPLIER_NAME_MAX) { skip(`a name longer than ${SUPPLIER_NAME_MAX} characters`); continue; }
    if (names.has(norm(name))) { skip(`the same name as v7 supplier ${names.get(norm(name))}`); continue; }
    let website = text(row.website);
    if (website && website.length > SUPPLIER_WEBSITE_MAX) { plan.notes.push(`supplier ${legacyDbId}: a website longer than ${SUPPLIER_WEBSITE_MAX} characters — left blank`); website = null; }
    names.set(norm(name), legacyDbId);

    // The contact: one per v7 supplier. Never reported by value — only by which fields were left out.
    const contactName = text(row.contact_name);
    let email = text(row.contact_email);
    let phone = text(row.phone);
    let contact: PlannedContact | null = null;
    if (contactName || email || phone) {
      if (!contactName) plan.notes.push(`supplier ${legacyDbId}: v7 holds contact details with no name — the contact is left out`);
      else if (collapse(contactName).length > SUPPLIER_CONTACT_NAME_MAX) plan.notes.push(`supplier ${legacyDbId}: a contact name longer than ${SUPPLIER_CONTACT_NAME_MAX} characters — the contact is left out`);
      else {
        if (email && !isSupplierContactEmail(email)) { plan.notes.push(`supplier ${legacyDbId}: the contact's email is not an address — left blank`); email = null; }
        if (phone && phone.length > SUPPLIER_CONTACT_PHONE_MAX) { plan.notes.push(`supplier ${legacyDbId}: the contact's phone is longer than ${SUPPLIER_CONTACT_PHONE_MAX} characters — left blank`); phone = null; }
        contact = { fullName: collapse(contactName), email, phone };
      }
    }
    plan.suppliers.push({
      legacyDbId, name, website, active: flag(row.is_active) ?? true, contact,
      legacyValues: { name: rawName, website: row.website ?? null, isActive: row.is_active ?? null },
    });
  }

  const loaded = new Set(plan.suppliers.map((supplier) => supplier.legacyDbId));
  const lines = new Map<string, string>();
  for (const row of [...(extract.supplier_service_items ?? [])].sort((a, b) => Number(a.supplier_item_id) - Number(b.supplier_item_id))) {
    const legacyDbId = text(row.supplier_item_id);
    if (!legacyDbId) { plan.skipped.push({ table: "supplier_service_items", legacyDbId: "(blank)", reason: "a row with no id" }); continue; }
    const skip = (reason: string) => plan.skipped.push({ table: "supplier_service_items", legacyDbId, reason });
    const supplierLegacyId = text(row.supplier_id);
    if (!supplierLegacyId || !loaded.has(supplierLegacyId)) { skip(`its supplier (v7 ${supplierLegacyId ?? "—"}) is not in this load`); continue; }
    const rawName = text(row.item_name);
    if (!rawName) { skip("a line with no name"); continue; }
    const name = collapse(rawName);
    if (name.length > SUPPLIER_ITEM_NAME_MAX) { skip(`a name longer than ${SUPPLIER_ITEM_NAME_MAX} characters`); continue; }
    const key = `${supplierLegacyId}:${norm(name)}`;
    if (lines.has(key)) { skip(`the same name at the same supplier as v7 line ${lines.get(key)}`); continue; }
    const costType = text(row.cost_type);
    if (costType && collapse(costType).length > SUPPLIER_COST_TYPE_MAX) { skip(`a cost type longer than ${SUPPLIER_COST_TYPE_MAX} characters`); continue; }
    const description = text(row.description);
    if (description && description.length > SUPPLIER_ITEM_DESCRIPTION_MAX) { skip(`a description longer than ${SUPPLIER_ITEM_DESCRIPTION_MAX} characters`); continue; }
    const rate = twoPlaces(row.agreed_rate, SUPPLIER_RATE_MAX);
    if (rate === undefined) { skip("a rate that is not a number from 0, to two places"); continue; }
    const vatPct = twoPlaces(row.vat_rate_pct, 100);
    lines.set(key, legacyDbId);
    plan.items.push({
      legacyDbId, supplierLegacyId, costType: costType ? collapse(costType) : null, name, description, unitText: text(row.uom), agreedRate: rate,
      vatable: flag(row.is_vatable), vatPct: vatPct ?? null, active: flag(row.is_active) ?? true,
      // What v7 held — the rate included, so a re-run can tell v7 changed it (this column is never audited or listed).
      legacyValues: { supplierId: supplierLegacyId, costType: row.cost_type ?? null, name: rawName, description: row.description ?? null, uom: row.uom ?? null,
        agreedRate: rate, isVatable: row.is_vatable ?? null, vatRatePct: vatPct ?? null, isActive: row.is_active ?? null },
    });
  }
  return plan;
}

// ── Loading ────────────────────────────────────────────────────────────────────────────────────────────────────

type Tally = { inserted: number; stamped: number; updated: number; unchanged: number };
export type SuppliersOutcome = {
  committed: boolean; runId: string;
  suppliers: Tally; contacts: Tally; items: Tally;
  /** R4 conflicts, a missing currency — by v7 id. Nothing written for these. */
  refused: string[];
  /** References that do not resolve here (left blank, never guessed), and other notes — by v7 id, never a name. */
  notes: string[];
  /** Rows here that v7 lacks — counted, never deactivated. */
  hereOnly: { suppliers: number; contacts: number; items: number };
  /** How many v7-identified lines carry a rate, and which lines' rates differ from v7's after the load — never the figures. */
  rated: number;
  rateDifferences: string[];
  parity: { v7Active: number; v7Inactive: number; consoleActive: number; consoleInactive: number };
};

class DryRunRollback extends Error {}
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]))
  : value;
const same = (a: unknown, b: unknown) => a !== null && a !== undefined && JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const byImport = (actor: string) => actor.startsWith(SUPPLIERS_RUN_PREFIX);
const tally = (): Tally => ({ inserted: 0, stamped: 0, updated: 0, unchanged: 0 });

/**
 * What a contact's `legacy_values` holds: a keyed digest of what v7 held (so a re-run can tell it changed) and which
 * fields were present — never a value. Keyed, and apart from the blind index by its label, so it confirms nothing to a
 * guess without the key.
 */
export function contactLegacyValues(contact: PlannedContact, keys: SealingKeys) {
  const digest = createHmac("sha256", Buffer.from(keys.indexKey, "base64"))
    .update(`v7-supplier-contact:${JSON.stringify([contact.fullName, contact.email?.toLowerCase() ?? null, contact.phone])}`).digest("base64url");
  return { digest, fields: (["fullName", "email", "phone"] as const).filter((field) => contact[field] !== null) };
}

type HeldSupplier = { supplier_id: string; name: string; source_system: string | null; legacy_db_id: string | null; legacy_values: unknown; updated_by: string };
type HeldContact = { contact_id: string; supplier_id: string; email_bidx: string | null; email: string | null; source_system: string | null; legacy_db_id: string | null; legacy_values: unknown; updated_by: string };
type HeldItem = { service_item_id: string; supplier_id: string; name: string; source_system: string | null; legacy_db_id: string | null; legacy_values: unknown; updated_by: string };

export async function loadV7Suppliers(pool: PoolLike, organisationId: string, plan: SuppliersPlan, options: { commit: boolean; keys: SealingKeys; runId?: string }): Promise<SuppliersOutcome> {
  const runId = options.runId ?? `${SUPPLIERS_RUN_PREFIX}${randomUUID()}`;
  if (!runId.startsWith(SUPPLIERS_RUN_PREFIX)) throw new Error(`A suppliers run id must start ${SUPPLIERS_RUN_PREFIX} — it is how a re-run knows a row is still as an import wrote it.`);
  const outcome: SuppliersOutcome = {
    committed: options.commit, runId, suppliers: tally(), contacts: tally(), items: tally(), refused: [], notes: [...plan.notes],
    hereOnly: { suppliers: 0, contacts: 0, items: 0 }, rated: 0, rateDifferences: [],
    parity: { v7Active: plan.suppliers.filter((supplier) => supplier.active).length, v7Inactive: plan.suppliers.filter((supplier) => !supplier.active).length, consoleActive: 0, consoleInactive: 0 },
  };
  try {
    await withTenantWrite(pool, organisationId, async (db) => {
      const supplierIds = await reconcileSuppliers(db, organisationId, plan, runId, options.keys, outcome);
      await reconcileItems(db, organisationId, plan, runId, supplierIds, outcome);
      const written = (t: Tally) => t.inserted + t.stamped + t.updated;
      if (written(outcome.suppliers) + written(outcome.contacts) + written(outcome.items) > 0) {
        await db.query(
          `INSERT INTO nzi_console.audit_events (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, reason, after_json)
           VALUES ($1, $2, $3, 'system', 'suppliers.imported', 'suppliers', 'suppliers', $4, $5, $6::jsonb)`,
          [organisationId, randomUUID(), IMPORT_ACTOR, runId, "Suppliers and their rate card reconciled from NZ Insights Pro v7 (admin E4)",
            // Counts only — never a person's details, never a rate (E-Q6, E-Q8).
            JSON.stringify({ run: runId, sourceSystem: SOURCE_SYSTEM, suppliers: outcome.suppliers, contacts: outcome.contacts, items: outcome.items,
              refused: outcome.refused.length, rated: outcome.rated })]);
      }
      if (!options.commit) throw new DryRunRollback();
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  }
  return outcome;
}

/** The suppliers and their contacts. Returns v7 supplier id → console supplier id, for the rate card. */
async function reconcileSuppliers(db: Queryable, org: string, plan: SuppliersPlan, runId: string, keys: SealingKeys, outcome: SuppliersOutcome): Promise<Map<string, string>> {
  // One after another: the one transaction client runs one query at a time.
  const suppliers = await db.query<HeldSupplier>(`SELECT supplier_id, name, source_system, legacy_db_id, legacy_values, updated_by FROM nzi_console.suppliers WHERE organisation_id = $1 ORDER BY supplier_id FOR UPDATE`, [org]);
  const contacts = await db.query<HeldContact>(`SELECT contact_id, supplier_id, email_bidx, email, source_system, legacy_db_id, legacy_values, updated_by FROM nzi_console.supplier_contacts WHERE organisation_id = $1 ORDER BY contact_id FOR UPDATE`, [org]);
  const ids = new Map<string, string>();
  const claimed = new Set<string>();
  const seal = { db, organisationId: org, actorId: IMPORT_ACTOR, keys };

  for (const value of plan.suppliers) {
    const fields = [value.name, value.website, value.active, SOURCE_SYSTEM, value.legacyDbId, JSON.stringify(value.legacyValues)] as const;
    const identity = suppliers.rows.find((row) => row.source_system === SOURCE_SYSTEM && row.legacy_db_id === value.legacyDbId);
    const natural = identity ? undefined : suppliers.rows.find((row) => row.source_system === null && !claimed.has(row.supplier_id) && norm(row.name) === norm(value.name));
    const match = identity ?? natural;
    let supplierId: string;
    if (!match) {
      supplierId = `supplier:v7-${value.legacyDbId}`;
      await db.query(
        `INSERT INTO nzi_console.suppliers (organisation_id, supplier_id, name, website, active, source_system, legacy_db_id, legacy_values, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $9)`, [org, supplierId, ...fields, runId]);
      outcome.suppliers.inserted += 1;
    } else if (identity) {
      supplierId = identity.supplier_id;
      if (same(identity.legacy_values, value.legacyValues)) outcome.suppliers.unchanged += 1;
      else if (!byImport(identity.updated_by)) outcome.refused.push(`supplier ${value.legacyDbId}: changed in v7 since the last load, and edited here since (R4)`);
      else {
        await db.query(
          `UPDATE nzi_console.suppliers SET name = $3, website = $4, active = $5, source_system = $6, legacy_db_id = $7, legacy_values = $8::jsonb,
                  version = version + 1, updated_at = now(), updated_by = $9 WHERE organisation_id = $1 AND supplier_id = $2`, [org, supplierId, ...fields, runId]);
        outcome.suppliers.updated += 1;
      }
    } else {
      // Matched by name: a supplier a person made here. Its name, website and state stand; it takes v7's identity.
      supplierId = natural!.supplier_id;
      await db.query(
        `UPDATE nzi_console.suppliers SET source_system = $3, legacy_db_id = $4, legacy_values = $5::jsonb, version = version + 1, updated_at = now()
          WHERE organisation_id = $1 AND supplier_id = $2`, [org, supplierId, SOURCE_SYSTEM, value.legacyDbId, JSON.stringify(value.legacyValues)]);
      outcome.notes.push(`supplier ${value.legacyDbId}: already held here by name — stamped with v7's identity; its own details stand`);
      outcome.suppliers.stamped += 1;
    }
    claimed.add(supplierId);
    ids.set(value.legacyDbId, supplierId);
    if (value.contact) await reconcileContact(db, org, runId, supplierId, value, value.contact, contacts.rows, seal, keys, outcome);
  }

  outcome.hereOnly.suppliers = suppliers.rows.filter((row) => !claimed.has(row.supplier_id)).length;
  const v7Contacts = plan.suppliers.filter((supplier) => supplier.contact).map((supplier) => supplier.legacyDbId);
  const { rows: [hereOnly] } = await db.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM nzi_console.supplier_contacts WHERE organisation_id = $1 AND (source_system IS DISTINCT FROM $2 OR NOT (legacy_db_id = ANY($3::text[])))`,
    [org, SOURCE_SYSTEM, v7Contacts]);
  outcome.hereOnly.contacts = hereOnly?.count ?? 0;
  const { rows: [parity] } = await db.query<{ active: number; inactive: number }>(
    `SELECT count(*) FILTER (WHERE active)::int AS active, count(*) FILTER (WHERE NOT active)::int AS inactive FROM nzi_console.suppliers WHERE organisation_id = $1 AND source_system = $2`,
    [org, SOURCE_SYSTEM]);
  outcome.parity.consoleActive = parity?.active ?? 0;
  outcome.parity.consoleInactive = parity?.inactive ?? 0;
  return ids;
}

/** One v7 supplier's contact: matched by v7 identity, else by email at that supplier, else inserted — and sealed. */
async function reconcileContact(db: Queryable, org: string, runId: string, supplierId: string, supplier: PlannedSupplier, contact: PlannedContact,
  held: HeldContact[], seal: { db: Queryable; organisationId: string; actorId: string; keys: SealingKeys }, keys: SealingKeys, outcome: SuppliersOutcome) {
  const legacy = contactLegacyValues(contact, keys);
  const identity = held.find((row) => row.source_system === SOURCE_SYSTEM && row.legacy_db_id === supplier.legacyDbId);
  const bidx = contact.email ? blindIndex("supplier_contacts.email", contact.email, keys.indexKey) : null;
  const natural = identity || bidx === null ? undefined
    : held.find((row) => row.source_system === null && row.supplier_id === supplierId && (row.email_bidx === bidx || row.email?.trim().toLowerCase() === contact.email!.toLowerCase()));
  if (identity) {
    if (same(identity.legacy_values, legacy)) { outcome.contacts.unchanged += 1; return; }
    if (!byImport(identity.updated_by)) { outcome.refused.push(`supplier ${supplier.legacyDbId}: its contact changed in v7 since the last load, and was edited here since (R4)`); return; }
    await db.query(
      `UPDATE nzi_console.supplier_contacts SET full_name = $3, email = $4, phone = $5, legacy_values = $6::jsonb, version = version + 1, updated_at = now(), updated_by = $7
        WHERE organisation_id = $1 AND contact_id = $2`, [org, identity.contact_id, contact.fullName, contact.email, contact.phone, JSON.stringify(legacy), runId]);
    await sealSupplierContactRow(seal, { contactId: identity.contact_id, ...contact });
    outcome.contacts.updated += 1;
    return;
  }
  if (natural) {
    await db.query(
      `UPDATE nzi_console.supplier_contacts SET source_system = $3, legacy_db_id = $4, legacy_values = $5::jsonb, version = version + 1, updated_at = now()
        WHERE organisation_id = $1 AND contact_id = $2`, [org, natural.contact_id, SOURCE_SYSTEM, supplier.legacyDbId, JSON.stringify(legacy)]);
    outcome.notes.push(`supplier ${supplier.legacyDbId}: its contact is already held here by email — stamped; its own details stand`);
    outcome.contacts.stamped += 1;
    return;
  }
  const contactId = `supplier-contact:v7-${supplier.legacyDbId}`;
  await db.query(
    `INSERT INTO nzi_console.supplier_contacts (organisation_id, contact_id, supplier_id, full_name, email, phone, active, source_system, legacy_db_id, legacy_values, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8, $9::jsonb, $10, $10)`,
    [org, contactId, supplierId, contact.fullName, contact.email, contact.phone, SOURCE_SYSTEM, supplier.legacyDbId, JSON.stringify(legacy), runId]);
  // Sealed in the same transaction, straight after the plaintext (E-Q7).
  await sealSupplierContactRow(seal, { contactId, ...contact });
  outcome.contacts.inserted += 1;
}

async function reconcileItems(db: Queryable, org: string, plan: SuppliersPlan, runId: string, supplierIds: Map<string, string>, outcome: SuppliersOutcome) {
  // One after another: the one transaction client runs one query at a time.
  const items = await db.query<HeldItem>(`SELECT service_item_id, supplier_id, name, source_system, legacy_db_id, legacy_values, updated_by FROM nzi_console.supplier_service_items WHERE organisation_id = $1 ORDER BY service_item_id FOR UPDATE`, [org]);
  const units = await db.query<{ value_id: string; label: string }>(`SELECT value_id, label FROM nzi_console.reference_values WHERE organisation_id = $1 AND category_key = 'units_of_measure'`, [org]);
  const vat = await db.query<{ vat_rate_id: string; rate_pct: string }>(`SELECT vat_rate_id, rate_pct::text FROM nzi_console.vat_rates WHERE organisation_id = $1`, [org]);
  const currency = await db.query<{ code: string }>(`SELECT code FROM nzi_console.currencies WHERE organisation_id = $1 AND is_default`, [org]);
  const selling = currency.rows[0]?.code ?? null;
  const unitOf = (label: string | null) => {
    if (label === null) return null;
    const wanted = norm(label);
    const singular = (value: string) => value.endsWith("s") ? value.slice(0, -1) : value;
    return units.rows.find((row) => norm(row.label) === wanted || singular(norm(row.label)) === singular(wanted))?.value_id ?? undefined;
  };
  const vatOf = (value: PlannedSupplierItem) => {
    const pct = value.vatable === false ? 0 : value.vatPct;
    if (pct === null) return value.vatable === null ? null : undefined;
    const byRate = vat.rows.filter((row) => Number(row.rate_pct) === pct);
    return byRate.length === 1 ? byRate[0]!.vat_rate_id : undefined;
  };
  const claimed = new Set<string>();

  for (const value of plan.items) {
    const supplierId = supplierIds.get(value.supplierLegacyId);
    if (!supplierId) { outcome.refused.push(`line ${value.legacyDbId}: its supplier (v7 ${value.supplierLegacyId}) did not load`); continue; }
    if (selling === null) { outcome.refused.push(`line ${value.legacyDbId}: this organisation has no default currency (E-Q9)`); continue; }
    const unit = unitOf(value.unitText);
    const vatRateId = vatOf(value);
    if (unit === undefined) outcome.notes.push(`line ${value.legacyDbId}: v7's unit "${value.unitText}" is not a unit of measure here — left blank`);
    if (vatRateId === undefined) outcome.notes.push(`line ${value.legacyDbId}: v7's VAT (${value.vatable === false ? "not vatable" : `${value.vatPct ?? "—"}%`}) does not resolve to one VAT rate here — left blank`);
    const fields = [value.costType, value.name, value.description, unit ?? null, vatRateId ?? null, value.agreedRate, selling, value.active,
      SOURCE_SYSTEM, value.legacyDbId, JSON.stringify(value.legacyValues)] as const;

    const identity = items.rows.find((row) => row.source_system === SOURCE_SYSTEM && row.legacy_db_id === value.legacyDbId);
    const natural = identity ? undefined
      : items.rows.find((row) => row.source_system === null && !claimed.has(row.service_item_id) && row.supplier_id === supplierId && norm(row.name) === norm(value.name));
    const match = identity ?? natural;
    if (match) claimed.add(match.service_item_id);
    if (!match) {
      await db.query(
        `INSERT INTO nzi_console.supplier_service_items (organisation_id, service_item_id, supplier_id, cost_type, name, description, unit_value_id, vat_rate_id, agreed_rate,
           currency_code, active, source_system, legacy_db_id, legacy_values, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $15)`,
        [org, `supplier-item:v7-${value.legacyDbId}`, supplierId, ...fields, runId]);
      outcome.items.inserted += 1;
      continue;
    }
    if (identity) {
      if (same(identity.legacy_values, value.legacyValues)) { outcome.items.unchanged += 1; continue; }
      if (!byImport(identity.updated_by)) { outcome.refused.push(`line ${value.legacyDbId}: changed in v7 since the last load, and edited here since (R4)`); continue; }
      await db.query(
        `UPDATE nzi_console.supplier_service_items SET cost_type = $3, name = $4, description = $5, unit_value_id = $6, vat_rate_id = $7, agreed_rate = $8, currency_code = $9,
                active = $10, source_system = $11, legacy_db_id = $12, legacy_values = $13::jsonb, version = version + 1, updated_at = now(), updated_by = $14
          WHERE organisation_id = $1 AND service_item_id = $2`, [org, identity.service_item_id, ...fields, runId]);
      outcome.items.updated += 1;
      continue;
    }
    await db.query(
      `UPDATE nzi_console.supplier_service_items SET source_system = $3, legacy_db_id = $4, legacy_values = $5::jsonb, version = version + 1, updated_at = now()
        WHERE organisation_id = $1 AND service_item_id = $2`, [org, natural!.service_item_id, SOURCE_SYSTEM, value.legacyDbId, JSON.stringify(value.legacyValues)]);
    outcome.notes.push(`line ${value.legacyDbId}: already held here by name at its supplier — stamped; its own definition and rate stand`);
    outcome.items.stamped += 1;
  }

  outcome.hereOnly.items = items.rows.filter((row) => !claimed.has(row.service_item_id)).length;
  const { rows } = await db.query<{ legacy_db_id: string; rate: string | null }>(
    `SELECT legacy_db_id, agreed_rate::text AS rate FROM nzi_console.supplier_service_items WHERE organisation_id = $1 AND source_system = $2`, [org, SOURCE_SYSTEM]);
  outcome.rated = rows.filter((row) => row.rate !== null).length;
  for (const value of plan.items) {
    const row = rows.find((candidate) => candidate.legacy_db_id === value.legacyDbId);
    // Which, never what (E-Q8).
    if (row && value.agreedRate !== (row.rate === null ? null : Number(row.rate))) outcome.rateDifferences.push(`line ${value.legacyDbId}: the rate differs from v7's`);
  }
}
