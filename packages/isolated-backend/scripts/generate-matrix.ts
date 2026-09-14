// Generates a permission-matrix migration's rows from the code matrix, so the two cannot
// disagree by transcription.
//
// Version-agnostic, unlike the one-shot `generate-matrix-v2.ts` it replaces: the matrix is
// versioned and never edited, so every bump needs this again, and a script hardcoded to one
// version's filename and prose has to be rewritten each time — which is how the two copies
// drift apart in the first place.
//
//   npx tsx scripts/generate-matrix.ts <output.sql> "<version note>"
//
// The migration is the artefact; this is the tool that made it. Run it once, review the
// output, commit the SQL.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PERMISSION_MATRIX_VERSION, ROLE_CAPABILITY_MATRIX, staffRoles } from "@nzi/contracts";

const [output, note] = process.argv.slice(2);
if (!output || !note) {
  throw new Error('Usage: tsx scripts/generate-matrix.ts <output.sql> "<version note>"');
}

const rows: string[] = [];
for (const role of staffRoles) {
  for (const [capability, scope] of Object.entries(ROLE_CAPABILITY_MATRIX[role])) {
    rows.push(`  (${PERMISSION_MATRIX_VERSION}, '${role}', '${capability}', '${scope}')`);
  }
}

const sql = `BEGIN;

-- Permission matrix version ${PERMISSION_MATRIX_VERSION}.
--
-- Generated from ROLE_CAPABILITY_MATRIX by scripts/generate-matrix.ts, so the migration and
-- the code copy cannot disagree by transcription. A test holds them equal.
--
-- The matrix is migration-owned and versioned, so this is a NEW version rather than an edit
-- of the last one: a principal resolved against an earlier version keeps meaning what it
-- meant when it was resolved.
--
-- ${note}

INSERT INTO nzi_console.staff_capability_matrix_versions (matrix_version, source, note)
VALUES (${PERMISSION_MATRIX_VERSION}, 'docs/PERMISSION_MATRIX.md', '${note.replace(/'/g, "''")}');

INSERT INTO nzi_console.staff_role_capabilities (matrix_version, role_id, capability, scope) VALUES
${rows.join(",\n")};

COMMIT;
`;

writeFileSync(resolve(process.cwd(), output), sql);
console.log(`wrote ${rows.length} rows for matrix version ${PERMISSION_MATRIX_VERSION} to ${output}`);
