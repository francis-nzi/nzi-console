import { randomUUID } from "node:crypto";
import { requireCapability, type StaffPrincipal } from "./auth";
import { isAttributable, attributionOf, PII_COLUMNS, PII_TABLES, type PiiColumn } from "./piiInventory";
import { resolveSealingKeys } from "./piiSealingKeys";
import { resolveSubjectData, type ResolvedSubject } from "./subjectResolution";
import {
  createSubjectKey, openForSubject, sealForSubject, unwrapSubjectKey,
  type SealedValue, type WrappedKey,
} from "./subjectCrypto";
import { withTenantWrite, type PoolLike, type Queryable } from "./postgres";
import type { SealingKeys } from "./piiSealing";

/**
 * The subject access response — the first actual exercise of the right this foundation was built for
 * (NZC-134), and the arrangement that keeps it in existence only as long as it takes to hand over
 * (NZC-135).
 *
 * ## What makes this hard is not gathering the data
 *
 * `resolveSubjectData` already gathers it, under one capability, through one enumeration. The two things
 * that decide whether "access" genuinely means access are downstream of that:
 *
 *   1. **Completeness has to be structural.** A column the export forgets is indistinguishable, to the
 *      person reading it, from a column this organisation does not hold. So every entry in the inventory
 *      is accounted for explicitly — shown, or named with the reason it is not — and an export that
 *      cannot account for one **refuses to be produced** rather than shipping a quiet omission.
 *
 *   2. **Nothing may be silently absent.** "We hold nothing of this kind about you" is itself part of
 *      the answer, and leaving it out looks exactly like an omission. So it is stated.
 *
 * ## The four ways a datum can appear
 *
 * Every inventory column lands in exactly one of these, and the artifact says which:
 *
 *   * **shown** — a value, decrypted if it was sealed;
 *   * **not attributable to you** — this system holds such data but no path ties it to a person
 *     (NZC-125's second axis), with the stated reason;
 *   * **held, not readable here** — a real row this read path is refused, such as `staff_credentials`,
 *     which is granted to the authentication role alone (NZC-132);
 *   * **no record of this kind held** — the column is reachable in principle, and this person has no
 *     row in that table.
 *
 * A matching digest is a fifth case that is deliberately never read back (NZC-118): it is named, with
 * what it is for, and its value is not in the artifact because reading one back would make the export a
 * way to confirm an address by guessing it.
 */

/** The format tag travels in the artifact, because a file outlives the code that wrote it. */
export const SUBJECT_EXPORT_FORMAT = "nzi.subject-export.v1" as const;

/**
 * How long a produced response stays retrievable.
 *
 * Twenty-four hours, and the reasoning is a balance rather than a maximum: the artifact is the most
 * sensitive object this system ever creates, so the window should be short — but a window so short that
 * the subject misses it produces a re-request, and a re-request mints a *second* copy of exactly the same
 * personal data. Shortening this past the point where one honest attempt fits makes the retention
 * position worse, not better.
 *
 * It is one constant, deliberately, so that changing it is a one-line decision rather than an
 * archaeology exercise.
 */
export const EXPORT_TTL_SECONDS = 24 * 60 * 60;

export type ExportRecipient = { principal: "staff" | "portal"; id: string };

export type ExportDatum = {
  /** What this is called when a person is shown it — the inventory's label, not the column name. */
  label: string;
  /** Where it came from, so a person can ask about one specific field and be answered precisely. */
  provenance: { table: string; column: string };
  value?: string | null;
  /** Present instead of a value, and always with the reason. */
  withheld?: string;
};

export type ExportRecord = {
  source: string;
  reach: "person-row" | "history-of" | "pointer";
  /** The reach in words, because "pointer" means nothing to the person reading it. */
  describedAs: string;
  keys: Readonly<Record<string, string>>;
  data: readonly ExportDatum[];
};

export type HeldButNotShown = {
  label: string;
  provenance: { table: string; column: string };
  kind: "not-attributable-to-you" | "held-not-readable-here" | "no-record-of-this-kind" | "never-read-back";
  because: string;
};

export type SubjectExportDocument = {
  format: typeof SUBJECT_EXPORT_FORMAT;
  producedAt: string;
  producedBy: string;
  requestRef: string | null;
  subject: { subjectId: string; organisationId: string; status: string };
  records: readonly ExportRecord[];
  /** Named, never valued (NZC-118). */
  matchingDigests: ReadonlyArray<{ source: string; sourceId: string; field: string; note: string }>;
  heldButNotShown: readonly HeldButNotShown[];
  crossTenant: string;
  /** The completeness proof, carried in the artifact so the reader does not have to take it on trust. */
  completeness: {
    inventoryColumns: number;
    accountedFor: number;
    unaccountedFor: readonly string[];
  };
};

export class ExportIncompleteError extends Error {
  constructor(public readonly columns: readonly string[]) {
    super(
      `Refusing to produce a subject access export that accounts for ${columns.length} fewer columns ` +
      `than the inventory holds: ${columns.join(", ")}. An unaccounted column is indistinguishable ` +
      `from data this organisation does not hold, so the export is wrong rather than incomplete.`);
    this.name = "ExportIncompleteError";
  }
}

export class ExportUnavailableError extends Error {
  constructor(message: string, public readonly reason: "unknown" | "expired" | "destroyed" | "not-the-recipient") {
    super(message);
    this.name = "ExportUnavailableError";
  }
}

const REACH_IN_WORDS: Record<ExportRecord["reach"], string> = {
  "person-row": "a record about you",
  "history-of": "an earlier version of a record about you",
  pointer: "a record about something else that names you",
};

const named = (column: { table: string; column: string }): string => `${column.table}.${column.column}`;

/**
 * Turn the resolved data into the response, and account for every column while doing it.
 *
 * The accounting is not a separate pass over the result: each branch records what it covered as it
 * covers it, so a branch that forgets to emit a datum also fails to account for it and the completeness
 * check catches it. A second pass that re-derived the same sets from the same inventory would agree with
 * itself and prove nothing.
 */
export function buildExportDocument(
  resolved: ResolvedSubject,
  meta: { producedAt: Date; producedBy: string; requestRef: string | null },
): SubjectExportDocument {
  const accounted = new Set<string>();

  const records: ExportRecord[] = resolved.rows.map((row) => ({
    source: row.table,
    reach: row.reach,
    describedAs: REACH_IN_WORDS[row.reach],
    keys: row.keys,
    data: row.data.map((datum) => {
      accounted.add(named(datum));
      const base = { label: datum.label, provenance: { table: datum.table, column: datum.column } };
      // `unavailable` covers both "nothing stored" and "held but not readable", and the distinction
      // matters to the reader: an empty field is an answer, an unreadable one is a gap.
      return datum.value === undefined
        ? { ...base, withheld: datum.unavailable ?? "not read" }
        : { ...base, value: datum.value, ...(datum.unavailable ? { withheld: datum.unavailable } : {}) };
    }),
  }));

  const heldButNotShown: HeldButNotShown[] = [];

  // 1. Data this system holds that no path ties to a person.
  for (const entry of resolved.notAttributable) {
    accounted.add(named(entry));
    heldButNotShown.push({
      label: entry.label,
      provenance: { table: entry.table, column: entry.column },
      kind: "not-attributable-to-you",
      because: entry.because,
    });
  }

  // 2. A real row that this read path is refused. It is already a datum on a record, with its reason —
  // repeated here so that the one section a person reads to find out what was kept back is complete.
  for (const record of records) {
    for (const datum of record.data) {
      if (datum.withheld === undefined || datum.value !== undefined) continue;
      if (!/cannot read/.test(datum.withheld)) continue;
      heldButNotShown.push({
        label: datum.label, provenance: datum.provenance,
        kind: "held-not-readable-here", because: datum.withheld,
      });
    }
  }

  // 3. The digest, named and never valued.
  const digestColumns = PII_COLUMNS.filter((column) => column.storage.kind === "digest");
  const matchingDigests = resolved.linkage.map((entry) => ({
    source: entry.sourceTable, sourceId: entry.sourceId, field: entry.field,
    note: "a one-way digest of this address, kept so that two records can be recognised as the same person. It is never read back, so its value is not part of this response.",
  }));
  for (const column of digestColumns) {
    accounted.add(named(column));
    heldButNotShown.push({
      label: column.label, provenance: { table: column.table, column: column.column },
      kind: "never-read-back",
      because: matchingDigests.length > 0
        ? `${matchingDigests.length} such digest(s) are held for you and listed under matching digests; a digest is never read back, so no value is shown`
        : "no such digest is held for you",
    });
  }

  // 4. A table this person has no row in — where "we hold no record of this kind about you" is true.
  //
  // This is emphatically **not** a catch-all, and it was one in the first draft: sweeping every
  // unaccounted column in here made the completeness check incapable of failing, and turned a column
  // the traversal had missed into an affirmative statement to the subject that no such data is held.
  // That is worse than an omission — an omission is silence, this is a denial.
  //
  // So the claim is made only where the traversal supports it: the table is one the reach model knows —
  // it has an inventory entry, and its attribution is a reach the traversal implements — and it produced
  // no datum for this subject, either because no link led there or because it was queried and held
  // nothing. Both of those are honestly "no record of this kind"; what is not is a table outside the
  // reach model, which falls through to `unaccountedFor` and makes the export refuse.
  const REACHED_BY_TRAVERSAL = new Set(["person-row", "history-of", "pointer"]);
  for (const column of PII_COLUMNS) {
    if (accounted.has(named(column))) continue;
    const definition = PII_TABLES[column.table];
    if (!definition) continue;
    if (!REACHED_BY_TRAVERSAL.has(definition.attribution.kind)) continue;
    accounted.add(named(column));
    heldButNotShown.push({
      label: column.label, provenance: { table: column.table, column: column.column },
      kind: "no-record-of-this-kind",
      because: `this organisation holds no ${column.table.replace(/_/g, " ")} record naming you`,
    });
  }

  // What is left is a column this response can say nothing truthful about: its table is not in the
  // reach model, or its attribution is a kind the traversal does not implement, or the traversal
  // queried its table and produced no datum for it. Each of those is a defect rather than an answer.
  const unaccountedFor = PII_COLUMNS.filter((column) => !accounted.has(named(column))).map(named);

  return {
    format: SUBJECT_EXPORT_FORMAT,
    producedAt: meta.producedAt.toISOString(),
    producedBy: meta.producedBy,
    requestRef: meta.requestRef,
    subject: {
      subjectId: resolved.subjectId,
      organisationId: resolved.organisationId,
      status: resolved.status,
    },
    records,
    matchingDigests,
    heldButNotShown,
    crossTenant:
      "Whether the same person is also known to another organisation on this platform is not answerable " +
      "from here: each organisation holds its own records, and comparing them is a separate question " +
      "about who is responsible for that data.",
    completeness: {
      inventoryColumns: PII_COLUMNS.length,
      accountedFor: accounted.size,
      unaccountedFor,
    },
  };
}

/**
 * Every inventory column must be accounted for, or nothing is produced.
 *
 * Fail-closed, and in the command rather than only in a test: a test proves this held when it ran, and
 * the property that matters is that it holds for the export in somebody's hands. The same reasoning as
 * the sealing keys refusing a write rather than skipping the seal.
 */
export function assertExportComplete(document: SubjectExportDocument): void {
  if (document.completeness.unaccountedFor.length > 0) {
    throw new ExportIncompleteError(document.completeness.unaccountedFor);
  }
}

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);

const KIND_HEADINGS: Record<HeldButNotShown["kind"], string> = {
  "not-attributable-to-you": "Held, but not attributable to you",
  "held-not-readable-here": "Held, present but not readable here",
  "never-read-back": "Held as a one-way digest, which is never read back",
  "no-record-of-this-kind": "No record of this kind is held about you",
};

/**
 * The human-readable rendering of the same content.
 *
 * The same document, not a summary of it: a rendering that showed less than the JSON would make the
 * machine-readable copy the real answer and this one a courtesy, and a person who reads only this one
 * would have been given less than their right of access.
 */
export function renderExportDocument(document: SubjectExportDocument): string {
  const lines: string[] = [];
  const write = (line: string) => lines.push(line);

  write(`<!doctype html><meta charset="utf-8"><title>Your personal data</title>`);
  write(`<style>
body{font:14px/1.6 system-ui,sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem;color:#0B1B2B}
h1{font-size:1.5rem;margin-bottom:.25rem} h2{font-size:1.1rem;margin-top:2rem;border-bottom:1px solid #DFF5E9;padding-bottom:.3rem}
h3{font-size:.95rem;margin:1.25rem 0 .35rem;color:#0B7A4B}
table{border-collapse:collapse;width:100%;margin:.4rem 0 1rem} th,td{text-align:left;padding:.35rem .5rem;border-bottom:1px solid #eee;vertical-align:top}
th{width:34%;font-weight:600} .withheld{color:#7a6a3a;background:#FFF8E8} .prov{color:#667;font-size:.82em}
.note{background:#F6FAF8;border-left:3px solid #0BA75E;padding:.6rem .8rem;margin:1rem 0}
</style>`);

  write(`<h1>Your personal data</h1>`);
  write(`<p class="prov">Reference ${escapeHtml(document.requestRef ?? "—")} · produced ${escapeHtml(document.producedAt)} · subject ${escapeHtml(document.subject.subjectId)}</p>`);
  write(`<div class="note">This is everything ${escapeHtml(document.subject.organisationId)} holds about you that can be tied to you, grouped by the record it comes from. Every field this organisation could hold is accounted for: if something is not shown, it is listed at the end with the reason.</div>`);

  const byReach = ["person-row", "history-of", "pointer"] as const;
  write(`<h2>Your records</h2>`);
  if (document.records.length === 0) write(`<p>No records naming you were found.</p>`);
  for (const reach of byReach) {
    const group = document.records.filter((record) => record.reach === reach);
    if (group.length === 0) continue;
    write(`<h3>${escapeHtml(REACH_IN_WORDS[reach])}</h3>`);
    for (const record of group) {
      const keys = Object.entries(record.keys).map(([key, value]) => `${key} ${value}`).join(" · ");
      write(`<p class="prov">${escapeHtml(record.source)}${keys ? ` — ${escapeHtml(keys)}` : ""}</p>`);
      write(`<table>`);
      for (const datum of record.data) {
        const cell = datum.value != null && datum.value !== ""
          ? escapeHtml(datum.value)
          : datum.withheld
            ? `<span class="withheld">${escapeHtml(datum.withheld)}</span>`
            : `<span class="prov">(empty)</span>`;
        write(`<tr><th>${escapeHtml(datum.label)}<br><span class="prov">${escapeHtml(named(datum.provenance))}</span></th><td>${cell}</td></tr>`);
      }
      write(`</table>`);
    }
  }

  if (document.matchingDigests.length > 0) {
    write(`<h2>Matching digests</h2>`);
    write(`<p>${escapeHtml(document.matchingDigests[0]!.note)}</p><table>`);
    for (const digest of document.matchingDigests) {
      write(`<tr><th>${escapeHtml(digest.field)}<br><span class="prov">${escapeHtml(digest.source)} · ${escapeHtml(digest.sourceId)}</span></th><td><span class="prov">held, not shown</span></td></tr>`);
    }
    write(`</table>`);
  }

  write(`<h2>Held but not shown, and why</h2>`);
  for (const kind of Object.keys(KIND_HEADINGS) as HeldButNotShown["kind"][]) {
    const group = document.heldButNotShown.filter((entry) => entry.kind === kind);
    if (group.length === 0) continue;
    write(`<h3>${escapeHtml(KIND_HEADINGS[kind])}</h3><table>`);
    for (const entry of group) {
      write(`<tr><th>${escapeHtml(entry.label)}<br><span class="prov">${escapeHtml(named(entry.provenance))}</span></th><td>${escapeHtml(entry.because)}</td></tr>`);
    }
    write(`</table>`);
  }

  write(`<h2>Other organisations</h2><p>${escapeHtml(document.crossTenant)}</p>`);
  write(`<h2>Completeness</h2><p>${document.completeness.accountedFor} of ${document.completeness.inventoryColumns} fields this organisation could hold about a person are accounted for above — shown, or listed with the reason they are not.</p>`);

  return lines.join("\n");
}

const asJson = (value: SealedValue): string => JSON.stringify(value);

/**
 * Produce the response, seal it under a key of its own, and record that it happened.
 *
 * The command produces and makes available. It does not email anybody: sending is a separate act with a
 * separate channel decision, and folding it in here would make "an export was produced" and "a copy of
 * somebody's personal data left the system" the same event.
 */
export async function exportSubjectData(
  pool: PoolLike,
  principal: StaffPrincipal,
  input: {
    organisationId: string;
    subjectId: string;
    recipient: ExportRecipient;
    requestRef?: string;
    ttlSeconds?: number;
    keys?: SealingKeys;
  },
): Promise<{
  exportId: string; expiresAt: Date;
  recordCount: number; datumCount: number; withheldCount: number;
}> {
  // Checked here as well as inside the read, because refusing before gathering a person's data in the
  // clear is better than refusing after.
  requireCapability(principal, "subject.export");

  const keys = input.keys ?? resolveSealingKeys();
  const resolved = await resolveSubjectData(
    pool, principal,
    { organisationId: input.organisationId, subjectId: input.subjectId, requestRef: input.requestRef },
    { decrypt: true, keys });

  const producedAt = new Date();
  const document = buildExportDocument(resolved, {
    producedAt, producedBy: principal.userId, requestRef: input.requestRef ?? null,
  });
  assertExportComplete(document);

  const html = renderExportDocument(document);
  const exportId = `export-${randomUUID()}`;
  const ttl = input.ttlSeconds ?? EXPORT_TTL_SECONDS;
  const expiresAt = new Date(producedAt.getTime() + ttl * 1000);

  // A key for this artifact and nothing else, which is what makes its destruction independent of the
  // subject's (NZC-135). Same helper as a subject key, so there is one wrapping scheme.
  const { key, wrapped } = createSubjectKey(keys.masterKey);

  const datumCount = document.records.reduce((total, record) => total + record.data.length, 0);
  const withheldCount = document.records.reduce(
    (total, record) => total + record.data.filter((datum) => datum.value === undefined).length, 0);

  await withTenantWrite(pool, input.organisationId, async (db) => {
    await db.query(
      `INSERT INTO nzi_console.subject_export_artifacts
         (organisation_id,export_id,subject_id,requested_by,request_ref,recipient_principal,recipient_id,
          created_at,expires_at,record_count,datum_count,withheld_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [input.organisationId, exportId, input.subjectId, principal.userId, input.requestRef ?? null,
        input.recipient.principal, input.recipient.id, producedAt, expiresAt,
        document.records.length, datumCount, withheldCount]);

    // The sealed response and its key go in the unlogged table, so no copy of either reaches the WAL,
    // a replica, or a restored backup (NZC-135). Same transaction: an artifact recorded without a
    // payload would be a window with nothing in it.
    await db.query(
      `INSERT INTO nzi_console.subject_export_payloads
         (organisation_id,export_id,sealed_json,sealed_html,wrapped_key)
       VALUES ($1,$2,$3::jsonb,$4::jsonb,$5::jsonb)`,
      [input.organisationId, exportId,
        asJson(sealForSubject(JSON.stringify(document), key)),
        asJson(sealForSubject(html, key)),
        JSON.stringify(wrapped)]);

    await auditExport(db, {
      organisationId: input.organisationId, actorId: principal.userId, action: "subject.export",
      subjectId: input.subjectId, requestRef: input.requestRef ?? null,
      detail: {
        exportId, expiresAt: expiresAt.toISOString(), recipient: input.recipient.principal,
        records: document.records.length, data: datumCount, withheld: withheldCount,
        heldButNotShown: document.heldButNotShown.length,
        accountedFor: document.completeness.accountedFor,
        inventoryColumns: document.completeness.inventoryColumns,
      },
    });
  });

  return { exportId, expiresAt, recordCount: document.records.length, datumCount, withheldCount };
}

/** What every audit row here has in common: the act, never its contents. */
async function auditExport(
  db: Queryable,
  entry: {
    organisationId: string; actorId: string; action: string; subjectId: string;
    requestRef: string | null; detail: Record<string, unknown>;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO nzi_console.audit_events
       (organisation_id,audit_event_id,actor_id,principal_type,action,entity_type,entity_id,correlation_id,after_json)
     VALUES ($1,$2,$3,'staff',$4,'data_subject',$5,$6,$7::jsonb)`,
    [entry.organisationId, `audit-${randomUUID()}`, entry.actorId, entry.action, entry.subjectId,
      entry.requestRef ?? entry.subjectId, JSON.stringify(entry.detail)]);
}

type ArtifactRow = {
  subject_id: string;
  recipient_principal: string;
  recipient_id: string;
  expires_at: Date;
  destroyed_at: Date | null;
  sealed_json: SealedValue | null;
  sealed_html: SealedValue | null;
  wrapped_key: WrappedKey | null;
};

/**
 * Read the response back, for the one recipient it was produced for.
 *
 * This does **not** destroy it. Reading and completing are separate calls because a read that shredded
 * on its way out would burn the artifact on a dropped connection, and the person would have to request
 * another — which mints a second copy of the same personal data, the opposite of what the retention rule
 * is for.
 */
export async function readSubjectExport(
  pool: PoolLike,
  recipient: ExportRecipient,
  input: { organisationId: string; exportId: string; now?: Date; keys?: SealingKeys },
): Promise<{ document: SubjectExportDocument; html: string; subjectId: string; expiresAt: Date }> {
  const now = input.now ?? new Date();
  const keys = input.keys ?? resolveSealingKeys();

  // The refusals are raised *after* the transaction, never inside it.
  //
  // Throwing from inside `withTenantWrite` rolls the transaction back, and the expiry branch below
  // destroys the artifact before refusing it — so an exception thrown in place would undo the shred it
  // had just performed and the artifact would stay readable until the next attempt. The refusal is
  // therefore returned as an outcome, committed with the destruction, and thrown by the caller.
  const outcome = await withTenantWrite(pool, input.organisationId, async (db):
    Promise<{ ok: true; document: SubjectExportDocument; html: string; subjectId: string; expiresAt: Date }
      | { ok: false; message: string; reason: ExportUnavailableError["reason"] }> => {
    const { rows } = await db.query<ArtifactRow>(
      `SELECT a.subject_id, a.recipient_principal, a.recipient_id, a.expires_at, a.destroyed_at,
              p.sealed_json, p.sealed_html, p.wrapped_key
         FROM nzi_console.subject_export_artifacts a
         LEFT JOIN nzi_console.subject_export_payloads p
           ON (p.organisation_id, p.export_id) = (a.organisation_id, a.export_id)
        WHERE a.organisation_id=$1 AND a.export_id=$2`,
      [input.organisationId, input.exportId]);

    const row = rows[0];
    if (!row) return { ok: false, message: "No such export.", reason: "unknown" };

    // The recipient is checked before the window, so a stranger holding a lapsed identifier learns
    // nothing about whether it was ever valid.
    if (row.recipient_principal !== recipient.principal || row.recipient_id !== recipient.id) {
      return { ok: false, message: "This export was produced for somebody else.", reason: "not-the-recipient" };
    }
    if (row.destroyed_at) {
      return {
        ok: false, reason: "destroyed",
        message: "This export has already been delivered and destroyed. A new one has to be requested.",
      };
    }
    if (row.expires_at.getTime() <= now.getTime()) {
      // Lapsed but not yet swept. Destroyed here rather than served, so the window is the window
      // whatever the sweep's schedule is — a TTL enforced only by a background job is a TTL that is
      // whatever the job's lateness happens to be.
      await destroy(db, input.organisationId, input.exportId, "expired", now);
      await auditExport(db, {
        organisationId: input.organisationId, actorId: recipient.id, action: "subject.export.destroyed",
        subjectId: row.subject_id, requestRef: null,
        detail: { exportId: input.exportId, reason: "expired", destroyedOn: "read-after-expiry" },
      });
      return { ok: false, message: "This export's window has closed.", reason: "expired" };
    }
    if (!row.wrapped_key || !row.sealed_json || !row.sealed_html) {
      // Reachable in one real case: an unclean restart empties the unlogged payload table, so the window
      // is open and the response is gone. Reported as unreadable rather than as an empty export, which
      // is the distinction a person on the other end cannot make for themselves.
      return { ok: false, message: "This export is no longer readable.", reason: "destroyed" };
    }

    const key = unwrapSubjectKey(row.wrapped_key, keys.masterKey);
    return {
      ok: true,
      document: JSON.parse(openForSubject(row.sealed_json, key)) as SubjectExportDocument,
      html: openForSubject(row.sealed_html, key),
      subjectId: row.subject_id,
      expiresAt: row.expires_at,
    };
  });

  if (!outcome.ok) throw new ExportUnavailableError(outcome.message, outcome.reason);
  const { ok, ...readable } = outcome;
  return readable;
}

/**
 * Destroy the response and keep the record of it.
 *
 * The payload row goes, which takes the ciphertext and the key with it in one act — and because that
 * table is unlogged, there is no copy of either in the WAL, on a replica, or in a restored backup for a
 * shred to have to reach afterwards (NZC-135). What remains is the permanent row saying an export
 * happened, for whom, and why it ended.
 */
const destroy = async (
  db: Queryable, organisationId: string, exportId: string,
  reason: "downloaded" | "expired", at: Date,
): Promise<void> => {
  await db.query(
    `DELETE FROM nzi_console.subject_export_payloads WHERE organisation_id=$1 AND export_id=$2`,
    [organisationId, exportId]);
  await db.query(
    `UPDATE nzi_console.subject_export_artifacts
        SET destroyed_at=$3, destroyed_reason=$4,
            downloaded_at=CASE WHEN $4='downloaded' THEN $3 ELSE downloaded_at END
      WHERE organisation_id=$1 AND export_id=$2 AND destroyed_at IS NULL`,
    [organisationId, exportId, at, reason]);
};

/**
 * The download finished, so destroy it.
 *
 * "Finished" means the response body was delivered in full — in an HTTP handler, the stream reaching
 * `finish` with `writableFinished` true, not the first byte being written. An aborted transfer never
 * reaches here, so the artifact survives inside its window and the next attempt works.
 *
 * Idempotent: a retried completion on an already-destroyed artifact reports that it was already gone
 * rather than failing, because the desired state is the same either way.
 */
export async function completeSubjectExportDownload(
  pool: PoolLike,
  recipient: ExportRecipient,
  input: { organisationId: string; exportId: string; now?: Date },
): Promise<{ destroyed: boolean; alreadyDestroyed: boolean }> {
  const now = input.now ?? new Date();

  return withTenantWrite(pool, input.organisationId, async (db) => {
    const { rows } = await db.query<{ subject_id: string; recipient_principal: string; recipient_id: string; destroyed_at: Date | null }>(
      `SELECT subject_id, recipient_principal, recipient_id, destroyed_at
         FROM nzi_console.subject_export_artifacts
        WHERE organisation_id=$1 AND export_id=$2 FOR UPDATE`,
      [input.organisationId, input.exportId]);

    const row = rows[0];
    if (!row) throw new ExportUnavailableError("No such export.", "unknown");
    if (row.recipient_principal !== recipient.principal || row.recipient_id !== recipient.id) {
      throw new ExportUnavailableError("This export was produced for somebody else.", "not-the-recipient");
    }
    if (row.destroyed_at) return { destroyed: false, alreadyDestroyed: true };

    await destroy(db, input.organisationId, input.exportId, "downloaded", now);
    await auditExport(db, {
      organisationId: input.organisationId, actorId: recipient.id, action: "subject.export.destroyed",
      subjectId: row.subject_id, requestRef: null,
      detail: { exportId: input.exportId, reason: "downloaded" },
    });
    return { destroyed: true, alreadyDestroyed: false };
  });
}

/**
 * The backstop: every artifact whose window has closed, emptied.
 *
 * The TTL does not depend on this running — a read after expiry destroys the artifact rather than
 * serving it — but an artifact nobody ever comes back for would otherwise sit sealed for ever, and "it
 * is encrypted" is not a retention policy.
 */
export async function expireSubjectExports(
  pool: PoolLike,
  input: { organisationId: string; now?: Date },
): Promise<{ destroyed: readonly string[] }> {
  const now = input.now ?? new Date();

  return withTenantWrite(pool, input.organisationId, async (db) => {
    const { rows } = await db.query<{ export_id: string; subject_id: string }>(
      `SELECT export_id, subject_id FROM nzi_console.subject_export_artifacts
        WHERE organisation_id=$1 AND destroyed_at IS NULL AND expires_at <= $2
        ORDER BY expires_at FOR UPDATE`,
      [input.organisationId, now]);

    for (const row of rows) {
      await destroy(db, input.organisationId, row.export_id, "expired", now);
      await auditExport(db, {
        organisationId: input.organisationId, actorId: "subject-export-expiry", action: "subject.export.destroyed",
        subjectId: row.subject_id, requestRef: null,
        detail: { exportId: row.export_id, reason: "expired", destroyedOn: "sweep" },
      });
    }
    return { destroyed: rows.map((row) => row.export_id) };
  });
}

/** What a completeness proof compares against: every column the inventory holds, attributable or not. */
export const exportAccountableColumns = (): readonly PiiColumn[] => PII_COLUMNS;

/**
 * The tables an export can reach at all, for the test that asserts the fixture exercises every reach.
 * Derived, so a new reach kind cannot be added without the proof noticing it is untested.
 */
export const exportReachKinds = (): readonly string[] => [
  ...new Set(Object.values(PII_TABLES)
    .map((definition) => definition.attribution.kind)
    .filter((kind) => kind === "person-row" || kind === "history-of" || kind === "pointer")),
];

/** Every attributable column, by the reach that would carry it — used by the completeness test. */
export const attributableByReach = (): ReadonlyMap<string, readonly string[]> => {
  const byReach = new Map<string, string[]>();
  for (const column of PII_COLUMNS.filter(isAttributable)) {
    const kind = attributionOf(column).kind;
    byReach.set(kind, [...(byReach.get(kind) ?? []), named(column)]);
  }
  return byReach;
};
