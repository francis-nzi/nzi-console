import { createHmac, timingSafeEqual } from "node:crypto";
import {
  canonicalImportIdentityJson,
  decodeImportIdentity,
  encodeImportIdentity,
  type SpendImportIdentity,
} from "@nzi/contracts";
import type { PoolLike, Queryable } from "./postgres";
import { withTenantRead } from "./postgres";

// The current spend template schema. Bump when the template's columns / identity
// block change so an old download is rejected at preflight (NZC-036).
export const SPEND_IMPORT_TEMPLATE_VERSION = 1;

// Domain-separated signing key derived from the console session secret, so the
// import token cannot be confused with a session token and no new env var is
// needed. The secret is passed in, never read from process.env here.
const signingKey = (secret: string): Buffer => createHmac("sha256", secret).update("nzi:spend-import-token:v1").digest();
const sign = (identityJson: string, secret: string): string => createHmac("sha256", signingKey(secret)).update(identityJson).digest("base64url");

/** The signature the identity carries in its token. Exposed for the token builder and tests; needs the secret. */
export function signSpendImportIdentity(identity: SpendImportIdentity, secret: string): string {
  return sign(canonicalImportIdentityJson(identity), secret);
}

const equal = (a: string, b: string): boolean => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

export type SpendImportTokenResult =
  | { ok: true; identity: SpendImportIdentity }
  | { ok: false; reason: "malformed" | "wrong-version" | "corrupt" | "bad-signature" };

/** Structural + signature check. The job-state check (period, template version) is done by the command inside its transaction. */
export function verifySpendImportToken(token: string, secret: string | undefined): SpendImportTokenResult {
  if (!secret || Buffer.byteLength(secret) < 32) return { ok: false, reason: "bad-signature" };
  const decoded = decodeImportIdentity(token);
  if (!decoded.ok) return decoded;
  return equal(decoded.signature, sign(canonicalImportIdentityJson(decoded.identity), secret))
    ? { ok: true, identity: decoded.identity }
    : { ok: false, reason: "bad-signature" };
}

type JobIdentityRow = {
  job_number: string;
  title: string;
  client_name: string;
  reporting_year: number | null;
  start_date: Date | string;
  reporting_from: Date | string | null;
  reporting_to: Date | string | null;
};

const day = (value: Date | string | null, fallback: string): string =>
  value == null ? fallback : value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);

export async function buildSpendImportIdentity(db: Queryable, organisationId: string, jobId: string): Promise<SpendImportIdentity | null> {
  const { rows } = await db.query<JobIdentityRow>(
    `SELECT j.job_number,j.title,c.name AS client_name,j.reporting_year,j.start_date,cfg.reporting_from,cfg.reporting_to
       FROM nzi_console.jobs j
       JOIN nzi_console.clients c ON (c.organisation_id,c.client_id)=(j.organisation_id,j.client_id)
       LEFT JOIN nzi_console.job_emissions_config cfg ON (cfg.organisation_id,cfg.job_id)=(j.organisation_id,j.job_id)
      WHERE j.organisation_id=$1 AND j.job_id=$2 AND j.job_family='crp'`,
    [organisationId, jobId],
  );
  const row = rows[0];
  if (!row) return null;
  const reportingYear = row.reporting_year ?? Number(day(row.start_date, "1970-01-01").slice(0, 4));
  return {
    jobId,
    jobNumber: row.job_number,
    clientName: row.client_name,
    jobName: row.title,
    reportingYear,
    reportingFrom: day(row.reporting_from, `${reportingYear}-01-01`),
    reportingTo: day(row.reporting_to, `${reportingYear}-12-31`),
    domain: "spend",
    templateVersion: SPEND_IMPORT_TEMPLATE_VERSION,
  };
}

/** Issue the identity + signed token the console embeds in the downloaded .xlsx (a veryHidden locked sheet). */
export async function issueSpendImportIdentity(
  pool: PoolLike,
  organisationId: string,
  jobId: string,
  secret: string | undefined,
): Promise<{ identity: SpendImportIdentity; token: string } | null> {
  if (!secret || Buffer.byteLength(secret) < 32) throw new Error("A dedicated session secret of at least 32 bytes is required to issue an import token.");
  return withTenantRead(pool, organisationId, async (db) => {
    const identity = await buildSpendImportIdentity(db, organisationId, jobId);
    if (!identity) return null;
    return { identity, token: encodeImportIdentity(identity, sign(canonicalImportIdentityJson(identity), secret)) };
  });
}
