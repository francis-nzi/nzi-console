import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeImportIdentity, type SpendImportIdentity } from "@nzi/contracts";
import { buildSpendImportIdentity, signSpendImportIdentity, verifySpendImportToken, type Queryable } from "../src/index";

const SECRET = "0123456789abcdef0123456789abcdef"; // 32 bytes
const identity: SpendImportIdentity = {
  jobId: "job-712", jobNumber: "J000712", clientName: "Bushy Tails Ltd", jobName: "Annual CRP",
  reportingYear: 2024, reportingFrom: "2024-01-01", reportingTo: "2024-12-31", domain: "spend", templateVersion: 1,
};

describe("verifySpendImportToken", () => {
  it("accepts a token this backend signed", () => {
    const token = encodeImportIdentity(identity, signSpendImportIdentity(identity, SECRET));
    const result = verifySpendImportToken(token, SECRET);
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.identity, identity);
  });

  it("rejects a tampered identity (signature no longer matches)", () => {
    const token = encodeImportIdentity({ ...identity, reportingYear: 2099 }, signSpendImportIdentity(identity, SECRET));
    assert.deepEqual(verifySpendImportToken(token, SECRET), { ok: false, reason: "bad-signature" });
  });

  it("rejects a token signed with a different secret", () => {
    const token = encodeImportIdentity(identity, signSpendImportIdentity(identity, "ffffffffffffffffffffffffffffffff"));
    assert.deepEqual(verifySpendImportToken(token, SECRET), { ok: false, reason: "bad-signature" });
  });

  it("rejects a malformed token and a missing/short secret", () => {
    assert.deepEqual(verifySpendImportToken("garbage", SECRET), { ok: false, reason: "malformed" });
    assert.deepEqual(verifySpendImportToken(encodeImportIdentity(identity, signSpendImportIdentity(identity, SECRET)), "short"), { ok: false, reason: "bad-signature" });
  });
});

describe("buildSpendImportIdentity", () => {
  it("builds the identity from the job + client + reporting config", async () => {
    const db = {
      query: async () => ({
        rows: [{
          job_number: "J000712", title: "Annual CRP", client_name: "Bushy Tails Ltd",
          reporting_year: 2024, start_date: "2024-01-01", reporting_from: "2024-01-01", reporting_to: "2024-12-31",
        }],
      }),
    } as Queryable;
    assert.deepEqual(await buildSpendImportIdentity(db, "org-a", "job-712"), identity);
  });

  it("returns null when the job is not found", async () => {
    const db = { query: async () => ({ rows: [] }) } as Queryable;
    assert.equal(await buildSpendImportIdentity(db, "org-a", "nope"), null);
  });
});
