import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatDate as chartDate } from "@nzi/charts";
import { formatDate, formatDateTime, formatMonth } from "../app/lib/formatDate";

describe("date display format", () => {
  it("renders dd/mm/yyyy with zero padding", () => {
    assert.equal(formatDate("2026-03-31"), "31/03/2026");
    assert.equal(formatDate("2026-01-09"), "09/01/2026");
    assert.equal(formatDate("2022-04-01"), "01/04/2022");
  });

  it("never shifts a date-only value across a day boundary", () => {
    // new Date("2026-04-01") is UTC midnight; reading local components off it moves
    // the day backwards west of UTC. Date-only strings are reformatted, not parsed.
    for (const iso of ["2026-01-01", "2026-06-30", "2026-12-31"]) {
      const [y, m, d] = iso.split("-");
      assert.equal(formatDate(iso), `${d}/${m}/${y}`);
    }
  });

  it("formats a timestamp as dd/mm/yyyy HH:mm", () => {
    assert.match(formatDateTime("2026-09-09T12:34:56Z"), /^\d{2}\/\d{2}\/2026 \d{2}:\d{2}$/);
  });

  it("passes non-date label text through instead of blanking it", () => {
    // next_report_due_label carries free text as well as dates.
    assert.equal(formatDate("Baseline in progress"), "Baseline in progress");
    assert.equal(formatDate("Overdue"), "Overdue");
  });

  it("shows a dash for an absent value", () => {
    assert.equal(formatDate(null), "—");
    assert.equal(formatDate(undefined), "—");
    assert.equal(formatDate(""), "—");
    assert.equal(formatDateTime(null), "—");
  });

  it("keeps month pickers as month labels, not dates", () => {
    assert.equal(formatMonth("2026-01"), "Jan 2026");
  });

  it("renders chart provenance dates in the same format, locale-independently", () => {
    // @nzi/charts formats from UTC components so one spec prints identically to
    // screen, PDF and portal — it must still agree with the console on dd/mm/yyyy.
    assert.equal(chartDate("2026-03-31T00:00:00Z"), "31/03/2026");
    assert.equal(chartDate("2026-01-09T23:59:59Z"), "09/01/2026");
  });
});
