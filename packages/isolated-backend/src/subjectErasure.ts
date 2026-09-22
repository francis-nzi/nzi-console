import { randomUUID } from "node:crypto";
import { requireCapability, type StaffPrincipal } from "./auth";
import {
  attributionOf, indexColumnOf, isAttributable, PII_COLUMNS, PII_TABLES, sealedColumnOf,
  type PiiColumn,
} from "./piiInventory";
import { resolveSubjectData, type ResolvedSubject } from "./subjectResolution";
import { withTenantWrite, type PoolLike, type Queryable } from "./postgres";
import { carveoutsFor, pendingCarveoutFor, pendingCarveouts, type RetentionCarveout } from "./retentionCarveouts";
import type { SealingKeys } from "./piiSealing";

/**
 * Erasure — the right to be forgotten, and the point at which the whole arrangement either works or
 * does not (NZC-136).
 *
 * ## What is destroyed, and what deliberately is not
 *
 * Readability, not rows. The subject's key is shredded, the plaintext kept beside each ciphertext is
 * nulled, and every blind index and linkage digest is nulled. Foreign keys still resolve, provenance
 * still records that somebody did something, history still records that a value changed. What is gone is
 * the ability to say who — which is what a tombstone is, and why erasure does not leave a hole where a
 * person used to be (NZC-117).
 *
 * ## Why nulling the plaintext is not optional
 *
 * A key-shred alone is not an erasure today. 0100 kept each plaintext column beside its new ciphertext,
 * to be dropped wholesale once the ciphertext is the only copy — so shredding the key makes
 * `full_name_sealed` unreadable and leaves `full_name` sitting next to it in the clear. Erasure
 * therefore does both, and where it cannot do the second it says so rather than counting the column.
 *
 * ## The two things it cannot yet finish
 *
 * Neither is a surprise and both are named in the manifest rather than skipped:
 *
 *   * **`auth-bridge`** — seven columns across `trainees`, `trainee_email_changes` and
 *     `staff_credentials` have a `shred-key` treatment and are not sealed yet, because the write path
 *     that would seal them runs as the authentication role and cannot reach the subject tables
 *     (NZC-132). There is no ciphertext, so a shred reaches nothing, and nulling the plaintext alone
 *     would destroy a live login rather than erase a person.
 *
 *   * **`plaintext-drop`** — `client_contact_versions.snapshot_json` and
 *     `portal_report_comments.author_display_name` are on append-only tables. The ciphertext is
 *     shredded with everything else; the plaintext cannot be nulled by any runtime role, so it stays
 *     readable until those columns are dropped.
 *
 * A subject holding either is **`erasure-partial`**, never `erased`. Re-running after the prerequisite
 * lands is what promotes them, which is the same mechanism as resuming a failure.
 */

export type ErasureOutcome =
  /** There was something of this person's here, and it is gone. */
  | "erased"
  /** Held, and deliberately kept — with the basis for keeping it. */
  | "retained"
  /** This organisation holds nothing of this kind for this person, so there was nothing to erase. */
  | "nothing-held"
  /** Theirs, still readable, and this system cannot yet reach it. The reason a subject stays partial. */
  | "pending";
export type ErasurePrerequisite =
  /** The write path that would seal these columns cannot reach them yet (NZC-132). */
  | "auth-bridge"
  /** The ciphertext is shredded; the plaintext beside it is on a table no runtime role may update. */
  | "plaintext-drop"
  /**
   * Nobody has decided what should happen to this data (NZC-139, NZC-140, NZC-142).
   *
   * Unlike the other two, this one is not waiting on engineering. It blocks anyway, and it blocks for
   * the stronger reason: the other two are things we know we must do and cannot yet; this is a thing
   * we do not yet know whether we may do. Guessing either way — shredding data that must be kept, or
   * keeping data that must go — is a worse outcome than saying so.
   */
  | "counsel-determination";

export type ErasureEntry = {
  table: string;
  column: string;
  label: string;
  /** What the inventory says should happen to this datum. */
  treatment: PiiColumn["erasure"];
  outcome: ErasureOutcome;
  /** Why it came out that way — always present, including when it was erased. */
  because: string;
  pendingOn?: ErasurePrerequisite;
};

export type ErasureManifest = {
  subjectId: string;
  organisationId: string;
  performedAt: string;
  performedBy: string;
  requestRef: string | null;
  status: "complete" | "partial";
  entries: readonly ErasureEntry[];
  counts: { erased: number; retained: number; nothingHeld: number; pending: number };
  pendingOn: readonly ErasurePrerequisite[];
  completeness: {
    inventoryColumns: number;
    accountedFor: number;
    unaccountedFor: readonly string[];
  };
};

export class ErasureIncompleteError extends Error {
  constructor(public readonly columns: readonly string[]) {
    super(
      `Refusing to erase a subject without a treatment for ${columns.length} column(s): ` +
      `${columns.join(", ")}. A half-erasure that reports success is worse than a refusal, because ` +
      `nothing afterwards can tell which half happened.`);
    this.name = "ErasureIncompleteError";
  }
}

const named = (column: { table: string; column: string }): string => `${column.table}.${column.column}`;

/**
 * What this person's data in one column is held by, and what erasure can do about it.
 *
 * Subject-aware, deliberately. A plan computed from the inventory alone would mark the seven columns
 * waiting on the auth bridge as pending for *every* subject, including people with no trainee record
 * and no staff login — so every erasure would be partial for ever and the list of partial subjects, which
 * exists so the residual cannot be forgotten, would be every subject and therefore useless.
 *
 * So the question asked here is not "can this column be erased in general" but "is any of this person's
 * data in it, and can this reach it". A table holding nothing of theirs is `nothing-held`, which is an
 * answer rather than an omission; a table this path cannot read is pending, because not being able to
 * look is not the same as there being nothing there.
 *
 * Every branch gives a reason, including the ones that succeed: "erased" with no account of what that
 * meant is not evidence of anything.
 */
export function planColumn(
  column: PiiColumn,
  held: { rows: number; readable: boolean; considered: boolean },
): Omit<ErasureEntry, "label"> | null {
  const base = { table: column.table, column: column.column, treatment: column.erasure };
  const sealed = sealedColumnOf(column);
  const appendOnly = PII_TABLES[column.table]?.appendOnly === true;

  // Refused, not empty. `staff_credentials` is granted to the authentication role alone, so this path
  // cannot see whether the person has a login — and cannot erase one either. Reporting that as
  // "nothing held" would turn a blind spot into a clean bill of health.
  if (!held.readable) {
    return {
      ...base, outcome: "pending", pendingOn: "auth-bridge",
      because: `this path cannot read ${column.table}, so it can neither confirm what is held here nor ` +
        "erase it; the authentication role is the only one that may, which is what the bridge is for",
    };
  }

  // Reached, and there is nothing of theirs in it. Stated rather than left out, for the same reason the
  // export states it: an absent line looks exactly like a column somebody forgot.
  // The treatments the traversal cannot speak for.
  //
  // A payload store is not reached by the subject traversal at all, so "the traversal found no rows" says
  // nothing about whether the person is inside one — their name may sit in an audit before-image with no
  // link pointing at it. Answering `nothing-held` there would be a claim made from not having looked.
  //
  // This is where the scaffold's block nearly failed to fire: `pending-counsel` was not on this list, so a
  // real erasure returned `nothing-held` for both undecided stores while the worst-case helper reported
  // them blocking. The gate would have read as armed and passed every subject through.
  const SPOKEN_FOR_ELSEWHERE = ["not-attributable", "redact-or-retain", "redact-on-erasure", "pending-counsel"];
  if (held.considered && held.rows === 0 && !SPOKEN_FOR_ELSEWHERE.includes(column.erasure)) {
    return { ...base, outcome: "nothing-held", because: `no ${column.table} record for this person` };
  }
  if (!held.considered && !SPOKEN_FOR_ELSEWHERE.includes(column.erasure)) {
    return {
      ...base, outcome: "nothing-held",
      because: `nothing links this person to ${column.table}`,
    };
  }

  const decided = decideTreatment(column, base, sealed, appendOnly);
  if (!decided) return null;

  // An unresolved carve-out over this column, applied to whatever the treatment decided rather than
  // instead of it.
  //
  // Order matters and getting it wrong lost information: checking the carve-out first moved
  // `staff_credentials` and `trainees` out of the auth-bridge list and into this one, so a column
  // blocked by *both* a missing bridge and an unsettled carve-out reported only the second. Landing the
  // bridge would then have looked like it finished them. A column already pending keeps the blocker that
  // stops it being reachable at all and gains a mention of the one that stops it being decidable; a
  // column the treatment settled is overridden, because a carve-out that might require keeping it means
  // erasure must not shred it, and an unstated basis means it must not be quietly retained either.
  const carveout = pendingCarveoutFor(column.table, column.column);
  if (!carveout) return decided;

  // Only an outcome that would *destroy* something is overridden. A column already pending keeps the
  // blocker that makes it unreachable, and one already retained stays retained — a carve-out asking
  // "should this be kept despite an erasure" changes nothing for a column erasure was never going to
  // touch. Flipping those to pending put `training_bookings`, which no subject path reaches at all, into
  // the list of things blocking a person's erasure, which is noise standing where a real blocker should
  // be. Both cases still cite the carve-out, so neither is silent about it.
  if (decided.outcome !== "erased") {
    return {
      ...decided,
      because: `${decided.because}; a retention carve-out ('${carveout.key}') over it is also unresolved`,
    };
  }
  return {
    ...base, outcome: "pending", pendingOn: "counsel-determination",
    because: `a retention carve-out ('${carveout.key}') covers this column and is unresolved, so it is ` +
      `neither shredded nor retained until ${carveout.resolvedBy ?? "NZC-139"} is settled`,
  };
}

/** The inventory's instruction for a column, before any carve-out over it is considered. */
function decideTreatment(
  column: PiiColumn,
  base: { table: string; column: string; treatment: PiiColumn["erasure"] },
  sealed: string | null,
  appendOnly: boolean,
): Omit<ErasureEntry, "label"> | null {
  switch (column.erasure) {
    case "pending-counsel":
      // Neither shred nor silent-retain. The candidates differ in what they destroy, so acting on
      // either before the answer comes back is a guess with a person's data as the stake.
      return {
        ...base, outcome: "pending", pendingOn: "counsel-determination",
        because: column.pendingClassification
          ? `awaiting ${column.pendingClassification.nzc}: the candidates are ` +
            `${column.pendingClassification.candidates.join(" or ")}, which differ in what they destroy`
          : "awaiting a determination that is not recorded anywhere, which is itself the defect",
      };

    case "redact-on-erasure":
      // The resolved form of the above. No mechanism exists yet, so reaching this today means a column
      // was promoted out of pending-counsel before the redaction it now promises was built.
      return {
        ...base, outcome: "pending", pendingOn: "counsel-determination",
        because: "this column is to be redacted on erasure, and no redaction mechanism exists yet — the " +
          "classification landed ahead of the code that performs it",
      };

    case "shred-key": {
      if (column.stage !== "sealed") {
        return {
          ...base, outcome: "pending", pendingOn: "auth-bridge",
          because: "there is no ciphertext to shred yet: this column is sealed by a write path that runs " +
            "as the authentication role, which cannot reach the subject tables until the bridge lands",
        };
      }
      if (appendOnly) {
        return {
          ...base, outcome: "pending", pendingOn: "plaintext-drop",
          because: `the ciphertext is shredded with the subject's key, but ${column.table} is append-only ` +
            "so no runtime role can null the plaintext beside it — it stays readable until the plaintext " +
            "columns are dropped",
        };
      }
      return {
        ...base, outcome: "erased",
        because: sealed
          ? "the subject's key is destroyed, so the ciphertext cannot be read, and the plaintext kept " +
            "beside it is nulled"
          : "the plaintext is nulled",
      };
    }

    case "null-digest":
      return {
        ...base, outcome: "erased",
        because: "the digest is nulled, so a correct guess at the value matches nothing — shredding the " +
          "key alone would have left it confirmable",
      };

    case "association-to-tombstone": {
      if (appendOnly) {
        return {
          ...base, outcome: "pending", pendingOn: "plaintext-drop",
          because: `${column.table} is append-only, so the name on this association cannot be nulled ` +
            "until the plaintext columns are dropped; the association itself is meant to survive",
        };
      }
      return {
        ...base, outcome: "erased",
        because: "the name is nulled and the association is kept, so the record still says something was " +
          "done by somebody — it stops saying who",
      };
    }

    case "not-attributable":
      return {
        ...base, outcome: "retained",
        because: column.because
          ?? "no subject path reaches this column, so an erasure cannot find it to erase it",
      };

    case "redact-or-retain":
      return {
        ...base, outcome: "retained",
        because: column.because
          ?? "personal data inside a payload is redacted or retained on its own basis, never shredded (NZC-126)",
      };

    case "retain-with-basis": {
      // One source of truth. A column claiming a lawful basis has to point at the carve-out that states
      // it; a retention whose ground lives only in a `because` string is a retention nobody can review,
      // and it would read as settled while resting on a sentence.
      const covering = carveoutsFor(column.table, column.column);
      if (covering.length === 0) return null;
      return {
        ...base, outcome: "retained",
        because: `retained under '${covering[0]!.key}': ${covering[0]!.basisNote}`,
      };
    }

    default:
      // A treatment added to the inventory and not to this switch. There is no instruction here for
      // what to do with somebody's data, and inventing one — "pending", say — would be a guess wearing
      // the clothes of an answer. Returning nothing leaves the column unaccounted, and the plan refuses.
      return null;
  }
}

/** The whole plan, with every inventory column accounted for as it is planned. */
export function planErasure(
  resolved: ResolvedSubject,
  meta: { performedAt: Date; performedBy: string; requestRef: string | null },
): ErasureManifest {
  const accounted = new Set<string>();
  const entries: ErasureEntry[] = [];

  const rowsPerTable = new Map<string, number>();
  const unreadable = new Set<string>();
  for (const row of resolved.rows) {
    // A row the traversal reported with no keys is the refusal case: it stands for "there is a table
    // here I could not read", not for a row.
    const readable = Object.keys(row.keys).length > 0;
    if (!readable) unreadable.add(row.table);
    rowsPerTable.set(row.table, (rowsPerTable.get(row.table) ?? 0) + (readable ? 1 : 0));
  }
  const considered = new Set(resolved.tablesConsidered);

  for (const column of PII_COLUMNS) {
    const planned = planColumn(column, {
      rows: rowsPerTable.get(column.table) ?? 0,
      readable: !unreadable.has(column.table),
      considered: considered.has(column.table),
    });
    // No plan, or a plan with no stated reason: either way this column is left unaccounted and the
    // erasure refuses. A reason nobody has to give is the shape of the gap this workstream keeps finding.
    if (!planned || !planned.because.trim()) continue;
    accounted.add(named(column));
    entries.push({ ...planned, label: column.label });
  }

  const unaccountedFor = PII_COLUMNS.filter((column) => !accounted.has(named(column))).map(named);
  const counts = {
    erased: entries.filter((entry) => entry.outcome === "erased").length,
    retained: entries.filter((entry) => entry.outcome === "retained").length,
    nothingHeld: entries.filter((entry) => entry.outcome === "nothing-held").length,
    pending: entries.filter((entry) => entry.outcome === "pending").length,
  };
  const pendingOn = [...new Set(entries.flatMap((entry) => entry.pendingOn ? [entry.pendingOn] : []))].sort();

  return {
    subjectId: resolved.subjectId,
    organisationId: resolved.organisationId,
    performedAt: meta.performedAt.toISOString(),
    performedBy: meta.performedBy,
    requestRef: meta.requestRef,
    // Honest incompleteness: anything outstanding means partial, whatever else went right.
    status: counts.pending === 0 ? "complete" : "partial",
    entries,
    counts,
    pendingOn,
    completeness: {
      inventoryColumns: PII_COLUMNS.length,
      accountedFor: accounted.size,
      unaccountedFor,
    },
  };
}

/** No treatment for a column means no erasure at all. Checked before anything is destroyed. */
export function assertErasurePlanComplete(manifest: ErasureManifest): void {
  if (manifest.completeness.unaccountedFor.length > 0) {
    throw new ErasureIncompleteError(manifest.completeness.unaccountedFor);
  }
}

/** The columns erasure will actually write to on one table, given what the plan says. */
const clearableColumns = (table: string, manifest: ErasureManifest): PiiColumn[] =>
  PII_COLUMNS.filter((column) =>
    column.table === table
    && manifest.entries.some((entry) =>
      entry.table === column.table && entry.column === column.column && entry.outcome === "erased"));

/**
 * Perform the erasure.
 *
 * Idempotent by construction rather than by a guard: every act is a write of NULL, so a second run sets
 * to null what is already null and shreds a key that is already gone. That is what makes resuming a
 * partial erasure the same operation as performing one, and it is why the prerequisite landing later
 * needs no separate migration path — the same command finishes the job.
 */
export async function eraseSubjectData(
  pool: PoolLike,
  principal: StaffPrincipal,
  input: { organisationId: string; subjectId: string; requestRef?: string; keys?: SealingKeys },
): Promise<ErasureManifest> {
  // The strongest of the three, and holding either of the others confers nothing here (NZC-131).
  requireCapability(principal, "subject.erase");

  // The same traversal the export uses, so what an export would have gathered is what this destroys —
  // and without decrypting, because the key is about to be destroyed and reading it first would put a
  // cleartext copy of the person into a process that has no use for one.
  const resolved = await resolveSubjectData(
    pool, principal,
    { organisationId: input.organisationId, subjectId: input.subjectId, requestRef: input.requestRef },
    { decrypt: false, purpose: "erase", keys: input.keys });

  const performedAt = new Date();
  const manifest = planErasure(resolved, {
    performedAt, performedBy: principal.userId, requestRef: input.requestRef ?? null,
  });
  // Before anything is destroyed. A refusal afterwards would be a half-erasure with an exception on top.
  assertErasurePlanComplete(manifest);

  await withTenantWrite(pool, input.organisationId, async (db) => {
    // 1. The plaintext, the ciphertext's companion, and the blind indexes — per row the traversal found.
    for (const row of resolved.rows) {
      const columns = clearableColumns(row.table, manifest);
      if (columns.length === 0 || Object.keys(row.keys).length === 0) continue;

      const assignments = new Set<string>();
      for (const column of columns) {
        assignments.add(`${column.column}=NULL`);
        const index = indexColumnOf(column);
        // The blind index is the reason a shred alone is not enough: leave it and a correct guess at the
        // address still matches the row, which is confirmation of exactly the fact erasure removed.
        if (index) assignments.add(`${index}=NULL`);
      }

      const values: unknown[] = [input.organisationId];
      const where = Object.entries(row.keys)
        .map(([column, value]) => { values.push(value); return `${column}=$${values.length}`; })
        .join(" AND ");
      await db.query(
        `UPDATE nzi_console.${row.table} SET ${[...assignments].join(",")}
          WHERE organisation_id=$1 AND ${where}`, values);
    }

    // 2. The shared digests, through the one function that may touch that table (NZC-121).
    const links = await db.query<{ source_table: string; source_id: string }>(
      `SELECT source_table, source_id FROM nzi_console.data_subject_links
        WHERE organisation_id=$1 AND subject_id=$2`, [input.organisationId, input.subjectId]);
    for (const link of links.rows) {
      await db.query(`SELECT nzi_console.erase_subject_linkage($1,$2,$3)`,
        [input.organisationId, link.source_table, link.source_id]);
    }

    // 3. The key. Last, because everything above is reached through rows this subject owns and a shred
    // is the one step with no way back — if an earlier statement fails, the run is repeatable.
    await db.query(
      `UPDATE nzi_console.data_subject_keys
          SET wrapped_key=NULL, shredded_at=COALESCE(shredded_at, now()), shredded_by=COALESCE(shredded_by, $3)
        WHERE organisation_id=$1 AND subject_id=$2`,
      [input.organisationId, input.subjectId, principal.userId]);

    // 4. The tombstone. `erasure-partial` rather than `erased` while anything is outstanding: a person
    // told they were forgotten while a column of theirs is still readable has been told something untrue.
    await db.query(
      `UPDATE nzi_console.data_subjects SET status=$3 WHERE organisation_id=$1 AND subject_id=$2`,
      [input.organisationId, input.subjectId, manifest.status === "complete" ? "erased" : "erasure-partial"]);

    // 5. The record that outlives all of it, and the audit of the act.
    await db.query(
      `INSERT INTO nzi_console.subject_erasures
         (organisation_id,subject_id,requested_by,request_ref,last_run_at,completed_at,status,pending_on,
          erased_count,retained_count,pending_count,manifest)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::text[],$9,$10,$11,$12::jsonb)
       ON CONFLICT (organisation_id,subject_id) DO UPDATE SET
         last_run_at=EXCLUDED.last_run_at, completed_at=EXCLUDED.completed_at, status=EXCLUDED.status,
         pending_on=EXCLUDED.pending_on, erased_count=EXCLUDED.erased_count,
         retained_count=EXCLUDED.retained_count, pending_count=EXCLUDED.pending_count,
         manifest=EXCLUDED.manifest`,
      [input.organisationId, input.subjectId, principal.userId, input.requestRef ?? null,
        performedAt, manifest.status === "complete" ? performedAt : null, manifest.status,
        manifest.pendingOn, manifest.counts.erased, manifest.counts.retained, manifest.counts.pending,
        JSON.stringify(manifest)]);

    await db.query(
      `INSERT INTO nzi_console.audit_events
         (organisation_id,audit_event_id,actor_id,principal_type,action,entity_type,entity_id,correlation_id,after_json)
       VALUES ($1,$2,$3,'staff','subject.erase','data_subject',$4,$5,$6::jsonb)`,
      [input.organisationId, `audit-${randomUUID()}`, principal.userId, input.subjectId,
        input.requestRef ?? input.subjectId,
        JSON.stringify({
          status: manifest.status, pendingOn: manifest.pendingOn, ...manifest.counts,
          // Counts and prerequisites. Nothing that was erased appears here, which is the point of an
          // audit of an erasure: it must not be the one copy that survived it.
          rows: resolved.rows.length, requestRef: input.requestRef ?? null,
        })]);
  });

  return manifest;
}

/** One subject's erasure as it stands, for the compliance view that must not lose a partial. */
export async function readErasureRecord(
  pool: PoolLike,
  input: { organisationId: string; subjectId: string },
): Promise<ErasureManifest | null> {
  return withTenantWrite(pool, input.organisationId, async (db) => {
    const { rows } = await db.query<{ manifest: ErasureManifest }>(
      `SELECT manifest FROM nzi_console.subject_erasures WHERE organisation_id=$1 AND subject_id=$2`,
      [input.organisationId, input.subjectId]);
    return rows[0]?.manifest ?? null;
  });
}

/**
 * Every subject an erasure did not finish.
 *
 * The residual has to be visible or it is not a residual, it is a forgotten obligation. This is what the
 * compliance view lists and what gets re-run when a prerequisite lands.
 */
export async function partiallyErasedSubjects(
  pool: PoolLike,
  input: { organisationId: string },
): Promise<ReadonlyArray<{ subjectId: string; pendingOn: readonly string[]; pendingCount: number; lastRunAt: Date }>> {
  return withTenantWrite(pool, input.organisationId, async (db) => {
    const { rows } = await db.query<{ subject_id: string; pending_on: string[]; pending_count: number; last_run_at: Date }>(
      `SELECT subject_id, pending_on, pending_count, last_run_at FROM nzi_console.subject_erasures
        WHERE organisation_id=$1 AND status='partial' ORDER BY last_run_at`,
      [input.organisationId]);
    return rows.map((row) => ({
      subjectId: row.subject_id, pendingOn: row.pending_on,
      pendingCount: row.pending_count, lastRunAt: row.last_run_at,
    }));
  });
}

/** What a completeness proof compares against — every column, attributable or not. */
export const erasureAccountableColumns = (): readonly PiiColumn[] => PII_COLUMNS;

export type GoLiveBlocker = {
  prerequisite: ErasurePrerequisite;
  what: string;
  /** The decision or piece of work that would clear it. */
  waitingOn: string;
};

/**
 * Everything standing between this command and running for real subjects.
 *
 * One list, derived from the inventory and the carve-outs rather than maintained beside them, because a
 * hand-kept gate is a gate that goes stale in the safe-looking direction. Empty means an erasure can
 * claim completeness for anybody; non-empty means it cannot, and names why.
 */
export function erasureGoLiveBlockers(): readonly GoLiveBlocker[] {
  const blockers: GoLiveBlocker[] = [];

  for (const column of PII_COLUMNS) {
    if (column.erasure !== "pending-counsel" && column.erasure !== "redact-on-erasure") continue;
    blockers.push({
      prerequisite: "counsel-determination",
      what: `${column.table}.${column.column}`,
      waitingOn: column.pendingClassification?.nzc
        ?? (column.erasure === "redact-on-erasure" ? "a redaction mechanism" : "an unrecorded determination"),
    });
  }

  for (const carveout of pendingCarveouts()) {
    blockers.push({
      prerequisite: "counsel-determination",
      what: "table" in carveout.appliesTo
        ? `${carveout.appliesTo.table} (${carveout.key})`
        : `${carveout.key} (not mapped to any column yet)`,
      waitingOn: "NZC-139",
    });
  }

  for (const [prerequisite, columns] of outstandingByPrerequisite()) {
    if (prerequisite === "counsel-determination") continue;
    for (const column of columns) {
      blockers.push({
        prerequisite,
        what: column,
        waitingOn: prerequisite === "auth-bridge" ? "NZC-132" : "the plaintext-drop migration",
      });
    }
  }

  return blockers;
}

/** The carve-outs a person's erasure would run into, for the DPO view. */
export const pendingCarveoutsFor = (columns: readonly PiiColumn[]): readonly RetentionCarveout[] =>
  [...new Set(columns.flatMap((column) => {
    const carveout = pendingCarveoutFor(column.table, column.column);
    return carveout ? [carveout] : [];
  }))];

/**
 * The columns an erasure would leave behind for somebody who has data in every table.
 *
 * The worst case rather than a particular person's, which is what makes it the right thing to check a
 * prerequisite against: these are the columns that landing it would unblock.
 */
export const outstandingByPrerequisite = (): ReadonlyMap<ErasurePrerequisite, readonly string[]> => {
  const byPrerequisite = new Map<ErasurePrerequisite, string[]>();
  for (const column of PII_COLUMNS) {
    const planned = planColumn(column, { rows: 1, readable: true, considered: true });
    if (!planned || planned.outcome !== "pending" || !planned.pendingOn) continue;
    byPrerequisite.set(planned.pendingOn, [...(byPrerequisite.get(planned.pendingOn) ?? []), named(column)]);
  }
  return byPrerequisite;
};

/** Columns the traversal can reach, which is what the irreversibility proof walks. */
export const attributableColumns = (): readonly PiiColumn[] => PII_COLUMNS.filter(isAttributable);

/** The reach a column is erased through, for the manifest's grouping. */
export const reachOf = (column: PiiColumn): string => attributionOf(column).kind;
