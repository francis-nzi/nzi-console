import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { figuresIn, plaintextIn } from "./support/payloadScan";

/**
 * The payload scanner the real-database suites assert with (tests/support/payloadScan.ts): it must find a value that
 * leaked into a payload, and must not mistake the same characters inside an id or a timestamp for one — the flake that
 * hit serviceCatalogueReal (#390), suppliersReal (#396) and staffAdminReal.
 */
describe("the payload scanner", () => {
  const ids = {
    userId: "83d18497-dee7-40dc-8c1d-103ecd7e1420", rateId: "staff-rate:9540a3e1-4095-4c95-a540-950409540954",
    ref: "adadadadad", at: "2026-10-04T12:34:43.214321Z", day: "2026-10-04", occurredAt: new Date("2026-10-04T09:12:34.567Z"),
  };

  it("ignores names and figures that only occur inside ids, hex refs and timestamps", () => {
    assert.deepEqual(plaintextIn(ids, ["dee", "ada", "4321", "9540"]), []);
    assert.deepEqual(figuresIn(ids, [40, 95, 4321]), []);
  });

  it("finds a name or address in any text value — nested, in arrays, in JSON held as a string — and says where", () => {
    assert.deepEqual(plaintextIn({ ...ids, after: { name: "Dee Newcomer" } }, ["dee"]), ['$.after.name = "Dee Newcomer" (matches dee)']);
    assert.deepEqual(plaintextIn([null, { emails: ["x", "dee.new@example.test"] }], ["example.test"]), ['$[1].emails[1] = "dee.new@example.test" (matches example.test)']);
    assert.deepEqual(plaintextIn({ payload: JSON.stringify({ account: "87654321" }) }, ["4321"]), ['$.payload.account = "87654321" (matches 4321)'],
      "an all-digit value is never mistaken for a hex id — an account number is searched");
    assert.deepEqual(plaintextIn({ who: "Ada Admin" }, [/ada/i]).length, 1);
    assert.deepEqual(plaintextIn({ changed: ["displayName", "email"] }, ["dee", "newcomer"]), [], "field names in a changed list are not values");
  });

  it("finds an amount only as a whole value — a number or a numeric string", () => {
    assert.deepEqual(figuresIn({ ...ids, rate: 95, cost: "40.00" }, [40, 95]), ["$.rate = 95", "$.cost = 40.00"]);
    assert.deepEqual(figuresIn({ note: "seat 40 of 95", version: 2 }, [40, 95]), [], "digits inside other text are not an amount");
  });
});
