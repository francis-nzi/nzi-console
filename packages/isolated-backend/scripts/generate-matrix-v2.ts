// Generates migration 0073's matrix rows from the code matrix, so the two cannot disagree
// by transcription. Run once; the migration is the artefact, this is the tool that made it.
import { writeFileSync } from "node:fs";
import { PERMISSION_MATRIX_VERSION, ROLE_CAPABILITY_MATRIX, staffRoles } from "@nzi/contracts";

const rows: string[] = [];
for (const role of staffRoles) {
  for (const [capability, scope] of Object.entries(ROLE_CAPABILITY_MATRIX[role])) {
    rows.push(`  (${PERMISSION_MATRIX_VERSION}, '${role}', '${capability}', '${scope}')`);
  }
}

const sql = `BEGIN;

-- NZC-073 — Training gets its own capabilities, and the matrix moves to version 2.
--
-- Training is a module in exactly the sense that Actions and SRS Readiness are, and both of
-- those already carry their own capability. Running training off the generic job.manage was
-- the deviation: it meant anyone who could manage a job could issue NZI-branded verifiable
-- certificates. It also put moving a place's expiry under finance.manage, so Finance could
-- extend a place the delivering consultant could not — backwards, because extending an
-- already-granted place is an operational concession, not a commercial re-sale.
--
--   training.manage              bookings, attendance, stage transitions, certificate issuance
--   training.entitlement.manage  moving a place's expiry off its job-end default
--
-- Two things deliberately do NOT move:
--   * Reviewing a run stays snapshot.review. The consultant who delivers the course and
--     issues its certificates must not also approve the reviewed snapshot — the same
--     separation of duties that governs every other reviewed unit.
--   * Certificate issuance stays policy-gated on top of the capability: attendance decides
--     and consent holds. The capability says who may run the command; the policy decides
--     the outcome.
--
-- The matrix is migration-owned and versioned, so this is a new version rather than an edit
-- of version 1: a principal resolved against version 1 keeps meaning what it meant.

-- A capability may now carry more than one dot (training.entitlement.manage); the previous
-- pattern allowed exactly one and would have rejected it.
ALTER TABLE nzi_console.staff_role_capabilities DROP CONSTRAINT staff_role_capabilities_capability_check;
ALTER TABLE nzi_console.staff_role_capabilities
  ADD CONSTRAINT staff_role_capabilities_capability_check CHECK (capability ~ '^[a-z]+(\\.[a-z_]+)+$');

INSERT INTO nzi_console.staff_capability_matrix_versions (matrix_version, source, note)
VALUES (${PERMISSION_MATRIX_VERSION}, 'docs/PERMISSION_MATRIX.md', 'Adds training.manage and training.entitlement.manage, held by Admin and Consultant; run review stays snapshot.review (NZC-073).');

INSERT INTO nzi_console.staff_role_capabilities (matrix_version, role_id, capability, scope) VALUES
${rows.join(",\n")};

COMMIT;
`;

writeFileSync(new URL("../migrations/0073_training_capabilities.sql", import.meta.url), sql);
console.log(`wrote ${rows.length} rows for matrix version ${PERMISSION_MATRIX_VERSION}`);
