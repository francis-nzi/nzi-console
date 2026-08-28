import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {it} from "node:test";

const source=readFileSync(new URL("../app/jobs/CrpReleaseControl.tsx",import.meta.url),"utf8");

it("loads reviewed snapshots and immutable report versions for the governed job",()=>{assert.match(source,/reviewed-snapshots/);assert.match(source,/report-versions/);assert.match(source,/report\.jobId===jobId/);});
it("validates the latest snapshot against the shared manifest",()=>{assert.match(source,/crpProfessionalManifest\.version/);assert.match(source,/reviewedSnapshotId:snapshot\.id/);assert.match(source,/api\/isolated\/reports\/validate/);});
it("publishes only the validated version bound to the same snapshot",()=>{assert.match(source,/!validated/);assert.match(source,/reportVersionId:validated\.reportVersionId/);assert.match(source,/reviewedSnapshotId:snapshot\.id/);assert.match(source,/expectedStatus:"validated"/);assert.match(source,/api\/isolated\/reports\/publish/);});
