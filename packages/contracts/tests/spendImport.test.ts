import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canonicalImportIdentityJson,
  decodeImportIdentity,
  encodeImportIdentity,
  importRowStatus,
  reviewSpendImportRow,
  spendImportRowKey,
  summariseImportReview,
  type ImportRowContext,
  type SpendImportIdentity,
  type SpendImportRow,
} from "../src/index";

const identity: SpendImportIdentity = {
  jobId: "job-712", jobNumber: "J000712", clientName: "Bushy Tails Ltd", jobName: "Annual CRP",
  reportingYear: 2024, reportingFrom: "2024-01-01", reportingTo: "2024-12-31", domain: "spend", templateVersion: 3,
};

describe("spend import identity token", () => {
  it("round-trips through encode/decode with the signature intact", () => {
    const token = encodeImportIdentity(identity, "sig-abc123");
    const decoded = decodeImportIdentity(token);
    assert.equal(decoded.ok, true);
    if (decoded.ok) {
      assert.deepEqual(decoded.identity, identity);
      assert.equal(decoded.signature, "sig-abc123");
    }
  });

  it("survives unicode in the client name", () => {
    const spicy = { ...identity, clientName: "Åbrûk & Søn — Ünïcøde Ltd" };
    const decoded = decodeImportIdentity(encodeImportIdentity(spicy, "s"));
    assert.equal(decoded.ok && decoded.identity.clientName, "Åbrûk & Søn — Ünïcøde Ltd");
  });

  it("serialises identity fields in a fixed order", () => {
    const shuffled: SpendImportIdentity = {
      templateVersion: 3, domain: "spend", reportingTo: "2024-12-31", reportingFrom: "2024-01-01",
      reportingYear: 2024, jobName: "Annual CRP", clientName: "Bushy Tails Ltd", jobNumber: "J000712", jobId: "job-712",
    };
    assert.equal(canonicalImportIdentityJson(shuffled), canonicalImportIdentityJson(identity));
  });

  it("rejects a malformed, wrong-version or corrupt token", () => {
    assert.deepEqual(decodeImportIdentity("not-a-token"), { ok: false, reason: "malformed" });
    assert.deepEqual(decodeImportIdentity("a:b"), { ok: false, reason: "malformed" });
    assert.deepEqual(decodeImportIdentity("nzi-spend-import.v0:eyJ9:sig"), { ok: false, reason: "wrong-version" });
    assert.deepEqual(decodeImportIdentity("nzi-spend-import.v1:%%%:sig"), { ok: false, reason: "corrupt" });
    const notIdentity = encodeImportIdentity({ ...identity, domain: "commuting" as "spend" }, "s");
    assert.deepEqual(decodeImportIdentity(notIdentity), { ok: false, reason: "corrupt" });
  });
});

const context: ImportRowContext = {
  reportingFrom: "2024-01-01", reportingTo: "2024-12-31",
  categoryIds: new Set(["pgs-paper"]), factorIds: new Set(["f-paper"]), clientFactorIds: new Set(["cf-1"]),
};
const goodRow: SpendImportRow = {
  rowNumber: 1, description: "Office paper", netValue: 1240, vatPercent: 20, glCode: "7504",
  invoiceDate: "2024-03-14", purchasedGoodsCategoryId: "pgs-paper", factorSource: "dataset",
  factorId: "f-paper", datasetId: "ds-2024", clientFactorId: null, monthly: [],
};

describe("reviewSpendImportRow", () => {
  it("accepts a fully-resolved row", () => {
    const review = reviewSpendImportRow(goodRow, context, false);
    assert.equal(review.status, "accepted");
    assert.deepEqual(review.issues, []);
  });

  it("blocks on missing description, bad net, bad VAT, bad date, unresolved category/factor", () => {
    const bad = reviewSpendImportRow(
      { ...goodRow, description: "  ", netValue: null, vatPercent: 150, invoiceDate: "14/03/2024", purchasedGoodsCategoryId: "nope", factorId: "nope" },
      context, false,
    );
    assert.equal(bad.status, "blocked");
    const codes = bad.issues.map((issue) => issue.code).sort();
    assert.deepEqual(codes, ["CATEGORY_UNRESOLVED", "DESCRIPTION_REQUIRED", "FACTOR_UNRESOLVED", "INVOICE_DATE_INVALID", "NET_VALUE_INVALID", "VAT_PERCENT_INVALID"]);
  });

  it("treats out-of-period date, non-positive net and in-file duplicate as advisory (never blocks)", () => {
    const review = reviewSpendImportRow({ ...goodRow, netValue: -5, invoiceDate: "2023-12-31" }, context, true);
    assert.equal(review.status, "advisory");
    assert.deepEqual(review.issues.map((issue) => issue.code).sort(), ["DUPLICATE_IN_FILE", "INVOICE_DATE_OUTSIDE_PERIOD", "NON_POSITIVE_NET"]);
  });

  it("resolves a client factor by clientFactorId", () => {
    const review = reviewSpendImportRow({ ...goodRow, factorSource: "client", factorId: null, datasetId: null, clientFactorId: "cf-1" }, context, false);
    assert.equal(review.status, "accepted");
  });
});

describe("summariseImportReview / importRowStatus / spendImportRowKey", () => {
  it("counts by status", () => {
    const reviews = [
      reviewSpendImportRow(goodRow, context, false),
      reviewSpendImportRow({ ...goodRow, rowNumber: 2, netValue: -1 }, context, false),
      reviewSpendImportRow({ ...goodRow, rowNumber: 3, description: "" }, context, false),
    ];
    assert.deepEqual(summariseImportReview(reviews), { total: 3, accepted: 1, advisory: 1, blocked: 1 });
  });

  it("blocker beats advisory", () => {
    assert.equal(importRowStatus([{ code: "NON_POSITIVE_NET", severity: "advisory", message: "" }, { code: "DESCRIPTION_REQUIRED", severity: "blocker", message: "" }]), "blocked");
  });

  it("keys a within-file duplicate on description + net + GL, case-insensitively", () => {
    assert.equal(spendImportRowKey({ description: " Office Paper ", netValue: 1240, glCode: "7504" }), spendImportRowKey({ description: "office paper", netValue: 1240, glCode: "7504" }));
  });
});
