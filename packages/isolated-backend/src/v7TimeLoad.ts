import { createHash, randomUUID } from "node:crypto";
import { TIME_ACTIVITY_CATEGORY, TIME_ENTRY_MAX_MINUTES, TIME_ENTRY_NOTE_MAX, todayInLondon } from "@nzi/contracts";
import type { SealingKeys } from "./piiSealing";
import { withTenantWrite, type PoolLike } from "./postgres";
import { blindIndex } from "./subjectCrypto";
import { IMPORT_ACTOR, SOURCE_SYSTEM } from "./v7ClientImport";
import type { V7Row, V7Table } from "./v7ClientExtract";
import { emptyCategoryOutcome, loadCategory, LOOKUP_RUN_PREFIX, normaliseLabel, planLookupTable, type LookupCategoryOutcome, type LookupPlan } from "./v7LookupLoad";

/**
 * The v7 time import (⚑7, `load:v7-time`; kickoff `V7-time-import-loader-kickoff.md`). v7's `time_logs` →
 * `time_entries`, after v7's `time_subjects` → `activity_types` — one transaction, so the activities and the time that
 * uses them land together; a dry run is the whole load, rolled back.
 *
 * **Step 1 — the subjects.** Reconciled into `activity_types` by the lookup import's own rules (v7 identity → normalised
 * label → inserted; R4 on re-runs). Each v7 subject's value gets its `time_activity_defaults` row, **billable** (⚑3 —
 * client-facing delivery), where it has none; a default already set here is kept and reported, never overwritten.
 *
 * **Step 2 — the entries.** One v7 row → one entry, minutes 1:1 (⚑1), as many a day as v7 holds (⚑2):
 * - **person** by the email's blind index — the staff import's match, the same `email_bidx` the membership carries — or
 *   the plaintext address beside it. **Unmatched → reported by ref, never guessed**, and not imported;
 * - **job** by the job import's identity (`source_system`, `legacy_db_id` = v7 `job_id`); a job not imported → reported;
 * - **activity** by the subject's normalised label, among `activity_types` values (the seeded six and the subjects);
 *   unmatched → reported by label, for a ruling (add it as a value, or leave those entries out);
 * - **billable** from the activity's default; **billed_ref** null (v7 never billed time);
 * - **rates** snapshotted from the person's `staff_rates` row **in force on the work date** (latest `effective_from` on
 *   or before it, not superseded) — **else null, "rate not recorded"**: never today's rate, never 0 (T-Q1).
 * Refused and reported, never clamped: no or non-positive minutes, **more than 24 hours** (0155's CHECK), no work date,
 * a work date **after today** (the console refuses future time), a note longer than 2,000 characters.
 *
 * **Idempotent** through 0155's unique legacy index: a v7 entry already imported is never written twice. One changed in
 * v7 since is reported, not re-applied — an imported entry is the person's own from then on.
 *
 * **No money and no personal data in the outcome, the report or the audit** (NZC-120): counts, classes, refs and
 * activity labels. *That* a rate was in force is counted; the figure is never read out. Addresses of unmatched people go
 * to the operator's terminal only, on request.
 */

export const TIME_RUN_PREFIX = "v7-time-";
export const V7_TIME_TABLES: readonly V7Table[] = ["time_subjects", "time_logs"];
/** Before this, a work date is imported but reported as far past — likely a data-entry slip. */
export const FAR_PAST = "2015-01-01";

const text = (value: string | null | undefined) => { const trimmed = value?.trim(); return trimmed ? trimmed : null; };
const day = (value: string | null | undefined) => { const v = text(value)?.slice(0, 10); return v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : null; };

// ── The plan (pure) ───────────────────────────────────────────────────────────────────────────────────────────

/** What v7 held, kept on the entry as provenance — never the person's address, never the note (it is the `note`). */
export type LegacyTimeValues = { jobId: string; subject: string | null; workDate: string; minutes: number; createdAt: string | null };
export type PlannedEntry = {
  legacyDbId: string; email: string; jobLegacyId: string; subject: string | null; workDate: string; minutes: number;
  note: string | null; farPast: boolean; legacyValues: LegacyTimeValues;
};
export type TimeRefusal =
  | "no-minutes" | "over-24-hours" | "no-work-date" | "future-work-date" | "user-not-an-email" | "no-job" | "note-too-long" | "duplicate-id";
export const TIME_REFUSALS: Record<TimeRefusal, string> = {
  "no-minutes": "no minutes, or zero or fewer",
  "over-24-hours": "more than 24 hours in one entry (0155 refuses it; skipped, not clamped)",
  "no-work-date": "no work date",
  "future-work-date": "a work date after today (London) — the console refuses future time",
  "user-not-an-email": "a v7 user id that is not an email address, so no person can be matched",
  "no-job": "no job id",
  "note-too-long": `a note longer than ${TIME_ENTRY_NOTE_MAX} characters`,
  "duplicate-id": "a v7 time id that appears twice in the extract",
};
export type TimePlan = {
  subjects: LookupPlan;
  entries: PlannedEntry[];
  refused: Partial<Record<TimeRefusal, number>>;
  v7: { entries: number; minutes: number };
};

export function planV7Time(extract: Partial<Record<V7Table, readonly V7Row[]>>, today: string = todayInLondon()): TimePlan {
  const subjects: LookupPlan = { categories: [], skipped: [] };
  planLookupTable(extract, { table: "time_subjects", category: TIME_ACTIVITY_CATEGORY, id: "subject_id" }, subjects);
  const refused: TimePlan["refused"] = {};
  const refuse = (reason: TimeRefusal) => { refused[reason] = (refused[reason] ?? 0) + 1; };
  const rows = extract.time_logs ?? [];
  const seen = new Map<string, number>();
  for (const row of rows) { const id = text(row.time_id); if (id) seen.set(id, (seen.get(id) ?? 0) + 1); }
  const entries: PlannedEntry[] = [];
  let minutesTotal = 0;
  for (const row of [...rows].sort((a, b) => Number(a.time_id) - Number(b.time_id))) {
    const legacyDbId = text(row.time_id);
    const minutes = Number(text(row.minutes));
    if (Number.isFinite(minutes)) minutesTotal += minutes;
    if (!legacyDbId || (seen.get(legacyDbId) ?? 0) > 1) { refuse("duplicate-id"); continue; }
    if (!Number.isInteger(minutes) || minutes <= 0) { refuse("no-minutes"); continue; }
    if (minutes > TIME_ENTRY_MAX_MINUTES) { refuse("over-24-hours"); continue; }
    const workDate = day(row.work_date);
    if (!workDate) { refuse("no-work-date"); continue; }
    if (workDate > today) { refuse("future-work-date"); continue; }
    const email = text(row.user_id)?.toLowerCase() ?? "";
    if (!email.includes("@")) { refuse("user-not-an-email"); continue; }
    const jobLegacyId = text(row.job_id);
    if (!jobLegacyId) { refuse("no-job"); continue; }
    const note = text(row.notes);
    if (note !== null && note.length > TIME_ENTRY_NOTE_MAX) { refuse("note-too-long"); continue; }
    const subject = text(row.subject)?.replace(/\s+/g, " ") ?? null;
    entries.push({
      legacyDbId, email, jobLegacyId, subject, workDate, minutes, note, farPast: workDate < FAR_PAST,
      legacyValues: { jobId: jobLegacyId, subject, workDate, minutes, createdAt: text(row.created_at) },
    });
  }
  return { subjects, entries, refused, v7: { entries: rows.length, minutes: minutesTotal } };
}

// ── The load ──────────────────────────────────────────────────────────────────────────────────────────────────

export type TimeOutcome = {
  committed: boolean; runId: string;
  /** Step 1: v7's subjects into activity_types, and the billable defaults made or kept. */
  subjects: LookupCategoryOutcome & { defaultsCreated: number; defaultsKept: Array<{ label: string; billableDefault: boolean }> };
  refused: TimePlan["refused"];
  inserted: number;
  alreadyImported: number;
  /** Imported before, and v7's row differs now — reported, not re-applied. */
  changedInV7: number;
  unmatchedUsers: Array<{ ref: string; entries: number }>;
  ambiguousUsers: Array<{ ref: string; entries: number }>;
  jobNotImported: number;
  /** By label, for a ruling: add the subject as an activity value, or leave these entries out. */
  unmatchedSubjects: Array<{ label: string; entries: number }>;
  noSubject: number;
  rates: { recorded: number; notRecorded: number };
  farPast: number;
  /** v7's minutes on the entries written or already present, against the console's for this source — they must agree. */
  parity: { plannedMinutes: number; consoleMinutes: number; consoleEntries: number };
  /** For the operator's terminal only — never a report: the addresses behind the unmatched refs. */
  addressesForOperator: Array<{ ref: string; email: string }>;
};

class DryRunRollback extends Error {}
const refOf = (digest: string) => createHash("sha256").update(digest).digest("hex").slice(0, 10);
const sameLegacy = (a: unknown, b: LegacyTimeValues) => {
  const x = (a ?? {}) as Partial<LegacyTimeValues>;
  return x.jobId === b.jobId && x.subject === b.subject && x.workDate === b.workDate && x.minutes === b.minutes;
};
type Rate = { rate_id: string; user_id: string; effective_from: string; cost: string | null; sell: string | null; currency: string; recorded_at: string; superseded: boolean };

export async function loadV7Time(
  pool: PoolLike, organisationId: string, plan: TimePlan,
  options: { commit: boolean; keys: SealingKeys; runId?: string },
): Promise<TimeOutcome> {
  const runId = options.runId ?? `${TIME_RUN_PREFIX}${randomUUID()}`;
  if (!runId.startsWith(TIME_RUN_PREFIX)) throw new Error(`A time run id must start ${TIME_RUN_PREFIX}.`);
  // The subjects are reconciled under a lookup run id, so a later load:v7-lookups-style re-run reads them as import-written (R4).
  const lookupRunId = `${LOOKUP_RUN_PREFIX}${runId.slice(TIME_RUN_PREFIX.length)}`;
  const subjectValues = plan.subjects.categories[0]?.values ?? [];
  const outcome: TimeOutcome = {
    committed: options.commit, runId,
    subjects: { ...emptyCategoryOutcome(TIME_ACTIVITY_CATEGORY, subjectValues), defaultsCreated: 0, defaultsKept: [] },
    refused: { ...plan.refused }, inserted: 0, alreadyImported: 0, changedInV7: 0,
    unmatchedUsers: [], ambiguousUsers: [], jobNotImported: 0, unmatchedSubjects: [], noSubject: 0,
    rates: { recorded: 0, notRecorded: 0 }, farPast: 0, parity: { plannedMinutes: 0, consoleMinutes: 0, consoleEntries: 0 }, addressesForOperator: [],
  };
  try {
    await withTenantWrite(pool, organisationId, async (db) => {
      // ── Step 1: the subjects, and their billable defaults ────────────────────────────────────────────────────
      const placed = await loadCategory(db, organisationId, TIME_ACTIVITY_CATEGORY, subjectValues, lookupRunId, outcome.subjects);
      for (const valueId of new Set(placed.values())) {
        const { rows: [held] } = await db.query<{ billable_default: boolean; label: string }>(
          `SELECT d.billable_default, v.label FROM nzi_console.reference_values v
             LEFT JOIN nzi_console.time_activity_defaults d ON (d.organisation_id, d.value_id) = (v.organisation_id, v.value_id)
            WHERE v.organisation_id = $1 AND v.value_id = $2`, [organisationId, valueId]);
        if (held && held.billable_default !== null) { outcome.subjects.defaultsKept.push({ label: held.label, billableDefault: held.billable_default }); continue; }
        await db.query(
          `INSERT INTO nzi_console.time_activity_defaults (organisation_id, value_id, billable_default, created_by, updated_by) VALUES ($1, $2, true, $3, $3)`,
          [organisationId, valueId, runId]);
        outcome.subjects.defaultsCreated += 1;
      }

      // ── Step 2: what the entries map onto ───────────────────────────────────────────────────────────────────
      const { rows: activities } = await db.query<{ value_id: string; label: string; active: boolean; billable_default: boolean | null }>(
        `SELECT v.value_id, v.label, v.active, d.billable_default FROM nzi_console.reference_values v
           LEFT JOIN nzi_console.time_activity_defaults d ON (d.organisation_id, d.value_id) = (v.organisation_id, v.value_id)
          WHERE v.organisation_id = $1 AND v.category_key = $2`, [organisationId, TIME_ACTIVITY_CATEGORY]);
      const activityFor = (label: string) => {
        const found = activities.filter((value) => value.billable_default !== null && normaliseLabel(value.label) === normaliseLabel(label));
        return found.find((value) => value.active) ?? found[0] ?? null;
      };
      const { rows: members } = await db.query<{ user_id: string; email: string | null; email_bidx: string | null }>(
        `SELECT user_id, email, email_bidx FROM nzi_console.memberships WHERE organisation_id = $1`, [organisationId]);
      const { rows: jobs } = await db.query<{ job_id: string; legacy_db_id: string }>(
        `SELECT job_id, legacy_db_id FROM nzi_console.jobs WHERE organisation_id = $1 AND source_system = $2`, [organisationId, SOURCE_SYSTEM]);
      const jobFor = new Map(jobs.map((job) => [job.legacy_db_id, job.job_id]));
      const { rows: rates } = await db.query<Rate>(
        `SELECT r.rate_id, r.user_id, r.effective_from::text AS effective_from, r.cost_per_hour::text AS cost, r.sell_per_hour::text AS sell, r.currency,
                r.recorded_at::text AS recorded_at,
                EXISTS (SELECT 1 FROM nzi_console.staff_rates s WHERE s.organisation_id = r.organisation_id AND s.supersedes_rate_id = r.rate_id) AS superseded
           FROM nzi_console.staff_rates r WHERE r.organisation_id = $1`, [organisationId]);
      const ratesOf = new Map<string, Rate[]>();
      for (const rate of rates.filter((r) => !r.superseded && (r.cost !== null || r.sell !== null))) ratesOf.set(rate.user_id, [...(ratesOf.get(rate.user_id) ?? []), rate]);
      for (const list of ratesOf.values()) list.sort((a, b) => b.effective_from.localeCompare(a.effective_from) || b.recorded_at.localeCompare(a.recorded_at));
      /** T-Q1: the row in force on the day — never today's, never invented. */
      const rateOn = (userId: string, workDate: string) => ratesOf.get(userId)?.find((rate) => rate.effective_from <= workDate) ?? null;
      const { rows: imported } = await db.query<{ legacy_db_id: string; legacy_values: unknown }>(
        `SELECT legacy_db_id, legacy_values FROM nzi_console.time_entries WHERE organisation_id = $1 AND source_system = $2`, [organisationId, SOURCE_SYSTEM]);
      const already = new Map(imported.map((row) => [row.legacy_db_id, row.legacy_values]));

      // ── Step 2: the entries ─────────────────────────────────────────────────────────────────────────────────
      const people = new Map<string, { userId: string | null; ref: string; ambiguous: boolean }>();
      const personFor = (email: string) => {
        let person = people.get(email);
        if (!person) {
          const digest = blindIndex("memberships.email", email, options.keys.indexKey)!;
          const matches = members.filter((member) => member.email_bidx === digest || (member.email !== null && member.email.trim().toLowerCase() === email));
          person = { userId: matches.length === 1 ? matches[0]!.user_id : null, ref: refOf(digest), ambiguous: matches.length > 1 };
          people.set(email, person);
        }
        return person;
      };
      const unmatched = new Map<string, number>(), ambiguous = new Map<string, number>(), subjectsMissing = new Map<string, number>();
      const rows: unknown[][] = [];
      for (const entry of plan.entries) {
        const person = personFor(entry.email);
        if (person.ambiguous) { ambiguous.set(person.ref, (ambiguous.get(person.ref) ?? 0) + 1); continue; }
        if (!person.userId) {
          unmatched.set(person.ref, (unmatched.get(person.ref) ?? 0) + 1);
          if (!outcome.addressesForOperator.some((item) => item.ref === person.ref)) outcome.addressesForOperator.push({ ref: person.ref, email: entry.email });
          continue;
        }
        const jobId = jobFor.get(entry.jobLegacyId);
        if (!jobId) { outcome.jobNotImported += 1; continue; }
        if (entry.subject === null) { outcome.noSubject += 1; continue; }
        const activity = activityFor(entry.subject);
        if (!activity) { subjectsMissing.set(entry.subject, (subjectsMissing.get(entry.subject) ?? 0) + 1); continue; }
        outcome.parity.plannedMinutes += entry.minutes;
        if (already.has(entry.legacyDbId)) {
          outcome.alreadyImported += 1;
          if (!sameLegacy(already.get(entry.legacyDbId), entry.legacyValues)) outcome.changedInV7 += 1;
          continue;
        }
        const rate = rateOn(person.userId, entry.workDate);
        if (rate) outcome.rates.recorded += 1; else outcome.rates.notRecorded += 1;
        if (entry.farPast) outcome.farPast += 1;
        rows.push([`v7-time-${entry.legacyDbId}`, person.userId, jobId, entry.workDate, entry.minutes, activity.value_id, activity.billable_default, entry.note,
          rate?.rate_id ?? null, rate?.cost ?? null, rate?.sell ?? null, rate ? rate.currency : null, entry.legacyDbId, JSON.stringify(entry.legacyValues)]);
      }
      for (let start = 0; start < rows.length; start += 500) {
        const chunk = rows.slice(start, start + 500);
        const values: unknown[] = [organisationId, runId, SOURCE_SYSTEM];
        const tuples = chunk.map((row) => {
          const at = values.length;
          values.push(...row);
          const p = (i: number) => `$${at + i + 1}`;
          return `($1, ${p(0)}, ${p(1)}, ${p(2)}, ${p(3)}::date, ${p(4)}::int, ${p(5)}, ${p(6)}::boolean, ${p(7)}, ${p(8)}, ${p(9)}::numeric, ${p(10)}::numeric, ${p(11)}, $2, $2, $3, ${p(12)}, ${p(13)}::jsonb)`;
        });
        await db.query(
          `INSERT INTO nzi_console.time_entries (organisation_id, entry_id, user_id, job_id, work_date, minutes, activity_value_id, billable, note,
             rate_id, cost_rate, charge_rate, rate_currency, created_by, updated_by, source_system, legacy_db_id, legacy_values)
           VALUES ${tuples.join(", ")}`, values);
        outcome.inserted += chunk.length;
      }
      outcome.unmatchedUsers = [...unmatched.entries()].map(([ref, entries]) => ({ ref, entries })).sort((a, b) => b.entries - a.entries || a.ref.localeCompare(b.ref));
      outcome.ambiguousUsers = [...ambiguous.entries()].map(([ref, entries]) => ({ ref, entries }));
      outcome.unmatchedSubjects = [...subjectsMissing.entries()].map(([label, entries]) => ({ label, entries })).sort((a, b) => b.entries - a.entries || a.label.localeCompare(b.label));

      const { rows: [parity] } = await db.query<{ minutes: string; entries: string }>(
        `SELECT coalesce(sum(minutes), 0)::text AS minutes, count(*)::text AS entries FROM nzi_console.time_entries WHERE organisation_id = $1 AND source_system = $2`,
        [organisationId, SOURCE_SYSTEM]);
      outcome.parity.consoleMinutes = Number(parity?.minutes ?? 0);
      outcome.parity.consoleEntries = Number(parity?.entries ?? 0);

      if (outcome.inserted > 0 || outcome.subjects.defaultsCreated > 0) {
        // One event for the run: counts and classes — no figure, no person, no address (NZC-120).
        await db.query(
          `INSERT INTO nzi_console.audit_events (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, reason, after_json)
           VALUES ($1, $2, $3, 'system', 'time.entries.imported', 'organisation', $1, $4, $5, $6::jsonb)`,
          [organisationId, randomUUID(), IMPORT_ACTOR, runId, "Time imported from NZ Insights Pro v7 (⚑7)",
            JSON.stringify({ run: runId, sourceSystem: SOURCE_SYSTEM, inserted: outcome.inserted, alreadyImported: outcome.alreadyImported, changedInV7: outcome.changedInV7,
              refused: outcome.refused, unmatchedUsers: outcome.unmatchedUsers.length, jobNotImported: outcome.jobNotImported,
              unmatchedSubjects: outcome.unmatchedSubjects.reduce((sum, item) => sum + item.entries, 0), noSubject: outcome.noSubject,
              ratesRecorded: outcome.rates.recorded, ratesNotRecorded: outcome.rates.notRecorded, defaultsCreated: outcome.subjects.defaultsCreated })]);
      }
      if (!options.commit) throw new DryRunRollback();
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  }
  return outcome;
}
