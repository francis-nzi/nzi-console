import { randomUUID } from "node:crypto";
import {
  commandGrantForRole, STAFF_RATE_DEFAULT_CURRENCY, staffListSpec, staffRoles, type CapabilityGrant, type CommandContext, type CommandInputMap,
  type ListPage, type StaffListFilterKey, type StaffListQuery, type StaffListSortKey, type StaffRole,
} from "@nzi/contracts";
import { AuthorizationError } from "./auth";
import { capabilityScope } from "./access";
import { VersionConflictError } from "./errors";
import { defineListSql, readListPage } from "./listPage";
import { sealMembershipRow } from "./piiWriteThrough";
import { resolveSealingKeys } from "./piiSealingKeys";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";
import { withTenantRead, type PoolLike, type Queryable } from "./postgres";
import { blindIndex } from "./subjectCrypto";

/**
 * Team & access (admin Phase B, B1; ruled `phaseB-team-access-plan.md`). The roster is `memberships` (Q1) — the same
 * row the session resolves and every audit event names — governed here through the command runner.
 *
 * - **admin.users** for every roster command; **finance.manage** for rates (R9 (c)).
 * - **Never locked out** (Q2): a change that could take the last active admin away first locks the organisation's
 *   active admin rows `FOR UPDATE`, in one order, then counts — and 0141's deferred trigger holds the same line for
 *   every other path.
 * - **Never yourself** (Q7): your own role and your own deactivation are someone else's act.
 * - **Never deleted** (R3; 0141 revokes DELETE). A deactivated person keeps resolving wherever they are named — the
 *   list joins do not filter by status — and leaves the pickers, sign-in and enrolment, which all require `active`.
 *   Reinstating restores their existing credential (Q8).
 * - **No personal data in any audit payload** (the NZC-120 lesson): the runner writes a command's result as its
 *   audit `after_json`, so every result here carries ids, versions, roles, statuses, position value ids and the names
 *   of fields changed — never a name or an address. The sealed row is the record of those.
 * - A new member's `user_id` is an opaque UUID (Q4); the email is fixed once added (Q6).
 */

// ── The list ───────────────────────────────────────────────────────────────────────────────────────────────────

export type StaffSignIn = "enrolled" | "invited" | "expired" | "revoked" | "none";
export type StaffRow = {
  userId: string; displayName: string; named: boolean; email: string | null; role: StaffRole;
  status: "active" | "deactivated" | "invited" | "suspended";
  positionValueId: string | null; positionLabel: string | null; positionActive: boolean | null;
  provenance: "v7" | "added"; signIn: StaffSignIn; version: number; deactivatedAt: string | null;
};
export type StaffPage = ListPage<StaffRow, StaffListFilterKey, Record<string, never>>;

const staffSql = defineListSql<StaffListSortKey, StaffListFilterKey>({
  base: `SELECT m.organisation_id, m.user_id,
      coalesce(nullif(btrim(m.display_name), ''), m.user_id) AS name, nullif(btrim(m.display_name), '') IS NOT NULL AS named,
      m.email, m.role_id AS role, m.status, m.position_value_id AS position, pv.label AS position_label, pv.active AS position_active,
      m.version, m.deactivated_at,
      CASE WHEN m.source_system IS NOT NULL THEN 'v7' ELSE 'added' END AS provenance,
      coalesce(i.state, 'none') AS sign_in
    FROM nzi_console.memberships m
    LEFT JOIN nzi_console.reference_values pv ON (pv.organisation_id, pv.value_id) = (m.organisation_id, m.position_value_id)
    LEFT JOIN LATERAL (
      SELECT CASE WHEN consumed_at IS NOT NULL THEN 'enrolled' WHEN revoked_at IS NOT NULL THEN 'revoked'
                  WHEN expires_at <= now() THEN 'expired' ELSE 'invited' END AS state
        FROM nzi_console.staff_enrolment_invitations
       WHERE (organisation_id, user_id) = (m.organisation_id, m.user_id)
       ORDER BY created_at DESC, invitation_id DESC LIMIT 1) i ON true`,
  search: ["name"],
  filters: {
    role: { kind: "equals", column: "role", facet: { noneLabel: "—", values: staffRoles } },
    // Deactivated people are hidden unless asked for (the plan's §7): absent means active; "all" shows everyone.
    status: { kind: "equals", column: "status", whenAbsent: "status = 'active'", allValue: "all", facet: { noneLabel: "—", values: ["active", "deactivated"] } },
    position: { kind: "equals", column: "position", facet: { noneLabel: "No position" } },
  },
  sort: { name: { column: "name", text: true }, role: { column: "role", text: true }, position: { column: "position_label", text: true }, status: { column: "status", text: true } },
  tiebreak: "user_id",
});

const iso = (value: unknown) => value === null || value === undefined ? null : value instanceof Date ? value.toISOString() : String(value);

export async function listStaffPage(db: Queryable, query: StaffListQuery): Promise<StaffPage> {
  return readListPage(db, staffSql, staffListSpec, query, {
    mapRow: (row) => ({
      userId: String(row.user_id), displayName: String(row.name), named: row.named === true, email: row.email === null ? null : String(row.email),
      role: row.role as StaffRole, status: row.status as StaffRow["status"],
      positionValueId: row.position === null ? null : String(row.position), positionLabel: row.position_label === null ? null : String(row.position_label),
      positionActive: row.position_active === null ? null : row.position_active === true,
      provenance: row.provenance as StaffRow["provenance"], signIn: row.sign_in as StaffSignIn, version: Number(row.version), deactivatedAt: iso(row.deactivated_at),
    }),
    mapSummary: () => ({}),
  });
}

/** What the drawer offers: every position (active first — an inactive one a person holds still resolves) and the matrix version roles resolve against. */
export type StaffPickers = { positions: Array<{ valueId: string; label: string; active: boolean }>; matrixVersion: number | null };

export async function listStaffPickers(db: Queryable): Promise<StaffPickers> {
  const positions = await db.query<{ value_id: string; label: string; active: boolean }>(
    `SELECT value_id, label, active FROM nzi_console.reference_values WHERE category_key = 'positions' ORDER BY active DESC, sort_order, lower(label)`);
  const { rows: [matrix] } = await db.query<{ version: number | null }>(`SELECT max(matrix_version) AS version FROM nzi_console.staff_capability_matrix_versions`);
  return { positions: positions.rows.map((row) => ({ valueId: row.value_id, label: row.label, active: row.active })), matrixVersion: matrix?.version ?? null };
}

/** One person's audit history (membership events only), newest first — the drawer's History. Actors named as they are now. */
export type StaffHistoryEntry = { action: string; at: string; actor: string; reason: string | null; before: unknown; after: unknown };

export async function readStaffHistory(db: Queryable, userId: string): Promise<StaffHistoryEntry[]> {
  const { rows } = await db.query<{ action: string; occurred_at: Date; actor_id: string; actor_name: string | null; reason: string | null; before_json: unknown; after_json: unknown }>(
    `SELECT a.action, a.occurred_at, a.actor_id, nullif(btrim(m.display_name), '') AS actor_name, a.reason, a.before_json, a.after_json
       FROM nzi_console.audit_events a
       LEFT JOIN nzi_console.memberships m ON (m.organisation_id, m.user_id) = (a.organisation_id, a.actor_id)
      WHERE a.entity_type = 'membership' AND a.entity_id = $1
      ORDER BY a.occurred_at DESC, a.audit_event_id DESC LIMIT 50`, [userId]);
  return rows.map((row) => ({ action: row.action, at: row.occurred_at.toISOString(), actor: row.actor_name ?? row.actor_id, reason: row.reason, before: row.before_json, after: row.after_json }));
}

// ── Commands ───────────────────────────────────────────────────────────────────────────────────────────────────

type Stored = { role_id: StaffRole; status: string; position_value_id: string | null; display_name: string | null; version: number };

/** What every roster command returns — and so what its audit event records. Ids and states only. */
export type StaffResult = { userId: string; version: number; role: StaffRole; status: string; positionValueId: string | null; changed: string[] };
const state = (row: Stored) => ({ version: row.version, role: row.role_id, status: row.status, positionValueId: row.position_value_id });

/**
 * Lock the organisation's active admins, then the person — always in that order, so two roster commands never
 * deadlock and a last-admin count cannot be raced.
 */
async function lockForChange(db: Queryable, context: CommandContext, userId: string, expectedVersion: number): Promise<{ person: Stored; activeAdmins: string[] }> {
  const { rows: admins } = await db.query<{ user_id: string }>(
    `SELECT user_id FROM nzi_console.memberships WHERE organisation_id = $1 AND role_id = 'admin' AND status = 'active' ORDER BY user_id FOR UPDATE`, [context.organisationId]);
  const { rows: [person] } = await db.query<Stored>(
    `SELECT role_id, status, position_value_id, display_name, version FROM nzi_console.memberships WHERE organisation_id = $1 AND user_id = $2 FOR UPDATE`,
    [context.organisationId, userId]);
  if (!person) throw new CommandValidationError([{ field: "userId", code: "NOT_FOUND", message: `${userId} is not a member of ${context.organisationId}.` }]);
  if (person.version !== expectedVersion) throw new VersionConflictError(expectedVersion, person.version);
  return { person, activeAdmins: admins.map((row) => row.user_id) };
}

const lastAdmin = (person: Stored, userId: string, activeAdmins: string[]) =>
  person.role_id === "admin" && person.status === "active" && activeAdmins.length === 1 && activeAdmins[0] === userId;
const LAST_ADMIN_MESSAGE = "This is the organisation's only active admin. Make someone else an admin first — the organisation must never be left without one.";

function refuseSelf(context: CommandContext, userId: string, what: string) {
  if (context.actorId === userId) throw new CommandValidationError([{ field: "userId", code: "SELF_CHANGE", message: `You cannot ${what} yourself — ask another admin, so the change has a second pair of eyes.` }]);
}

/** A position must be this organisation's, in the positions lookup, and active — unless it is the one already held. */
async function assertPosition(db: Queryable, context: CommandContext, positionValueId: string | null, current: string | null) {
  if (positionValueId === null || positionValueId === current) return;
  const { rows: [value] } = await db.query<{ category_key: string; active: boolean }>(
    `SELECT category_key, active FROM nzi_console.reference_values WHERE organisation_id = $1 AND value_id = $2`, [context.organisationId, positionValueId]);
  if (!value || value.category_key !== "positions") throw new CommandValidationError([{ field: "positionValueId", code: "NOT_FOUND", message: "That position is not available." }]);
  if (!value.active) throw new CommandValidationError([{ field: "positionValueId", code: "INACTIVE", message: "That position is inactive; choose an active one." }]);
}

const cleanName = (name: string) => name.trim().replace(/\s+/g, " ");
const blank = (value: string | null | undefined) => value?.trim() ? value.trim() : null;

export function addStaff(pool: PoolLike, input: CommandInputMap["staff.add"], context: CommandContext): Promise<StoredOutcome<StaffResult>> {
  return runPostgresCommand(pool, "staff.add", input, context, async (db) => {
    const displayName = cleanName(input.displayName);
    const email = input.email.trim().toLowerCase();
    const positionValueId = blank(input.positionValueId);
    const digest = blindIndex("memberships.email", email, resolveSealingKeys().indexKey);
    const { rows: [taken] } = await db.query<{ user_id: string }>(
      `SELECT user_id FROM nzi_console.memberships WHERE organisation_id = $1 AND (email_bidx = $2 OR lower(btrim(email)) = $3) LIMIT 1`,
      [context.organisationId, digest, email]);
    if (taken) throw new CommandValidationError([{ field: "email", code: "DUPLICATE", message: "Someone on the roster — active or not — already has that email address." }]);
    await assertPosition(db, context, positionValueId, null);
    const userId = randomUUID();
    // Least privilege, always: a role is granted afterwards, deliberately and audited (the roster seed's rule).
    await db.query(
      `INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name, email, position_value_id, updated_at, updated_by)
       VALUES ($1, $2, 'viewer', 'active', $3, $4, $5, now(), $6)`,
      [context.organisationId, userId, displayName, email, positionValueId, context.actorId]);
    await sealMembershipRow({ db, organisationId: context.organisationId, actorId: context.actorId }, { userId, displayName, email });
    return {
      data: { userId, version: 1, role: "viewer", status: "active", positionValueId, changed: ["displayName", "email", "positionValueId", "role", "status"] },
      entityType: "membership", entityId: userId, topic: "staff.added",
    };
  });
}

export function updateStaff(pool: PoolLike, input: CommandInputMap["staff.update"], context: CommandContext): Promise<StoredOutcome<StaffResult>> {
  return runPostgresCommand(pool, "staff.update", input, context, async (db) => {
    const { person } = await lockForChange(db, context, input.userId, input.expectedVersion);
    const displayName = cleanName(input.displayName);
    const positionValueId = input.positionValueId === undefined ? person.position_value_id : blank(input.positionValueId);
    const changed = [
      ...(displayName !== (person.display_name ?? "").trim() ? ["displayName"] : []),
      ...(positionValueId !== person.position_value_id ? ["positionValueId"] : []),
    ];
    if (changed.length === 0) throw new CommandValidationError([{ field: "userId", code: "NO_CHANGE", message: "Nothing to change." }]);
    await assertPosition(db, context, positionValueId, person.position_value_id);
    const { rows: [saved] } = await db.query<{ version: number }>(
      `UPDATE nzi_console.memberships SET display_name = $3, position_value_id = $4, version = version + 1, updated_at = now(), updated_by = $5
        WHERE organisation_id = $1 AND user_id = $2 RETURNING version`,
      [context.organisationId, input.userId, displayName, positionValueId, context.actorId]);
    if (changed.includes("displayName")) {
      await sealMembershipRow({ db, organisationId: context.organisationId, actorId: context.actorId }, { userId: input.userId, displayName });
    }
    return {
      data: { userId: input.userId, version: saved!.version, role: person.role_id, status: person.status, positionValueId, changed },
      entityType: "membership", entityId: input.userId, topic: "staff.updated", before: state(person),
    };
  });
}

export function changeStaffRole(pool: PoolLike, input: CommandInputMap["staff.role.assign"], context: CommandContext): Promise<StoredOutcome<StaffResult>> {
  return runPostgresCommand(pool, "staff.role.assign", input, context, async (db) => {
    refuseSelf(context, input.userId, "change the role of");
    const { person, activeAdmins } = await lockForChange(db, context, input.userId, input.expectedVersion);
    if (person.status !== "active") throw new CommandValidationError([{ field: "userId", code: "NOT_ACTIVE", message: `${input.userId}'s membership is ${person.status}, not active — reinstate them first.` }]);
    if (person.role_id === input.role) throw new CommandValidationError([{ field: "role", code: "NO_CHANGE", message: `${input.userId} already has the ${input.role} role.` }]);
    if (input.role !== "admin" && lastAdmin(person, input.userId, activeAdmins)) throw new CommandValidationError([{ field: "role", code: "LAST_ADMIN", message: LAST_ADMIN_MESSAGE }]);
    const { rows: [saved] } = await db.query<{ version: number }>(
      `UPDATE nzi_console.memberships SET role_id = $3, version = version + 1, updated_at = now(), updated_by = $4
        WHERE organisation_id = $1 AND user_id = $2 RETURNING version`, [context.organisationId, input.userId, input.role, context.actorId]);
    return {
      data: { userId: input.userId, version: saved!.version, role: input.role, status: person.status, positionValueId: person.position_value_id, changed: ["role"] },
      entityType: "membership", entityId: input.userId, topic: "staff.role.assign", before: state(person),
    };
  });
}

export function deactivateStaff(pool: PoolLike, input: CommandInputMap["staff.deactivate"], context: CommandContext): Promise<StoredOutcome<StaffResult & { invitationsRevoked: number }>> {
  return runPostgresCommand(pool, "staff.deactivate", input, context, async (db) => {
    refuseSelf(context, input.userId, "deactivate");
    const { person, activeAdmins } = await lockForChange(db, context, input.userId, input.expectedVersion);
    if (person.status === "deactivated") throw new CommandValidationError([{ field: "userId", code: "ALREADY_DEACTIVATED", message: `${input.userId} is already deactivated.` }]);
    if (lastAdmin(person, input.userId, activeAdmins)) throw new CommandValidationError([{ field: "userId", code: "LAST_ADMIN", message: LAST_ADMIN_MESSAGE }]);
    const { rows: [saved] } = await db.query<{ version: number }>(
      `UPDATE nzi_console.memberships SET status = 'deactivated', deactivated_at = now(), deactivated_by = $3, version = version + 1, updated_at = now(), updated_by = $3
        WHERE organisation_id = $1 AND user_id = $2 RETURNING version`, [context.organisationId, input.userId, context.actorId]);
    // An open enrolment link could no longer be redeemed (enrolment needs an active membership); it is withdrawn too.
    const revoked = await db.query(
      `UPDATE nzi_console.staff_enrolment_invitations
          SET revoked_at = now(), pending_password_salt = NULL, pending_password_hash = NULL, pending_totp_ciphertext = NULL, pending_totp_iv = NULL, pending_totp_tag = NULL
        WHERE organisation_id = $1 AND user_id = $2 AND consumed_at IS NULL AND revoked_at IS NULL RETURNING invitation_id`, [context.organisationId, input.userId]);
    return {
      data: { userId: input.userId, version: saved!.version, role: person.role_id, status: "deactivated", positionValueId: person.position_value_id, changed: ["status"], invitationsRevoked: revoked.rows.length },
      entityType: "membership", entityId: input.userId, topic: "staff.deactivated", before: state(person),
    };
  });
}

export function reinstateStaff(pool: PoolLike, input: CommandInputMap["staff.reinstate"], context: CommandContext): Promise<StoredOutcome<StaffResult>> {
  return runPostgresCommand(pool, "staff.reinstate", input, context, async (db) => {
    const { person } = await lockForChange(db, context, input.userId, input.expectedVersion);
    if (person.status !== "deactivated") throw new CommandValidationError([{ field: "userId", code: "NOT_DEACTIVATED", message: `${input.userId} is not deactivated.` }]);
    // Q8: the existing credential works again; nothing about sign-in is re-issued.
    const { rows: [saved] } = await db.query<{ version: number }>(
      `UPDATE nzi_console.memberships SET status = 'active', deactivated_at = NULL, deactivated_by = NULL, version = version + 1, updated_at = now(), updated_by = $3
        WHERE organisation_id = $1 AND user_id = $2 RETURNING version`, [context.organisationId, input.userId, context.actorId]);
    return {
      data: { userId: input.userId, version: saved!.version, role: person.role_id, status: "active", positionValueId: person.position_value_id, changed: ["status"] },
      entityType: "membership", entityId: input.userId, topic: "staff.reinstated", before: state(person),
    };
  });
}

// ── The operator break-glass (ruled Q9) ────────────────────────────────────────────────────────────────────────

/**
 * Change a member's role from the Render Shell — for when no admin can sign in. Not a second path: it runs the same
 * `staff.role.assign` command, with the same guards (the last active admin included) and the same audit shape, as the
 * `system` principal with an admin grant for the operator. Self-change cannot arise: the operator is not a member.
 */
export async function assignStaffRole(
  pool: PoolLike, input: { organisationId: string; userId: string; role: string; actorId: string; reason: string },
): Promise<{ from: string; to: StaffRole }> {
  const userId = input.userId.trim(), actorId = input.actorId.trim(), reason = input.reason.trim();
  if (!(staffRoles as readonly string[]).includes(input.role)) throw new CommandValidationError([{ field: "role", code: "INVALID", message: `${input.role} is not a staff role.` }]);
  if (!actorId.startsWith("operator:") || actorId.length <= "operator:".length) throw new CommandValidationError([{ field: "actorId", code: "INVALID", message: "The operator making the change is required, as operator:<name>." }]);
  if (reason.length < 8) throw new CommandValidationError([{ field: "reason", code: "REQUIRED", message: "A role change needs a reason." }]);
  const { rows: [current] } = await withReadVersion(pool, input.organisationId, userId);
  if (!current) throw new CommandValidationError([{ field: "userId", code: "NOT_FOUND", message: `${userId} is not a member of ${input.organisationId}.` }]);
  const role = input.role as StaffRole;
  const correlationId = `operator-${randomUUID()}`;
  await changeStaffRole(pool, { userId, role, expectedVersion: current.version }, {
    organisationId: input.organisationId, actorId, principal: "system", idempotencyKey: correlationId, correlationId, reason,
    grant: commandGrantForRole("admin", input.organisationId, actorId),
  });
  return { from: current.role_id, to: role };
}

async function withReadVersion(pool: PoolLike, organisationId: string, userId: string) {
  return withTenantRead(pool, organisationId, (db) => db.query<{ role_id: string; version: number }>(
    `SELECT role_id, version FROM nzi_console.memberships WHERE organisation_id = $1 AND user_id = $2`, [organisationId, userId]));
}

// ── Rates (R9 (c)) ─────────────────────────────────────────────────────────────────────────────────────────────

export type StaffRate = {
  rateId: string; effectiveFrom: string; costPerHour: number | null; sellPerHour: number | null; currency: string;
  supersedesRateId: string | null; supersededBy: string | null; recordedAt: string; recordedBy: string;
};
export type StaffRates = { current: StaffRate | null; rates: StaffRate[] };

/** A person's rates, newest first, with the one in force today. finance.manage only — refused, never emptied, without it. */
export async function readStaffRates(db: Queryable, holder: { capabilities: readonly CapabilityGrant[] }, userId: string, today: string): Promise<StaffRates> {
  if (capabilityScope(holder, "finance.manage") === null) throw new AuthorizationError("finance.manage", "Staff rates need finance.manage.");
  const { rows } = await db.query<{ rate_id: string; effective_from: string; cost_per_hour: string | null; sell_per_hour: string | null; currency: string;
    supersedes_rate_id: string | null; superseded_by: string | null; recorded_at: Date; recorded_by: string }>(
    `SELECT r.rate_id, r.effective_from::text AS effective_from, r.cost_per_hour, r.sell_per_hour, r.currency, r.supersedes_rate_id,
            (SELECT s.rate_id FROM nzi_console.staff_rates s WHERE s.organisation_id = r.organisation_id AND s.supersedes_rate_id = r.rate_id) AS superseded_by,
            r.recorded_at, r.recorded_by
       FROM nzi_console.staff_rates r WHERE r.user_id = $1 ORDER BY r.effective_from DESC, r.recorded_at DESC`, [userId]);
  const rates = rows.map((row) => ({
    rateId: row.rate_id, effectiveFrom: row.effective_from, costPerHour: row.cost_per_hour === null ? null : Number(row.cost_per_hour),
    sellPerHour: row.sell_per_hour === null ? null : Number(row.sell_per_hour), currency: row.currency, supersedesRateId: row.supersedes_rate_id,
    supersededBy: row.superseded_by, recordedAt: row.recorded_at.toISOString(), recordedBy: row.recorded_by,
  }));
  return { current: rates.find((rate) => rate.supersededBy === null && rate.effectiveFrom <= today) ?? null, rates };
}

export type StaffRateResult = { rateId: string; userId: string; effectiveFrom: string; costPerHour: number | null; sellPerHour: number | null; currency: string; supersedesRateId: string | null };

/** A rate from a date, or a correction of one (a new row superseding it). Append-only: nothing is ever edited or deleted. */
export function setStaffRate(pool: PoolLike, input: CommandInputMap["staff.rate.set"], context: CommandContext): Promise<StoredOutcome<StaffRateResult>> {
  return runPostgresCommand(pool, "staff.rate.set", input, context, async (db) => {
    const { rows: [person] } = await db.query<{ status: string }>(
      `SELECT status FROM nzi_console.memberships WHERE organisation_id = $1 AND user_id = $2 FOR UPDATE`, [context.organisationId, input.userId]);
    if (!person) throw new CommandValidationError([{ field: "userId", code: "NOT_FOUND", message: `${input.userId} is not a member of ${context.organisationId}.` }]);
    const supersedesRateId = blank(input.supersedesRateId);
    const { rows: live } = await db.query<{ rate_id: string; user_id: string; effective_from: string; superseded: boolean }>(
      `SELECT r.rate_id, r.user_id, r.effective_from::text AS effective_from,
              EXISTS (SELECT 1 FROM nzi_console.staff_rates s WHERE s.organisation_id = r.organisation_id AND s.supersedes_rate_id = r.rate_id) AS superseded
         FROM nzi_console.staff_rates r WHERE r.organisation_id = $1 AND (r.rate_id = $2 OR (r.user_id = $3 AND r.effective_from = $4::date))`,
      [context.organisationId, supersedesRateId, input.userId, input.effectiveFrom]);
    if (supersedesRateId) {
      const corrected = live.find((row) => row.rate_id === supersedesRateId);
      if (!corrected || corrected.user_id !== input.userId) throw new CommandValidationError([{ field: "supersedesRateId", code: "NOT_FOUND", message: "That rate is not this person's." }]);
      if (corrected.superseded) throw new CommandValidationError([{ field: "supersedesRateId", code: "ALREADY_SUPERSEDED", message: "That rate has already been corrected; correct the correction instead." }]);
    }
    const clash = live.find((row) => row.user_id === input.userId && row.effective_from === input.effectiveFrom && !row.superseded && row.rate_id !== supersedesRateId);
    if (clash) throw new CommandValidationError([{ field: "effectiveFrom", code: "DUPLICATE", message: "A rate from that date already stands for this person; correct it instead." }]);
    const rateId = `staff-rate:${randomUUID()}`;
    const fields = { costPerHour: input.costPerHour ?? null, sellPerHour: input.sellPerHour ?? null, currency: input.currency ?? STAFF_RATE_DEFAULT_CURRENCY };
    await db.query(
      `INSERT INTO nzi_console.staff_rates (organisation_id, rate_id, user_id, effective_from, cost_per_hour, sell_per_hour, currency, supersedes_rate_id, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [context.organisationId, rateId, input.userId, input.effectiveFrom, fields.costPerHour, fields.sellPerHour, fields.currency, supersedesRateId, context.actorId]);
    return {
      data: { rateId, userId: input.userId, effectiveFrom: input.effectiveFrom, ...fields, supersedesRateId },
      entityType: "staff_rate", entityId: rateId, topic: "staff.rate.set",
    };
  });
}
