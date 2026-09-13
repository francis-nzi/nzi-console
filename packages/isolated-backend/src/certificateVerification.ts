import type { Queryable } from "./postgres";

/**
 * Public certificate verification.
 *
 * A certificate is worth more if someone can confirm it without an account, so this is the
 * one read in the training spine with no session behind it — and therefore no tenant
 * context. It goes through `verify_training_certificate`, a SECURITY DEFINER function whose
 * return list is the whole contract: name, course, date, attendance, issuer and standing.
 * There is no shape of this call that returns an email, an employer, or a person's other
 * training, because the function cannot express one.
 *
 * A code that does not match returns `not-found`, the same as a revoked-then-deleted one
 * would — the page must not become an oracle for which part of a guess was right.
 */

export type CertificateVerification =
  | { state: "not-found" }
  | {
    state: "valid" | "revoked";
    personName: string;
    courseName: string;
    completedOn: string | null;
    attendancePct: number;
    certificateNumber: string;
    issuedOn: string;
    revokedOn: string | null;
    issuer: string;
  };

const dateOnly = (value: Date | string | null) => value === null ? null : value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);

export async function verifyTrainingCertificate(db: Queryable, verifyCode: string): Promise<CertificateVerification> {
  const trimmed = verifyCode.trim();
  if (trimmed === "") return { state: "not-found" };

  const result = await db.query<{
    person_name: string; course_name: string; completed_on: Date | string | null; attendance_pct: string;
    certificate_number: string; issued_on: Date | string; status: string; revoked_on: Date | string | null; issuer: string;
  }>(`SELECT * FROM nzi_console.verify_training_certificate($1)`, [trimmed]);

  const row = result.rows[0];
  if (!row) return { state: "not-found" };
  return {
    // A revoked certificate still verifies — the page says it was withdrawn rather than
    // pretending it never existed, which is the answer the person holding it needs.
    state: row.status === "issued" ? "valid" : "revoked",
    personName: row.person_name,
    courseName: row.course_name,
    completedOn: dateOnly(row.completed_on),
    attendancePct: Number(row.attendance_pct),
    certificateNumber: row.certificate_number,
    issuedOn: dateOnly(row.issued_on)!,
    revokedOn: dateOnly(row.revoked_on),
    issuer: row.issuer,
  };
}
