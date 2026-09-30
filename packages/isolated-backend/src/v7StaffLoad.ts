import { createHash, randomUUID } from "node:crypto";
import { sealMembershipRow } from "./piiWriteThrough";
import type { SealingKeys } from "./piiSealing";
import { withTenantWrite, type PoolLike, type Queryable } from "./postgres";
import { blindIndex } from "./subjectCrypto";
import { IMPORT_ACTOR, SOURCE_SYSTEM } from "./v7ClientImport";
import type { V7Row, V7Table } from "./v7ClientExtract";
import { normaliseLabel } from "./v7LookupLoad";

/**
 * The v7 staff import (admin Phase B, B2, `load:v7-staff`; ruled `phaseB-team-access-plan.md` §3, Q3–Q5). v7's `users`
 * → `memberships`, the roster B1 governs.
 *
 * **Identity is the email's blind index.** v7's `user_id` *is* the email address, so there is no non-personal v7 id to
 * keep (0141 has no `legacy_db_id` on `memberships`): each v7 user is matched to a membership by the keyed digest of
 * its address — the same `email_bidx` the membership already carries — or, in the dual-write era, by the plaintext
 * address beside it. Nothing personal is written beside the sealed columns.
 *
 * **Matched members are enriched, never overruled** (the staff exception to R4: a one-time import, then
 * console-owned):
 * - the **position** is filled when the membership has none, from the one active `positions` value whose label matches
 *   v7's text exactly once normalised — never guessed, never created;
 * - the membership is **stamped** `source_system` / `legacy_values` (v7's role, status, archived flag and position
 *   label as it held them — nothing personal);
 * - **role and status are never imported onto an existing member**, on any run; nor are the name or the address. A
 *   difference is reported, not applied.
 *
 * **Re-runs** — `legacy_values` is what v7 held when last loaded. v7 unchanged → nothing. v7 moved a position the
 * import set and nobody has edited since (`updated_by` still an import run) → v7's new position is applied. Edited here
 * since → refused and reported, and `legacy_values` is left as it was, so the conflict is still visible next time.
 *
 * **Unmatched v7 users are created only when named** (`create`, by the stable `ref` the dry run prints — ruled Q3:
 * default none): an opaque UUID (Q4), always **Viewer** (v7's roles are all Admin or SuperAdmin and mean nothing
 * here), `active` — or `deactivated` for a v7 user who is Disabled or archived — sealed on write (NZC-119). No mobile
 * (Q5). A v7 user who is not `internal` (a portal login) is refused: portal people are `portal_users`.
 *
 * **No personal data leaves this module except to the operator's terminal.** The outcome carries membership ids,
 * refs, flags and field names; the names of unmatched people are held apart (`namesForOperator`) for the CLI to print
 * on request to stderr, never into a report. Audit payloads are ids, versions, position value ids and field names.
 *
 * One transaction; a dry run is the whole load, rolled back.
 */

export const STAFF_RUN_PREFIX = "v7-staff-";
export const V7_STAFF_TABLES: readonly V7Table[] = ["users"];

const collapse = (value: string | null | undefined) => (value ?? "").trim().replace(/\s+/g, " ");
const flag = (value: string | null | undefined): boolean | null => {
  const v = value?.trim().toLowerCase();
  return v === "t" || v === "true" || v === "1" ? true : v === "f" || v === "false" || v === "0" ? false : null;
};

// ── The plan (pure; held in memory only) ──────────────────────────────────────────────────────────────────────

export type LegacyStaffValues = { role: string | null; status: string | null; archived: boolean | null; position: string | null };
export type PlannedStaff = {
  email: string; name: string; active: boolean; positionLabel: string | null; legacyValues: LegacyStaffValues;
};
export type StaffPlan = { staff: PlannedStaff[]; refused: Array<{ reason: string; count: number }>; v7: { total: number; active: number; inactive: number } };

export function planV7Staff(extract: Partial<Record<V7Table, readonly V7Row[]>>): StaffPlan {
  const rows = extract.users ?? [];
  const refusals = new Map<string, number>();
  const refuse = (reason: string) => refusals.set(reason, (refusals.get(reason) ?? 0) + 1);
  const byEmail = new Map<string, V7Row[]>();
  for (const row of rows) {
    const email = collapse(row.email).toLowerCase();
    if (!email || !email.includes("@")) { refuse("a v7 user with no usable email address"); continue; }
    if ((collapse(row.user_type) || "internal").toLowerCase() !== "internal") { refuse("a v7 user who is not internal staff (a portal login) — portal people are portal_users"); continue; }
    byEmail.set(email, [...(byEmail.get(email) ?? []), row]);
  }
  const staff: PlannedStaff[] = [];
  for (const [email, group] of [...byEmail.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (group.length > 1) { refuse("an email address two v7 users share"); continue; }
    const row = group[0]!;
    const status = collapse(row.status) || null;
    const archived = flag(row.archived);
    const position = collapse(row.position) || null;
    staff.push({
      email, name: collapse(row.full_name) || email, active: (status ?? "").toLowerCase() === "active" && archived !== true,
      positionLabel: position, legacyValues: { role: collapse(row.role) || null, status, archived, position },
    });
  }
  return {
    staff, refused: [...refusals.entries()].map(([reason, count]) => ({ reason, count })),
    v7: { total: rows.length, active: staff.filter((person) => person.active).length, inactive: staff.filter((person) => !person.active).length },
  };
}

// ── The load ──────────────────────────────────────────────────────────────────────────────────────────────────

export type MatchedOutcome = {
  userId: string; changed: string[];
  /** Reported, never applied: name differs, v7 disabled while active here, a position set here that v7 disagrees with… */
  notes: string[];
  conflict: string | null;
};
export type UnmatchedOutcome = { ref: string; v7Active: boolean; positionLabel: string | null; created: { userId: string; status: "active" | "deactivated" } | null };
export type StaffOutcome = {
  committed: boolean; runId: string;
  matched: MatchedOutcome[]; unmatched: UnmatchedOutcome[];
  positions: { filled: number; unmatchedLabels: number; ambiguousLabels: number };
  refused: StaffPlan["refused"];
  parity: { v7Active: number; v7Inactive: number; consoleActive: number; consoleDeactivated: number; consoleNotFromV7: number };
  /** For the operator's terminal only — never a report: the names of v7 users with no membership, by ref. */
  namesForOperator: Array<{ ref: string; name: string }>;
};

class DryRunRollback extends Error {}
/** A short, stable handle for a v7 user, derived from the address digest — reveals nothing, and is the same every run. */
const refOf = (digest: string) => createHash("sha256").update(digest).digest("hex").slice(0, 10);
const byImport = (updatedBy: string | null) => updatedBy === null || updatedBy.startsWith(STAFF_RUN_PREFIX);
const sameLegacy = (a: unknown, b: LegacyStaffValues) => {
  const x = (a ?? {}) as Partial<LegacyStaffValues>;
  return x.role === b.role && x.status === b.status && x.archived === b.archived && x.position === b.position;
};

type Member = {
  user_id: string; email: string | null; email_bidx: string | null; display_name: string | null; status: string;
  position_value_id: string | null; source_system: string | null; legacy_values: unknown; updated_by: string | null; version: number;
};

export async function loadV7Staff(
  pool: PoolLike, organisationId: string, plan: StaffPlan,
  options: { commit: boolean; keys: SealingKeys; create?: readonly string[]; runId?: string },
): Promise<StaffOutcome> {
  const runId = options.runId ?? `${STAFF_RUN_PREFIX}${randomUUID()}`;
  if (!runId.startsWith(STAFF_RUN_PREFIX)) throw new Error(`A staff run id must start ${STAFF_RUN_PREFIX} — it is how a re-run knows a row is still as an import wrote it.`);
  const create = new Set(options.create ?? []);
  const outcome: StaffOutcome = {
    committed: options.commit, runId, matched: [], unmatched: [], positions: { filled: 0, unmatchedLabels: 0, ambiguousLabels: 0 },
    refused: plan.refused, parity: { v7Active: plan.v7.active, v7Inactive: plan.v7.inactive, consoleActive: 0, consoleDeactivated: 0, consoleNotFromV7: 0 },
    namesForOperator: [],
  };
  try {
    await withTenantWrite(pool, organisationId, async (db) => {
      const { rows: members } = await db.query<Member>(
        `SELECT user_id, email, email_bidx, display_name, status, position_value_id, source_system, legacy_values, updated_by, version
           FROM nzi_console.memberships WHERE organisation_id = $1 ORDER BY user_id FOR UPDATE`, [organisationId]);
      const positions = (await db.query<{ value_id: string; label: string }>(
        `SELECT value_id, label FROM nzi_console.reference_values WHERE organisation_id = $1 AND category_key = 'positions' AND active`, [organisationId])).rows;
      const positionFor = (label: string | null): { id: string | null; problem: "unmatched" | "ambiguous" | null } => {
        if (label === null) return { id: null, problem: null };
        const found = positions.filter((value) => normaliseLabel(value.label) === normaliseLabel(label));
        return found.length === 1 ? { id: found[0]!.value_id, problem: null } : { id: null, problem: found.length === 0 ? "unmatched" : "ambiguous" };
      };
      const planned = plan.staff.map((person) => ({ person, digest: blindIndex("memberships.email", person.email, options.keys.indexKey)! }));
      const refs = new Set(planned.map((entry) => refOf(entry.digest)));
      const unknown = [...create].filter((ref) => !refs.has(ref));
      if (unknown.length) throw new Error(`--create names ${unknown.join(", ")}, which no v7 user in this extract has.`);

      for (const { person, digest } of planned) {
        const ref = refOf(digest);
        const matches = members.filter((member) => member.email_bidx === digest || (member.email !== null && member.email.trim().toLowerCase() === person.email));
        const position = positionFor(person.positionLabel);
        if (position.problem === "unmatched") outcome.positions.unmatchedLabels += 1;
        if (position.problem === "ambiguous") outcome.positions.ambiguousLabels += 1;

        if (matches.length > 1) { outcome.refused.push({ reason: `v7 user ${ref} matches ${matches.length} memberships`, count: 1 }); continue; }
        const member = matches[0];
        if (!member) {
          const entry: UnmatchedOutcome = { ref, v7Active: person.active, positionLabel: person.positionLabel, created: null };
          outcome.unmatched.push(entry);
          outcome.namesForOperator.push({ ref, name: person.name });
          if (!create.has(ref)) continue;
          const userId = randomUUID();
          const status = person.active ? "active" as const : "deactivated" as const;
          await db.query(
            `INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name, email, position_value_id, source_system, legacy_values,
               deactivated_at, deactivated_by, updated_at, updated_by)
             VALUES ($1, $2, 'viewer', $3, $4, $5, $6, $7, $8::jsonb, CASE WHEN $3 = 'deactivated' THEN now() END, CASE WHEN $3 = 'deactivated' THEN $9 END, now(), $9)`,
            [organisationId, userId, status, person.name, person.email, position.id, SOURCE_SYSTEM, JSON.stringify(person.legacyValues), runId]);
          await sealMembershipRow({ db, organisationId, actorId: IMPORT_ACTOR, keys: options.keys }, { userId, displayName: person.name, email: person.email });
          await auditMember(db, organisationId, runId, userId, null, { version: 1, positionValueId: position.id, status, changed: ["created"] });
          entry.created = { userId, status };
          if (position.id) outcome.positions.filled += 1;
          continue;
        }

        const result: MatchedOutcome = { userId: member.user_id, changed: [], notes: [], conflict: null };
        outcome.matched.push(result);
        if (collapse(member.display_name) !== person.name) result.notes.push("the name here differs from v7's — kept as it is here");
        if (!person.active && member.status === "active") result.notes.push("v7 has this person disabled; active here — not applied (status is the console's)");
        if (person.active && member.status === "deactivated") result.notes.push("v7 has this person active; deactivated here — not applied");

        const previous = member.legacy_values as Partial<LegacyStaffValues> | null;
        const v7Changed = member.source_system !== null && !sameLegacy(previous, person.legacyValues);
        let nextPosition = member.position_value_id;
        if (member.position_value_id === null) {
          if (position.id) { nextPosition = position.id; result.changed.push("positionValueId"); }
        } else if (member.position_value_id !== position.id && position.id !== null) {
          // Set by an earlier import, from v7's earlier label, and untouched since: v7's move follows. Otherwise, reported.
          const importSet = member.source_system !== null && byImport(member.updated_by) && positionFor(previous?.position ?? null).id === member.position_value_id;
          if (importSet && v7Changed) { nextPosition = position.id; result.changed.push("positionValueId"); }
          else if (importSet) result.notes.push("the position here differs from v7's");
          else result.conflict = "the position was set here and v7 holds another — not applied";
        }
        const stamp = member.source_system === null;
        if (stamp) result.changed.push("sourceSystem");
        // A conflict keeps the old legacy_values, so it is still a conflict on the next run rather than quietly absorbed.
        const legacyNext = result.conflict ? member.legacy_values : person.legacyValues;
        const legacyChanged = !stamp && !result.conflict && v7Changed;
        if (legacyChanged) result.changed.push("legacyValues");
        if (result.changed.length === 0) continue;
        const { rows: [saved] } = await db.query<{ version: number }>(
          `UPDATE nzi_console.memberships SET position_value_id = $3, source_system = $4, legacy_values = $5::jsonb, version = version + 1, updated_at = now(),
                  updated_by = CASE WHEN updated_by IS NULL OR updated_by LIKE '${STAFF_RUN_PREFIX}%' THEN $6 ELSE updated_by END
            WHERE organisation_id = $1 AND user_id = $2 RETURNING version`,
          [organisationId, member.user_id, nextPosition, SOURCE_SYSTEM, JSON.stringify(legacyNext), runId]);
        if (result.changed.includes("positionValueId")) outcome.positions.filled += 1;
        await auditMember(db, organisationId, runId, member.user_id,
          { version: member.version, positionValueId: member.position_value_id, sourceSystem: member.source_system },
          { version: saved!.version, positionValueId: nextPosition, status: member.status, changed: result.changed });
      }

      const { rows: [parity] } = await db.query<{ active: number; deactivated: number; other: number }>(
        `SELECT count(*) FILTER (WHERE source_system = $2 AND status = 'active')::int AS active,
                count(*) FILTER (WHERE source_system = $2 AND status = 'deactivated')::int AS deactivated,
                count(*) FILTER (WHERE source_system IS NULL)::int AS other
           FROM nzi_console.memberships WHERE organisation_id = $1`, [organisationId, SOURCE_SYSTEM]);
      outcome.parity.consoleActive = parity?.active ?? 0;
      outcome.parity.consoleDeactivated = parity?.deactivated ?? 0;
      outcome.parity.consoleNotFromV7 = parity?.other ?? 0;

      const changed = outcome.matched.filter((entry) => entry.changed.length > 0).length;
      const created = outcome.unmatched.filter((entry) => entry.created).length;
      if (changed + created > 0) {
        await db.query(
          `INSERT INTO nzi_console.audit_events (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, reason, after_json)
           VALUES ($1, $2, $3, 'system', 'staff.roster.imported', 'organisation', $1, $4, $5, $6::jsonb)`,
          [organisationId, randomUUID(), IMPORT_ACTOR, runId, "Staff roster reconciled from NZ Insights Pro v7 (admin B2)",
            JSON.stringify({ run: runId, sourceSystem: SOURCE_SYSTEM, matched: outcome.matched.length, changed, created, unmatched: outcome.unmatched.length,
              conflicts: outcome.matched.filter((entry) => entry.conflict).length, positionsFilled: outcome.positions.filled })]);
      }
      if (!options.commit) throw new DryRunRollback();
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  }
  return outcome;
}

/** One membership's import event: ids, versions, position value ids and field names — never a name or an address. */
async function auditMember(db: Queryable, org: string, runId: string, userId: string, before: Record<string, unknown> | null, after: Record<string, unknown>) {
  await db.query(
    `INSERT INTO nzi_console.audit_events (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, reason, before_json, after_json)
     VALUES ($1, $2, $3, 'system', 'staff.imported', 'membership', $4, $5, $6, $7::jsonb, $8::jsonb)`,
    [org, randomUUID(), IMPORT_ACTOR, userId, runId, "Imported from NZ Insights Pro v7 (admin B2)", before === null ? null : JSON.stringify(before),
      JSON.stringify({ userId, run: runId, sourceSystem: SOURCE_SYSTEM, ...after })]);
}
