import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bankIssues, formatSortCode, maskAccountNumber, maskSortCode, normaliseBank, normaliseProfile, organisationFooter, profileIssues, type OrganisationProfileFields,
} from "../src/adminOrganisation";

/** Organisation settings (admin Phase D, D1): the pure rules the command and the screen share — and 0142's CHECKs hold again. */
const blank: OrganisationProfileFields = {
  legalName: null, displayName: null, shortName: null, registrationNumber: null, vatNumber: null, addressLine1: null, addressLine2: null, addressCity: null, addressRegion: null,
  addressPostcode: null, addressCountry: null, contactEmail: null, contactPhone: null, websiteUrl: null, footerOverride: null, signatoryUserId: null, signatoryTitle: null,
};

describe("the organisation profile's rules", () => {
  it("normalises: text trimmed and collapsed, blanks to null, numbers upper-cased without spaces, the email lower-cased", () => {
    const out = normaliseProfile({ ...blank, legalName: "  Example   Ltd ", addressLine2: "   ", registrationNumber: "ab 12 34", vatNumber: "gb 123 4567 89", contactEmail: "Info@Example.TEST" });
    assert.deepEqual([out.legalName, out.addressLine2, out.registrationNumber, out.vatNumber, out.contactEmail], ["Example Ltd", null, "AB1234", "GB123456789", "info@example.test"]);
  });

  it("refuses what 0142 refuses", () => {
    const codes = (fields: Partial<OrganisationProfileFields>) => profileIssues({ ...blank, ...fields }).map((issue) => `${issue.field}:${issue.code}`);
    assert.deepEqual(codes({ vatNumber: "GB!" }), ["vatNumber:INVALID"]);
    assert.deepEqual(codes({ websiteUrl: "example.test" }), ["websiteUrl:INVALID"]);
    assert.deepEqual(codes({ contactPhone: "call me" }), ["contactPhone:INVALID"]);
    assert.deepEqual(codes({ signatoryTitle: "Director" }), ["signatoryTitle:NO_SIGNATORY"]);
    assert.deepEqual(codes({ legalName: "x".repeat(201) }), ["legalName:TOO_LONG"]);
    assert.deepEqual(codes({ vatNumber: "GB123456789", registrationNumber: "AB123456", websiteUrl: "https://example.test", contactPhone: "+44 (0)20 7946 0000" }), []);
  });

  it("derives the footer as v7 built it — legal name · website · company number · VAT number — unless overridden", () => {
    const fields = { ...blank, legalName: "Example Ltd", displayName: "Example", websiteUrl: "https://example.test/", registrationNumber: "AB123456", vatNumber: "GB123456789" };
    assert.equal(organisationFooter(fields), "Example Ltd | example.test | Company No. AB123456 | VAT No. GB123456789");
    assert.equal(organisationFooter({ ...fields, legalName: null, vatNumber: null }), "Example | example.test | Company No. AB123456");
    assert.equal(organisationFooter({ ...fields, footerOverride: "Our own footer" }), "Our own footer");
    assert.equal(organisationFooter(blank), "");
  });
});

describe("the bank details' rules", () => {
  it("normalise the sort code to six digits and refuse a half-entered account", () => {
    assert.deepEqual(normaliseBank({ accountName: " Example Ltd ", sortCode: "12-34 56", accountNumber: "8765 4321" }), { accountName: "Example Ltd", sortCode: "123456", accountNumber: "87654321" });
    assert.deepEqual(bankIssues({ accountName: "A", sortCode: null, accountNumber: null }).map((issue) => issue.field), ["sortCode", "accountNumber"]);
    assert.deepEqual(bankIssues({ accountName: "A", sortCode: "12345", accountNumber: "1234567" }).map((issue) => issue.code), ["INVALID", "INVALID"]);
    assert.deepEqual(bankIssues({ accountName: null, sortCode: null, accountNumber: null }), [], "cleared is allowed");
  });

  it("mask to the last digits, and format the sort code", () => {
    assert.deepEqual([maskAccountNumber("87654321"), maskSortCode("123456"), formatSortCode("123456"), maskAccountNumber(null)], ["•••• 4321", "••-••-56", "12-34-56", null]);
  });
});
