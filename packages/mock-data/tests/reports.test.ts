import assert from "node:assert/strict";
import test from "node:test";
import { findReportVersion, reportTemplates, reportVersionCompatible, reportVersions } from "../src/reports";

test("report versions retain their template and manifest versions", () => {
  assert.equal(reportVersions.every((version) => reportVersionCompatible(version, reportTemplates[0]!)), true);
  assert.equal(findReportVersion("CRP-J000712-v1")?.status, "published");
});

test("draft and published versions have distinct immutable identities", () => {
  assert.notEqual(reportVersions[0]?.id, reportVersions[1]?.id);
  assert.equal(reportVersions[0]?.version, 1);
  assert.equal(reportVersions[1]?.version, 2);
});
