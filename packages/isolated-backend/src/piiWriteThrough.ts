import { sealRowPii, type SealingKeys } from "./piiSealing";
import { resolveSealingKeys } from "./piiSealingKeys";
import type { Queryable } from "./postgres";

/**
 * What the write paths call (NZC-119).
 *
 * One narrow function per person-table, so no call site names a sealed column, an index column or a
 * linkage field. Getting those wrong is the failure that does not announce itself — ciphertext on the
 * wrong row, or an index that disagrees with the value beside it — so they are stated once here and
 * the call sites pass only the values they already have.
 *
 * Every one of these runs **inside the caller's transaction, immediately after the plaintext write**,
 * so no row is ever committed with plaintext and no ciphertext. Where the plaintext write uses
 * `coalesce(...)` to leave fields alone, the call site seals from `RETURNING` rather than from its own
 * input: what matters is what the row now holds, not what was offered.
 */

type Seal = { db: Queryable; organisationId: string; actorId: string; keys?: SealingKeys };

const keysFor = (seal: Seal) => seal.keys ?? resolveSealingKeys();

/** A trainee's own details, and their sign-in address. */
export function sealTraineeRow(
  seal: Seal,
  row: { traineeId: string; personalEmail?: string | null; fullName?: string | null; phone?: string | null; currentEmployerName?: string | null },
) {
  const sealed: Record<string, string | null | undefined> = {};
  if (row.fullName !== undefined) sealed.full_name_sealed = row.fullName;
  if (row.phone !== undefined) sealed.phone_sealed = row.phone;
  if (row.currentEmployerName !== undefined) sealed.current_employer_name_sealed = row.currentEmployerName;
  return sealRowPii(seal.db, {
    organisationId: seal.organisationId,
    subject: { sourceTable: "trainees", sourceId: row.traineeId },
    table: "trainees",
    keyColumns: { organisation_id: seal.organisationId, trainee_id: row.traineeId },
    sealed,
    operational: row.personalEmail !== undefined
      ? [{ column: "trainees.personal_email", sealedColumn: "email_sealed", indexColumn: "email_bidx", field: "email", value: row.personalEmail }]
      : [],
  }, keysFor(seal), seal.actorId);
}

/**
 * A pending change of sign-in address, which holds two addresses and belongs to the trainee.
 *
 * The registry links four person-tables and a change record is not one of them, so it seals under the
 * trainee's key. Its digests are recorded against its own table, so the linker sees a change record
 * as history rather than as a second person.
 */
export function sealTraineeEmailChangeRow(
  seal: Seal,
  row: { traineeId: string; changeId: string; currentEmail: string | null; newEmail: string | null },
) {
  return sealRowPii(seal.db, {
    organisationId: seal.organisationId,
    subject: { sourceTable: "trainees", sourceId: row.traineeId },
    table: "trainee_email_changes",
    keyColumns: { organisation_id: seal.organisationId, change_id: row.changeId },
    linkageTable: "trainee_email_changes",
    linkageId: row.changeId,
    operational: [
      { column: "trainee_email_changes.current_email", sealedColumn: "current_email_sealed", indexColumn: "current_email_bidx", field: "current-email", value: row.currentEmail },
      { column: "trainee_email_changes.new_email", sealedColumn: "new_email_sealed", indexColumn: "new_email_bidx", field: "new-email", value: row.newEmail },
    ],
  }, keysFor(seal), seal.actorId);
}

/** A client's named contact. */
export function sealClientContactRow(
  seal: Seal,
  row: { contactId: string; email?: string | null; fullName?: string | null; jobTitle?: string | null; phone?: string | null },
) {
  const sealed: Record<string, string | null | undefined> = {};
  if (row.fullName !== undefined) sealed.full_name_sealed = row.fullName;
  if (row.jobTitle !== undefined) sealed.job_title_sealed = row.jobTitle;
  if (row.phone !== undefined) sealed.phone_sealed = row.phone;
  return sealRowPii(seal.db, {
    organisationId: seal.organisationId,
    subject: { sourceTable: "client_contacts", sourceId: row.contactId },
    table: "client_contacts",
    keyColumns: { organisation_id: seal.organisationId, contact_id: row.contactId },
    sealed,
    operational: row.email !== undefined
      ? [{ column: "client_contacts.email", sealedColumn: "email_sealed", indexColumn: "email_bidx", field: "email", value: row.email }]
      : [],
  }, keysFor(seal), seal.actorId);
}

/** A client-side portal account. */
export function sealPortalUserRow(
  seal: Seal,
  row: { portalUserId: string; emailNormalized?: string | null; displayName?: string | null },
) {
  const sealed: Record<string, string | null | undefined> = {};
  if (row.displayName !== undefined) sealed.display_name_sealed = row.displayName;
  return sealRowPii(seal.db, {
    organisationId: seal.organisationId,
    subject: { sourceTable: "portal_users", sourceId: row.portalUserId },
    table: "portal_users",
    keyColumns: { organisation_id: seal.organisationId, portal_user_id: row.portalUserId },
    sealed,
    operational: row.emailNormalized !== undefined
      ? [{ column: "portal_users.email_normalized", sealedColumn: "email_sealed", indexColumn: "email_bidx", field: "email", value: row.emailNormalized }]
      : [],
  }, keysFor(seal), seal.actorId);
}

/** A staff member's place in an organisation — the subject a staff person is, by ruling. */
export function sealMembershipRow(
  seal: Seal,
  row: { userId: string; email?: string | null; displayName?: string | null },
) {
  const sealed: Record<string, string | null | undefined> = {};
  if (row.displayName !== undefined) sealed.display_name_sealed = row.displayName;
  return sealRowPii(seal.db, {
    organisationId: seal.organisationId,
    subject: { sourceTable: "memberships", sourceId: row.userId },
    table: "memberships",
    keyColumns: { organisation_id: seal.organisationId, user_id: row.userId },
    sealed,
    operational: row.email !== undefined
      ? [{ column: "memberships.email", sealedColumn: "email_sealed", indexColumn: "email_bidx", field: "email", value: row.email }]
      : [],
  }, keysFor(seal), seal.actorId);
}

/**
 * A staff login address.
 *
 * `staff_credentials` references `memberships` by primary key, so the subject is always the membership
 * — there is no such thing as a credential without one. Its digest is recorded against `memberships`
 * under a distinct field, because the login address and the membership address are two values that
 * happen to usually agree, and recording them as one would hide the case where they do not.
 */
export function sealStaffCredentialRow(
  seal: Seal,
  row: { userId: string; emailNormalized: string | null },
) {
  return sealRowPii(seal.db, {
    organisationId: seal.organisationId,
    subject: { sourceTable: "memberships", sourceId: row.userId },
    table: "staff_credentials",
    keyColumns: { organisation_id: seal.organisationId, user_id: row.userId },
    linkageTable: "memberships",
    linkageId: row.userId,
    operational: [
      { column: "staff_credentials.email_normalized", sealedColumn: "email_sealed", indexColumn: "email_bidx", field: "login-email", value: row.emailNormalized },
    ],
  }, keysFor(seal), seal.actorId);
}
