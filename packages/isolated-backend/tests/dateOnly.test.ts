import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dateOnly } from "../src/index";

describe("dateOnly", () => {
  it("keeps a SQL date on its own day when the server runs ahead of UTC", () => {
    // node-postgres builds a `date` as local midnight. Under BST that is 23:00Z the
    // previous day, so a UTC round-trip reported baseline periods and job dates one
    // day early — caught rendering a seeded 2022-04-01 baseline as 31/03/2022.
    assert.equal(dateOnly(new Date(2022, 3, 1, 0, 0, 0)), "2022-04-01");
    assert.equal(dateOnly(new Date(2023, 2, 31, 0, 0, 0)), "2023-03-31");
  });

  it("keeps a SQL date on its own day when the server runs behind UTC", () => {
    assert.equal(dateOnly(new Date(2024, 0, 1, 0, 0, 0)), "2024-01-01");
    assert.equal(dateOnly(new Date(2024, 11, 31, 0, 0, 0)), "2024-12-31");
  });

  it("zero-pads month and day", () => {
    assert.equal(dateOnly(new Date(2026, 0, 9, 0, 0, 0)), "2026-01-09");
  });

  it("passes an already-formatted string straight through", () => {
    assert.equal(dateOnly("2026-09-09"), "2026-09-09");
    assert.equal(dateOnly("2026-09-09T12:00:00Z"), "2026-09-09");
  });
});
