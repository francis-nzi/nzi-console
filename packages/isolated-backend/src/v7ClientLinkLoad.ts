import { randomUUID } from "node:crypto";
import { withTenantWrite, type PoolLike, type Queryable } from "./postgres";
import { IMPORT_ACTOR, SOURCE_SYSTEM } from "./v7ClientImport";
import { normaliseLabel } from "./v7LookupLoad";

/**
 * Link each imported client's v7 text to the console's references (admin Phase A4, `load:v7-client-links`).
 *
 * | text column      | link column              | matched against                                                  |
 * |------------------|--------------------------|------------------------------------------------------------------|
 * | `sector`         | `sector_value_id`        | industries, by normalised label (trimmed, spaces collapsed, case) |
 * | `referral`       | `referral_value_id`      | referrals, by normalised label                                    |
 * | `portfolio`      | `portfolio_value_id`     | portfolios, by normalised label                                   |
 * | `client_manager` | `client_manager_user_id` | the one membership whose display name is exactly the text         |
 *
 * **Exact and unique, or not at all — never guessed.** A label two values share is ambiguous (unless exactly one of
 * them is active); a name two memberships share is ambiguous; a name whose one membership is not active is not linked.
 * **Fill-NULL-only:** a link already set is left alone, and when it differs from what the text matches that is a
 * reported conflict, never an overwrite. **Never creates a lookup value** from client text (P7): an unmatched text is
 * reported with its client count, and fixed by adding or renaming a value in the Lookups screen, then re-running.
 * **The text columns are never touched** — they stay the record of what was imported, and they are the client
 * loader's compare set, so its re-run stays "already loaded and identical" after this (the `*_value_id` links are not
 * compared there).
 *
 * Each changed client is version-bumped (an open edit form then conflicts rather than overwriting) and gets one audit
 * event carrying the run id. Clients carry no `updated_by`, so the audit event is where the run is recorded. One
 * transaction for the whole run; a dry run is that transaction rolled back.
 */

export const CLIENT_LINK_RUN_PREFIX = "v7-client-links-";

export type LinkField = "sector" | "referral" | "portfolio" | "clientManager";
export const LINK_FIELDS: readonly LinkField[] = ["sector", "referral", "portfolio", "clientManager"];
const LINK_COLUMN: Record<LinkField, string> = {
  sector: "sector_value_id", referral: "referral_value_id", portfolio: "portfolio_value_id", clientManager: "client_manager_user_id",
};
const LOOKUP_CATEGORY: Record<Exclude<LinkField, "clientManager">, string> = { sector: "industries", referral: "referrals", portfolio: "portfolios" };

export type LinkClient = {
  clientId: string; version: number;
  text: Record<LinkField, string | null>;
  link: Record<LinkField, string | null>;
};
export type LinkValue = { valueId: string; category: string; label: string; active: boolean };
export type LinkMember = { userId: string; displayName: string | null; status: string };

export type UnmatchedReason = "no match" | "ambiguous" | "membership not active";
export type FieldTally = { filled: number; alreadyLinked: number; conflicts: number; unmatched: number; blank: number; filledToInactive: number };

export type LinkPlan = {
  /** Only the clients this run changes, with the links it fills. */
  changes: Array<{ clientId: string; version: number; fills: Partial<Record<LinkField, string>> }>;
  tally: Record<LinkField, FieldTally>;
  conflicts: Array<{ clientId: string; field: LinkField; current: string; matched: string }>;
  /** Distinct unmatched texts per field, with how many clients hold each. */
  unmatched: Record<LinkField, Array<{ text: string; clients: number; reason: UnmatchedReason }>>;
  /** Distinct matched texts per lookup field → the value they link to, with client counts (fills only). */
  matched: Record<LinkField, Array<{ text: string; valueId: string; label: string; clients: number }>>;
};

type Match = { id: string; label: string; active: boolean } | { unmatched: UnmatchedReason };

const perField = <T>(make: () => T): Record<LinkField, T> =>
  Object.fromEntries(LINK_FIELDS.map((field) => [field, make()])) as Record<LinkField, T>;

/** Pure: what the run would link. Exact and unique only; never overwrites, never creates. */
export function planClientLinks(input: { clients: readonly LinkClient[]; values: readonly LinkValue[]; members: readonly LinkMember[] }): LinkPlan {
  const byLabel = new Map<string, LinkValue[]>();
  for (const value of input.values) {
    const key = `${value.category}\u0000${normaliseLabel(value.label)}`;
    byLabel.set(key, [...(byLabel.get(key) ?? []), value]);
  }
  const byName = new Map<string, LinkMember[]>();
  for (const member of input.members) {
    const name = member.displayName?.trim();
    if (name) byName.set(name, [...(byName.get(name) ?? []), member]);
  }

  const matchLookup = (field: Exclude<LinkField, "clientManager">, text: string): Match => {
    const candidates = byLabel.get(`${LOOKUP_CATEGORY[field]}\u0000${normaliseLabel(text)}`) ?? [];
    const active = candidates.filter((value) => value.active);
    // One active value carrying the label is the match; with none active, one archived value is (a client v7 still
    // records under a retired label keeps resolving, as a deactivated value always does). Anything else is not unique.
    const pick = active.length > 0 ? active : candidates;
    if (pick.length === 0) return { unmatched: "no match" };
    if (pick.length > 1) return { unmatched: "ambiguous" };
    return { id: pick[0]!.valueId, label: pick[0]!.label, active: pick[0]!.active };
  };
  const matchMember = (text: string): Match => {
    const candidates = byName.get(text) ?? [];
    if (candidates.length === 0) return { unmatched: "no match" };
    if (candidates.length > 1) return { unmatched: "ambiguous" };
    if (candidates[0]!.status !== "active") return { unmatched: "membership not active" };
    return { id: candidates[0]!.userId, label: text, active: true };
  };

  const plan: LinkPlan = { changes: [], tally: perField(() => ({ filled: 0, alreadyLinked: 0, conflicts: 0, unmatched: 0, blank: 0, filledToInactive: 0 })), conflicts: [], unmatched: perField(() => []), matched: perField(() => []) };
  const unmatched = perField(() => new Map<string, { clients: number; reason: UnmatchedReason }>());
  const matched = perField(() => new Map<string, { valueId: string; label: string; clients: number }>());

  for (const client of [...input.clients].sort((a, b) => a.clientId.localeCompare(b.clientId))) {
    const fills: Partial<Record<LinkField, string>> = {};
    for (const field of LINK_FIELDS) {
      const tally = plan.tally[field];
      const text = client.text[field]?.trim() || null;
      const current = client.link[field];
      const match = text === null ? null : field === "clientManager" ? matchMember(text) : matchLookup(field, text);
      if (current) {
        if (match && "id" in match && match.id !== current) {
          tally.conflicts += 1;
          plan.conflicts.push({ clientId: client.clientId, field, current, matched: match.id });
        } else tally.alreadyLinked += 1;
        continue;
      }
      if (text === null || match === null) { tally.blank += 1; continue; }
      if ("unmatched" in match) {
        tally.unmatched += 1;
        const seen = unmatched[field].get(text);
        unmatched[field].set(text, { clients: (seen?.clients ?? 0) + 1, reason: match.unmatched });
        continue;
      }
      fills[field] = match.id;
      tally.filled += 1;
      if (!match.active) tally.filledToInactive += 1;
      const seen = matched[field].get(text);
      matched[field].set(text, { valueId: match.id, label: match.label, clients: (seen?.clients ?? 0) + 1 });
    }
    if (Object.keys(fills).length > 0) plan.changes.push({ clientId: client.clientId, version: client.version, fills });
  }
  const byCount = <T extends { text: string; clients: number }>(a: T, b: T) => b.clients - a.clients || a.text.localeCompare(b.text);
  for (const field of LINK_FIELDS) {
    plan.unmatched[field] = [...unmatched[field]].map(([text, entry]) => ({ text, ...entry })).sort(byCount);
    plan.matched[field] = [...matched[field]].map(([text, entry]) => ({ text, ...entry })).sort(byCount);
  }
  return plan;
}

class DryRunRollback extends Error {}

export type ClientLinkOutcome = LinkPlan & { committed: boolean; runId: string; clientsInScope: number; clientsChanged: number };

/** Read, plan and write in one tenant transaction; a dry run rolls it back. */
export async function loadV7ClientLinks(pool: PoolLike, organisationId: string, options: { commit: boolean; runId?: string }): Promise<ClientLinkOutcome> {
  const runId = options.runId ?? `${CLIENT_LINK_RUN_PREFIX}${randomUUID()}`;
  let outcome: ClientLinkOutcome | null = null;
  try {
    await withTenantWrite(pool, organisationId, async (db) => {
      outcome = await linkClients(db, organisationId, runId, options.commit);
      if (!options.commit) throw new DryRunRollback();
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  }
  return outcome!;
}

async function linkClients(db: Queryable, org: string, runId: string, commit: boolean): Promise<ClientLinkOutcome> {
  const clients = (await db.query<{
    client_id: string; version: number; sector: string | null; referral: string | null; portfolio: string | null; client_manager: string | null;
    sector_value_id: string | null; referral_value_id: string | null; portfolio_value_id: string | null; client_manager_user_id: string | null;
  }>(
    `SELECT client_id, version, sector, referral, portfolio, client_manager, sector_value_id, referral_value_id, portfolio_value_id, client_manager_user_id
       FROM nzi_console.clients WHERE organisation_id = $1 AND source_system = $2 ORDER BY client_id FOR UPDATE`, [org, SOURCE_SYSTEM])).rows;
  const values = (await db.query<{ value_id: string; category_key: string; label: string; active: boolean }>(
    `SELECT value_id, category_key, label, active FROM nzi_console.reference_values
      WHERE organisation_id = $1 AND category_key IN ('industries', 'referrals', 'portfolios')`, [org])).rows;
  const members = (await db.query<{ user_id: string; display_name: string | null; status: string }>(
    `SELECT user_id, display_name, status FROM nzi_console.memberships WHERE organisation_id = $1`, [org])).rows;

  const plan = planClientLinks({
    clients: clients.map((row) => ({
      clientId: row.client_id, version: row.version,
      text: { sector: row.sector, referral: row.referral, portfolio: row.portfolio, clientManager: row.client_manager },
      link: { sector: row.sector_value_id, referral: row.referral_value_id, portfolio: row.portfolio_value_id, clientManager: row.client_manager_user_id },
    })),
    values: values.map((row) => ({ valueId: row.value_id, category: row.category_key, label: row.label, active: row.active })),
    members: members.map((row) => ({ userId: row.user_id, displayName: row.display_name, status: row.status })),
  });

  for (const change of plan.changes) {
    const fields = Object.keys(change.fills) as LinkField[];
    // Fill-NULL-only, again at the row: the version guard and `IS NULL` make a concurrent edit a failed run, never an overwrite.
    const sets = fields.map((field, index) => `${LINK_COLUMN[field]} = $${index + 4}`).join(", ");
    const guards = fields.map((field) => `${LINK_COLUMN[field]} IS NULL`).join(" AND ");
    const updated = await db.query<{ version: number }>(
      `UPDATE nzi_console.clients SET ${sets}, version = version + 1, updated_at = now()
        WHERE organisation_id = $1 AND client_id = $2 AND version = $3 AND ${guards} RETURNING version`,
      [org, change.clientId, change.version, ...fields.map((field) => change.fills[field])]);
    if (!updated.rows[0]) throw new Error(`client ${change.clientId} changed while the run held it; nothing was written.`);
    const before = Object.fromEntries(fields.map((field) => [LINK_COLUMN[field], null]));
    const after = Object.fromEntries(fields.map((field) => [LINK_COLUMN[field], change.fills[field]]));
    await db.query(
      `INSERT INTO nzi_console.audit_events (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, reason, before_json, after_json, client_id)
       VALUES ($1, $2, $3, 'system', 'client.links.backfilled', 'client', $4, $5, $6, $7::jsonb, $8::jsonb, $4)`,
      [org, randomUUID(), IMPORT_ACTOR, change.clientId, runId, "Client links filled from the v7 text by exact match (admin A4)",
        JSON.stringify({ ...before, version: change.version }),
        JSON.stringify({ ...after, version: updated.rows[0].version, run: runId, sourceSystem: SOURCE_SYSTEM })]);
  }
  return { ...plan, committed: commit, runId, clientsInScope: clients.length, clientsChanged: plan.changes.length };
}
