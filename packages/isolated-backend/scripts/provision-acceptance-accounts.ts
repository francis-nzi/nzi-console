/**
 * Provision the fixed staff + portal accounts the rendered-acceptance Playwright
 * suite (apps/console/tests/e2e) logs in with.
 *
 * Isolated non-production ONLY. Refuses to run against anything that is not
 * explicitly flagged `isolated-non-production`, and never against production.
 *
 *   NZI_ISOLATED_DATABASE_URL=... \
 *   NZI_DATABASE_BOUNDARY=isolated-non-production \
 *   NZI_CONSOLE_MFA_ENCRYPTION_KEY=... \
 *   npx tsx packages/isolated-backend/scripts/provision-acceptance-accounts.ts
 *
 * Idempotent: re-running rotates the TOTP secrets and re-prints them. Pass
 * --print-only to show the last-provisioned emails without touching the database
 * (secrets are not recoverable — a re-run is required to get fresh ones).
 *
 * On success it prints the four values the suite needs as env:
 *   ACCEPTANCE_STAFF_EMAIL, ACCEPTANCE_STAFF_PASSWORD, ACCEPTANCE_STAFF_TOTP
 *   ACCEPTANCE_PORTAL_EMAIL, ACCEPTANCE_PORTAL_PASSWORD, ACCEPTANCE_PORTAL_TOTP
 */
import { Pool } from "pg";
import { encryptTotpSecret, generateTotpSecret, hashPassword } from "../src/index";

const ORG = process.env.ACCEPTANCE_ORG_ID ?? "demo-nzi-console";
const STAFF_USER_ID = "acceptance-admin";
const STAFF_EMAIL = process.env.ACCEPTANCE_STAFF_EMAIL ?? "acceptance-admin@synthetic.invalid";
const PORTAL_USER_ID = "acceptance-portal";
const PORTAL_EMAIL = process.env.ACCEPTANCE_PORTAL_EMAIL ?? "acceptance-portal@synthetic.invalid";
// Deterministic passwords so a re-run does not require re-plumbing CI secrets; the
// TOTP secret is the second factor and is rotated every run.
const STAFF_PASSWORD = process.env.ACCEPTANCE_STAFF_PASSWORD ?? "acceptance-staff-pw-01";
const PORTAL_PASSWORD = process.env.ACCEPTANCE_PORTAL_PASSWORD ?? "acceptance-portal-pw-01";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function assertNonProductionBoundary(databaseUrl: string): void {
  if (process.env.NEXT_PUBLIC_APP_ENV === "production") throw new Error("Refusing to run: NEXT_PUBLIC_APP_ENV is production.");
  if (requireEnv("NZI_DATABASE_BOUNDARY") !== "isolated-non-production") throw new Error("Refusing to run: NZI_DATABASE_BOUNDARY must be 'isolated-non-production'.");
  const host = new URL(databaseUrl).host.toLowerCase();
  if (/prod(uction)?/.test(host) && !/non-?prod/.test(host)) throw new Error(`Refusing to run: database host "${host}" looks like production.`);
}

async function pickPortalJob(pool: Pool, clientHint: string | null): Promise<{ jobId: string; clientId: string }> {
  // Prefer a job that already has a published report (portal report-approval journey needs one).
  const published = await pool.query<{ job_id: string; client_id: string }>(
    `SELECT j.job_id, j.client_id
       FROM nzi_console.jobs j
       JOIN nzi_console.report_versions rv ON (rv.organisation_id, rv.job_id) = (j.organisation_id, j.job_id)
      WHERE j.organisation_id = $1 AND rv.status = 'published'
      ORDER BY j.job_id
      LIMIT 1`,
    [ORG],
  );
  if (published.rows[0]) return { jobId: published.rows[0].job_id, clientId: published.rows[0].client_id };
  const anyJob = await pool.query<{ job_id: string; client_id: string }>(
    `SELECT job_id, client_id FROM nzi_console.jobs
      WHERE organisation_id = $1 ${clientHint ? "AND client_id = $2" : ""}
      ORDER BY job_id LIMIT 1`,
    clientHint ? [ORG, clientHint] : [ORG],
  );
  if (!anyJob.rows[0]) throw new Error(`No jobs found for organisation ${ORG}; seed the synthetic demonstrator first.`);
  return { jobId: anyJob.rows[0].job_id, clientId: anyJob.rows[0].client_id };
}

async function main(): Promise<void> {
  const databaseUrl = requireEnv("NZI_ISOLATED_DATABASE_URL");
  const encryptionKey = requireEnv("NZI_CONSOLE_MFA_ENCRYPTION_KEY");
  assertNonProductionBoundary(databaseUrl);

  const pool = new Pool({ connectionString: databaseUrl, max: 2, application_name: "nzi-acceptance-provision" });
  try {
    const org = await pool.query(`SELECT 1 FROM nzi_console.organisations WHERE organisation_id = $1`, [ORG]);
    if (!org.rows[0]) throw new Error(`Organisation ${ORG} does not exist; run the synthetic seeds first.`);

    const staffTotp = generateTotpSecret();
    const portalTotp = generateTotpSecret();
    const staffPw = await hashPassword(STAFF_PASSWORD);
    const portalPw = await hashPassword(PORTAL_PASSWORD);
    const staffTotpEnc = encryptTotpSecret(staffTotp, encryptionKey);
    const portalTotpEnc = encryptTotpSecret(portalTotp, encryptionKey);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // --- Staff principal: membership (administrator) + credential ---
      await client.query(
        `INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status)
         VALUES ($1, $2, 'administrator', 'active')
         ON CONFLICT (organisation_id, user_id) DO UPDATE SET role_id = 'administrator', status = 'active'`,
        [ORG, STAFF_USER_ID],
      );
      await client.query(
        `INSERT INTO nzi_console.staff_credentials
           (organisation_id, user_id, email_normalized, password_salt, password_hash, totp_ciphertext, totp_iv, totp_tag)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (organisation_id, user_id) DO UPDATE SET
           email_normalized = EXCLUDED.email_normalized,
           password_salt = EXCLUDED.password_salt, password_hash = EXCLUDED.password_hash,
           totp_ciphertext = EXCLUDED.totp_ciphertext, totp_iv = EXCLUDED.totp_iv, totp_tag = EXCLUDED.totp_tag,
           enabled = true, failed_attempts = 0, locked_until = NULL, password_changed_at = now()`,
        [ORG, STAFF_USER_ID, STAFF_EMAIL.toLowerCase(), staffPw.salt, staffPw.hash, staffTotpEnc.ciphertext, staffTotpEnc.iv, staffTotpEnc.tag],
      );

      // --- Portal principal: user + credential + a durable job grant ---
      const { jobId, clientId } = await pickPortalJob(pool, null);
      await client.query(
        `INSERT INTO nzi_console.portal_users (organisation_id, portal_user_id, client_id, email_normalized, display_name, status)
         VALUES ($1, $2, $3, $4, 'Acceptance Portal User', 'active')
         ON CONFLICT (organisation_id, portal_user_id) DO UPDATE SET
           client_id = EXCLUDED.client_id, email_normalized = EXCLUDED.email_normalized, status = 'active'`,
        [ORG, PORTAL_USER_ID, clientId, PORTAL_EMAIL.toLowerCase()],
      );
      await client.query(
        `INSERT INTO nzi_console.portal_credentials
           (organisation_id, portal_user_id, password_salt, password_hash, totp_ciphertext, totp_iv, totp_tag, enabled)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true)
         ON CONFLICT (organisation_id, portal_user_id) DO UPDATE SET
           password_salt = EXCLUDED.password_salt, password_hash = EXCLUDED.password_hash,
           totp_ciphertext = EXCLUDED.totp_ciphertext, totp_iv = EXCLUDED.totp_iv, totp_tag = EXCLUDED.totp_tag,
           enabled = true, failed_attempts = 0, locked_until = NULL, password_changed_at = now()`,
        [ORG, PORTAL_USER_ID, portalPw.salt, portalPw.hash, portalTotpEnc.ciphertext, portalTotpEnc.iv, portalTotpEnc.tag],
      );
      await client.query(
        `INSERT INTO nzi_console.portal_access_grants
           (organisation_id, grant_id, client_id, portal_user_id, job_id, data_entry_starts_at, data_entry_expires_at)
         VALUES ($1, $2, $3, $4, $5, now() - interval '1 day', now() + interval '365 days')
         ON CONFLICT (organisation_id, portal_user_id, job_id) DO UPDATE SET
           revoked_at = NULL, data_entry_starts_at = now() - interval '1 day', data_entry_expires_at = now() + interval '365 days'`,
        [ORG, `grant-${PORTAL_USER_ID}`, clientId, PORTAL_USER_ID, jobId],
      );

      await client.query("COMMIT");

      process.stdout.write(
        [
          "",
          "Acceptance accounts provisioned. Export these for the Playwright run:",
          "",
          `  ACCEPTANCE_STAFF_EMAIL=${STAFF_EMAIL}`,
          `  ACCEPTANCE_STAFF_PASSWORD=${STAFF_PASSWORD}`,
          `  ACCEPTANCE_STAFF_TOTP=${staffTotp}`,
          `  ACCEPTANCE_PORTAL_EMAIL=${PORTAL_EMAIL}`,
          `  ACCEPTANCE_PORTAL_PASSWORD=${PORTAL_PASSWORD}`,
          `  ACCEPTANCE_PORTAL_TOTP=${portalTotp}`,
          "",
          `  portal user is granted job ${jobId} (client ${clientId})`,
          "",
          "The TOTP secrets are shown ONCE. Re-run this script to rotate them.",
          "",
        ].join("\n"),
      );
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`\nprovision-acceptance-accounts failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
