import { DEFAULT_STAFF_ROLE } from "@nzi/contracts";
import { withTenantRead, withTenantWrite, type PoolLike, type Queryable } from "./postgres";

/**
 * Reference data — the lookups the client and job smart-searches resolve against (NZC-089).
 *
 * The curated lists come from the live system, which is **production and export-only**: Francis
 * runs the live admin's Import/Export and hands over files. Nothing here reaches live, and nothing
 * here accepts a database dump — a dump would carry secrets and would mean touching a system this
 * repo is not allowed to touch.
 *
 * ## Reconcile by reading, not by key
 *
 * The same rule the NZC-080 seed was rebuilt around, and for the same reason: an idempotency key
 * only replays a command *this build* issued, so a second import — a corrected export, a later
 * version of this loader, a list Francis edited between runs — would miss its replay and insert a
 * duplicate. "Is this value already in this category?" has one answer regardless of who asks.
 *
 * Matching prefers `source_ref`, the identity the live export gave the row, and falls back to the
 * normalised label. That ordering matters: a renamed value keeps its source_ref, so a rename is an
 * update rather than an archive-and-insert, and the client records pointing at it stay pointed at
 * it.
 *
 * Matched **regardless of `active`**, so re-importing a value someone archived reinstates it rather
 * than inserting a second copy beside the archived one.
 */

export type ReferenceValueInput = {
  /** The identity from the live export. Absent for a value added here rather than imported. */
  sourceRef?: string | null;
  label: string;
  /** SIC for an industry; ignored by a category that carries no code. */
  code?: string | null;
  sortOrder?: number;
};

export type ReferenceValue = {
  valueId: string;
  categoryKey: string;
  label: string;
  code: string | null;
  sortOrder: number;
  active: boolean;
  version: number;
  source: "import" | "admin";
  sourceRef: string | null;
};

export type ReferenceCategory = {
  categoryKey: string;
  label: string;
  scope: "shared" | "organisation";
  description: string;
  carriesCode: boolean;
  codeLabel: string | null;
};

export type ImportOutcome = {
  categoryKey: string;
  created: number;
  updated: number;
  unchanged: number;
  reinstated: number;
  archived: number;
};

const normalise = (label: string) => label.trim().toLowerCase();

/**
 * Where a newly-rostered person starts.
 *
 * DEFAULT_STAFF_ROLE is the project's own least-privilege answer — "a new staff user starts
 * read-only" — and the import uses it rather than the role the source list claims.
 */
const LEAST_PRIVILEGE_ROLE = DEFAULT_STAFF_ROLE;

/** A stable id from the category and the value's identity — readable in a URL and in a log. */
function valueIdFor(categoryKey: string, input: ReferenceValueInput): string {
  const basis = (input.sourceRef ?? input.label).trim().toLowerCase();
  const slug = basis.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  return `${categoryKey}:${slug || "value"}`;
}

export async function listReferenceCategories(db: Queryable): Promise<ReferenceCategory[]> {
  const { rows } = await db.query<{
    category_key: string; label: string; scope: "shared" | "organisation";
    description: string; carries_code: boolean; code_label: string | null;
  }>(`SELECT category_key, label, scope, description, carries_code, code_label
        FROM nzi_console.reference_categories WHERE active ORDER BY label`);
  return rows.map((row) => ({
    categoryKey: row.category_key, label: row.label, scope: row.scope,
    description: row.description, carriesCode: row.carries_code, codeLabel: row.code_label,
  }));
}

/**
 * The values a smart-search offers.
 *
 * Active only by default: an archived value stays readable on the record that chose it, and stops
 * being offered to the next person. `includeArchived` is for the admin surface, which has to show
 * what it can reinstate.
 */
export async function listReferenceValues(
  db: Queryable, categoryKey: string, options: { includeArchived?: boolean } = {},
): Promise<ReferenceValue[]> {
  const { rows } = await db.query<{
    value_id: string; category_key: string; label: string; code: string | null;
    sort_order: number; active: boolean; version: number; source: "import" | "admin"; source_ref: string | null;
  }>(
    `SELECT value_id, category_key, label, code, sort_order, active, version, source, source_ref
       FROM nzi_console.reference_values
      WHERE category_key = $1 ${options.includeArchived ? "" : "AND active"}
      ORDER BY sort_order, lower(label)`,
    [categoryKey]);
  return rows.map((row) => ({
    valueId: row.value_id, categoryKey: row.category_key, label: row.label, code: row.code,
    sortOrder: row.sort_order, active: row.active, version: row.version,
    source: row.source, sourceRef: row.source_ref,
  }));
}

/**
 * Load an exported list into a category.
 *
 * Idempotent: a second run with the same export changes nothing and bumps no versions. A version
 * that moves on a re-import is not idempotence — it is the same write done twice, and it would make
 * every import look like an edit in the audit trail.
 *
 * `archiveMissing` treats the export as the whole truth and archives anything absent from it. It
 * defaults to **off**, because a partial export would otherwise archive the firm's entire list, and
 * the destructive reading of an ambiguous file should never be the default.
 */
export async function importReferenceValues(
  pool: PoolLike,
  input: {
    organisationId: string; actorId: string; categoryKey: string;
    values: readonly ReferenceValueInput[]; archiveMissing?: boolean;
  },
): Promise<ImportOutcome> {
  const { organisationId, actorId, categoryKey } = input;

  return withTenantWrite(pool, organisationId, async (db: Queryable) => {
    const category = await db.query<{ carries_code: boolean }>(
      `SELECT carries_code FROM nzi_console.reference_categories WHERE category_key = $1`, [categoryKey]);
    if (!category.rows[0]) throw new ReferenceDataError(`Unknown reference category "${categoryKey}".`);
    const carriesCode = category.rows[0].carries_code;

    const existing = await listReferenceValues(db, categoryKey, { includeArchived: true });
    const bySourceRef = new Map(existing.filter((v) => v.sourceRef).map((v) => [v.sourceRef!, v]));
    const byLabel = new Map(existing.map((v) => [normalise(v.label), v]));

    const outcome: ImportOutcome = { categoryKey, created: 0, updated: 0, unchanged: 0, reinstated: 0, archived: 0 };
    const seen = new Set<string>();

    for (const [index, value] of input.values.entries()) {
      const label = value.label.trim();
      if (label === "") continue;
      const code = carriesCode ? (value.code?.trim() || null) : null;
      const sortOrder = value.sortOrder ?? index;

      const match = (value.sourceRef ? bySourceRef.get(value.sourceRef) : undefined) ?? byLabel.get(normalise(label));

      if (!match) {
        const valueId = valueIdFor(categoryKey, value);
        await db.query(
          `INSERT INTO nzi_console.reference_values
             (organisation_id, category_key, value_id, label, code, sort_order, source, source_ref, created_by, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,'import',$7,$8,$8)`,
          [organisationId, categoryKey, valueId, label, code, sortOrder, value.sourceRef ?? null, actorId]);
        outcome.created += 1;
        seen.add(valueId);
        continue;
      }

      seen.add(match.valueId);
      const changed = match.label !== label || match.code !== code || match.sortOrder !== sortOrder
        || match.sourceRef !== (value.sourceRef ?? match.sourceRef);
      const reinstating = !match.active;

      if (!changed && !reinstating) { outcome.unchanged += 1; continue; }

      await db.query(
        `UPDATE nzi_console.reference_values
            SET label=$4, code=$5, sort_order=$6, active=true, source_ref=coalesce($7, source_ref),
                version=version+1, updated_at=now(), updated_by=$8
          WHERE organisation_id=$1 AND category_key=$2 AND value_id=$3`,
        [organisationId, categoryKey, match.valueId, label, code, sortOrder, value.sourceRef ?? null, actorId]);
      if (reinstating) outcome.reinstated += 1; else outcome.updated += 1;
    }

    if (input.archiveMissing) {
      for (const value of existing) {
        if (seen.has(value.valueId) || !value.active) continue;
        await db.query(
          `UPDATE nzi_console.reference_values
              SET active=false, version=version+1, updated_at=now(), updated_by=$4
            WHERE organisation_id=$1 AND category_key=$2 AND value_id=$3`,
          [organisationId, categoryKey, value.valueId, actorId]);
        outcome.archived += 1;
      }
    }

    await db.query(
      `INSERT INTO nzi_console.audit_events
         (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, after_json)
       VALUES ($1,$2,$3,'staff','reference.values.imported','reference_category',$4,$2,$5::jsonb)`,
      [organisationId, `audit-ref-${categoryKey}-${Date.now()}`, actorId, categoryKey, JSON.stringify(outcome)]);

    return outcome;
  });
}

/* ── Team roster ─────────────────────────────────────────────────────────────────────────── */

export type TeamMemberInput = { userId: string; displayName: string; email?: string | null };

export type TeamMember = {
  userId: string;
  /** The person's name, or their handle when the roster has not reached them yet. */
  displayName: string;
  email: string | null;
  role: string;
  status: string;
  /** False when `displayName` is standing in for an absent name, so a UI can say so. */
  named: boolean;
};

/**
 * The people an owner/manager smart-search offers.
 *
 * Falls back to the user_id when a membership has no name yet, and says which it gave. A roster
 * that silently shows handles as though they were names would have a consultant picking
 * "acceptance-admin" off a list of colleagues.
 */
export async function listTeamMembers(db: Queryable, options: { activeOnly?: boolean } = {}): Promise<TeamMember[]> {
  const { rows } = await db.query<{
    user_id: string; display_name: string | null; email: string | null; role_id: string; status: string;
  }>(
    `SELECT user_id, display_name, email, role_id, status FROM nzi_console.memberships
      ${options.activeOnly === false ? "" : "WHERE status = 'active'"}
      ORDER BY coalesce(display_name, user_id)`);
  return rows.map((row) => ({
    userId: row.user_id,
    displayName: row.display_name?.trim() || row.user_id,
    email: row.email,
    role: row.role_id,
    status: row.status,
    named: Boolean(row.display_name?.trim()),
  }));
}

/**
 * Load the exported team roster onto existing memberships.
 *
 * Names and emails only. **Role and status are not touched**: those are this system's access
 * decisions, made here and audited here, and letting an import overwrite them would make a
 * reference-data file a permission grant.
 *
 * A person in the export with no membership here is reported rather than created, for the same
 * reason — creating access is not an import's job.
 */
export async function importTeamMembers(
  pool: PoolLike,
  input: {
    organisationId: string; actorId: string; members: readonly TeamMemberInput[];
    /**
     * Create a membership for someone the roster names but this system does not know.
     *
     * Off by default, because creating access is not an import's job. On — which the first seed
     * needs, since none of the firm's people exist here yet — the membership is created at the
     * **least-privilege default role**, never at whatever role the source list claims. The live
     * export says Admin and SuperAdmin; carrying those across would let a transcribed text file
     * hand out administrative capability, and elevation stays a deliberate, audited act in this
     * system. Being on the roster is being nameable as a client's manager; it is not permission.
     */
    createMissing?: boolean;
  },
): Promise<{ updated: number; unchanged: number; created: number; unknown: string[] }> {
  return withTenantWrite(pool, input.organisationId, async (db: Queryable) => {
    const existing = await listTeamMembers(db, { activeOnly: false });
    const byId = new Map(existing.map((member) => [member.userId, member]));

    let updated = 0, unchanged = 0, created = 0;
    const unknown: string[] = [];

    for (const member of input.members) {
      let current = byId.get(member.userId);
      if (!current && input.createMissing) {
        await db.query(
          `INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name, email)
           VALUES ($1,$2,$3,'active',$4,$5)
           ON CONFLICT (organisation_id, user_id) DO NOTHING`,
          [input.organisationId, member.userId, LEAST_PRIVILEGE_ROLE, member.displayName.trim(),
            member.email?.trim().toLowerCase() || null]);
        created += 1;
        continue;
      }
      if (!current) { unknown.push(member.userId); continue; }
      const displayName = member.displayName.trim();
      const email = member.email?.trim().toLowerCase() || null;
      if (current.named && current.displayName === displayName && current.email === email) { unchanged += 1; continue; }
      await db.query(
        `UPDATE nzi_console.memberships SET display_name=$3, email=$4
          WHERE organisation_id=$1 AND user_id=$2`,
        [input.organisationId, member.userId, displayName, email]);
      updated += 1;
    }

    await db.query(
      `INSERT INTO nzi_console.audit_events
         (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, after_json)
       VALUES ($1,$2,$3,'staff','team.roster.imported','organisation',$1,$2,$4::jsonb)`,
      [input.organisationId, `audit-team-${Date.now()}`, input.actorId,
        JSON.stringify({ updated, unchanged, created, unknown })]);

    return { updated, unchanged, created, unknown };
  });
}

export async function readReferenceValues(
  pool: PoolLike, organisationId: string, categoryKey: string, options: { includeArchived?: boolean } = {},
): Promise<ReferenceValue[]> {
  return withTenantRead(pool, organisationId, (db: Queryable) => listReferenceValues(db, categoryKey, options));
}

export async function readTeamMembers(pool: PoolLike, organisationId: string): Promise<TeamMember[]> {
  return withTenantRead(pool, organisationId, (db: Queryable) => listTeamMembers(db));
}

export class ReferenceDataError extends Error {
  constructor(message: string) { super(message); this.name = "ReferenceDataError"; }
}
