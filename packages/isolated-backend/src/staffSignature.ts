import { randomUUID } from "node:crypto";
import {
  emailPersonFor, normaliseStaffSignature, STAFF_SIGNATURE_FIELDS, staffSignatureIssues,
  type EmailPerson, type StaffSignatureDefaults, type StaffSignatureFields, type StaffSignatureIssue,
} from "@nzi/contracts";
import { VersionConflictError } from "./errors";
import { sealMembershipRow } from "./piiWriteThrough";
import { withTenantWrite, type PoolLike, type Queryable } from "./postgres";

/**
 * A member of staff's email signature (email programme phase 5-2): the personal lines above 5-1's house chrome on an email
 * attributed to them, from their own record (0185).
 *
 * - **The member edits their own, and only their own** (R2). `updateOwnStaffSignature` takes the signed-in member — the
 *   session's user, from the account route — and writes that one row. There is no input naming another member, so there is
 *   no other member it can reach.
 * - **Versioned and audited** like every write to the record: `expectedVersion`, the record's `version` bumped, and an audit
 *   event naming the fields that changed — never their values (NZC-120).
 * - **Sealed** in the same transaction (NZC-119): the title, address and mobile are personal data.
 * - **Defaults** (R2): the name from the record, the title from their position, the address from their work email — so an
 *   un-edited member signs correctly.
 */

export type StaffSignatureRecord = { fields: StaffSignatureFields; defaults: StaffSignatureDefaults; version: number };
type Row = {
  display_name: string | null; email: string | null; position_label: string | null; version: number; status: string;
  signature_title: string | null; signature_email: string | null; signature_mobile: string | null; signature_sign_off: string | null;
};
const COLUMN: Record<keyof StaffSignatureFields, keyof Row> = {
  title: "signature_title", displayEmail: "signature_email", mobile: "signature_mobile", signOff: "signature_sign_off",
};

export class StaffSignatureError extends Error {
  constructor(message: string, readonly issues: readonly StaffSignatureIssue[] = []) { super(message); }
}

async function readRow(db: Queryable, userId: string, lock = false): Promise<Row | null> {
  const { rows } = await db.query<Row>(
    `SELECT m.display_name, m.email, pv.label AS position_label, m.version, m.status,
            m.signature_title, m.signature_email, m.signature_mobile, m.signature_sign_off
       FROM nzi_console.memberships m
       LEFT JOIN nzi_console.reference_values pv ON (pv.organisation_id, pv.value_id) = (m.organisation_id, m.position_value_id)
      WHERE m.user_id = $1${lock ? " FOR UPDATE OF m" : ""}`, [userId]);
  return rows[0] ?? null;
}

const recordOf = (row: Row): StaffSignatureRecord => ({
  fields: { title: row.signature_title, displayEmail: row.signature_email, mobile: row.signature_mobile, signOff: row.signature_sign_off },
  defaults: { name: row.display_name, positionTitle: row.position_label, workEmail: row.email },
  version: row.version,
});

/** The member's signature and its defaults, in the caller's tenant transaction. Null: no such member here. */
export async function readStaffSignature(db: Queryable, userId: string): Promise<StaffSignatureRecord | null> {
  const row = await readRow(db, userId);
  return row ? recordOf(row) : null;
}

/**
 * The personal lines a send attributed to this member carries (R1). Null — the organisation's chrome only — when there is no
 * such member, they are not active, or they have no name: an email is never signed by someone who cannot be named (R3).
 */
export async function emailPersonForMember(db: Queryable, userId: string): Promise<EmailPerson | null> {
  const row = await readRow(db, userId);
  if (!row || row.status !== "active") return null;
  const record = recordOf(row);
  return emailPersonFor(record.defaults, record.fields);
}

/** The signed-in member — from the session, never from a request body. */
export type SignatureMember = { organisationId: string; userId: string };

/** Save the signed-in member's own signature (R2). Unchanged fields write nothing; a changed one bumps the version and is audited. */
export async function updateOwnStaffSignature(
  pool: PoolLike, member: SignatureMember, input: StaffSignatureFields & { expectedVersion: number },
): Promise<StaffSignatureRecord & { changed: Array<keyof StaffSignatureFields> }> {
  const fields = normaliseStaffSignature(input);
  const issues = staffSignatureIssues(fields);
  if (issues.length) throw new StaffSignatureError("The signature was not saved.", issues);
  return withTenantWrite(pool, member.organisationId, async (db) => {
    const row = await readRow(db, member.userId, true);
    if (!row || row.status !== "active") throw new StaffSignatureError("Your staff record could not be found.");
    if (row.version !== input.expectedVersion) throw new VersionConflictError(input.expectedVersion, row.version);
    const changed = STAFF_SIGNATURE_FIELDS.filter((key) => row[COLUMN[key]] !== fields[key]);
    if (changed.length === 0) return { ...recordOf(row), changed };
    const { rows: [saved] } = await db.query<{ version: number }>(
      `UPDATE nzi_console.memberships
          SET signature_title = $2, signature_email = $3, signature_mobile = $4, signature_sign_off = $5,
              version = version + 1, updated_at = now(), updated_by = $1
        WHERE user_id = $1 RETURNING version`,
      [member.userId, fields.title, fields.displayEmail, fields.mobile, fields.signOff]);
    await sealMembershipRow({ db, organisationId: member.organisationId, actorId: member.userId },
      { userId: member.userId, signatureTitle: fields.title, signatureEmail: fields.displayEmail, signatureMobile: fields.mobile });
    // The fields that changed, by name — the values are personal data and never enter the audit trail.
    await db.query(
      `INSERT INTO nzi_console.audit_events (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, after_json)
       VALUES ($1, $2, $3, 'staff', 'staff.signature.updated', 'membership', $3, $2, $4::jsonb)`,
      [member.organisationId, `audit-${randomUUID()}`, member.userId, JSON.stringify({ userId: member.userId, version: saved!.version, changed })]);
    return { fields, defaults: recordOf(row).defaults, version: saved!.version, changed };
  });
}
