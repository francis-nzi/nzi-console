import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { requiredMigrationInvariants, validateDatabaseBoundary } from "../src/index";
const here = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(resolve(here, "../migrations/0001_core_schema.sql"), "utf8");
const security = readFileSync(resolve(here, "../migrations/0002_rls_and_roles.sql"), "utf8");
describe("isolated Postgres migrations", () => {
  it("contains every required tenant and command invariant", () => { const sql = `${schema}\n${security}`; for (const invariant of requiredMigrationInvariants) assert.ok(sql.includes(invariant), invariant); });
  it("uses composite tenant foreign keys for client, job, scope and report links", () => { assert.match(schema, /FOREIGN KEY \(organisation_id, client_id\)/); assert.match(schema, /FOREIGN KEY \(organisation_id, job_id\)/); });
  it("makes audit history non-updateable and non-deleteable", () => { assert.match(security, /REVOKE DELETE ON nzi_console\.audit_events/); assert.match(security, /REVOKE UPDATE ON nzi_console\.audit_events/); });
  it("allocates the global job sequence inside the caller transaction", () => { assert.match(schema, /CREATE FUNCTION allocate_job_sequence/); assert.match(schema, /UPDATE job_number_counter SET last_sequence = last_sequence \+ 1/); assert.match(security, /GRANT EXECUTE ON FUNCTION nzi_console\.allocate_job_sequence/); });
  it("refuses missing, production, or unconfirmed database targets", () => { assert.throws(() => validateDatabaseBoundary({ appEnv: "staging" })); assert.throws(() => validateDatabaseBoundary({ appEnv: "production", boundaryToken: "isolated-non-production", isolatedDatabaseUrl: "postgresql://db/test" })); const url = validateDatabaseBoundary({ appEnv: "staging", boundaryToken: "isolated-non-production", isolatedDatabaseUrl: "postgresql://db/test" }); assert.equal(url.searchParams.get("application_name"), "nzi-console-isolated"); });
});
