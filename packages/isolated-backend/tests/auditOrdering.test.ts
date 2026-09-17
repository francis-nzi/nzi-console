import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A random id is not a clock.
 *
 * `audit_event_id` is `audit-<randomUUID()>`, so ordering by it sorts alphabetically on a random
 * string. A test on main did exactly that and then took the last row as "the latest event"; it
 * failed roughly one run in eight, which is frequent enough to be noticed and rare enough to be
 * re-run away. The same mistake in a production path would be worse and quieter: an audit panel
 * showing an arbitrary event as the most recent one, with nothing to fail.
 *
 * The production read is already right — `ORDER BY occurred_at DESC, audit_event_id DESC`, a real
 * timestamp first and the id only to make ties stable. This keeps it that way: an `ORDER BY` that
 * mentions an audit id must order by time first.
 *
 * It does not try to catch every misuse of a random id, because it cannot. Ordering by an id to
 * *group* rows is legitimate and common — `DISTINCT ON (entry_id) … ORDER BY entry_id, score DESC`
 * needs it, and a line-item read groups by assessment. The narrow rule catches the case that has
 * actually bitten, and a rule that flagged those would be turned off within a week.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function sources(): string[] {
  const areas = ["packages/isolated-backend/src", "packages/isolated-backend/tests", "packages/isolated-backend/migrations", "apps/console/app"];
  return areas.flatMap((area) =>
    readdirSync(join(ROOT, area), { recursive: true, encoding: "utf8" })
      .filter((name) => name.endsWith(".ts") || name.endsWith(".tsx") || name.endsWith(".sql"))
      .map((name) => join(ROOT, area, name)));
}

describe("audit events are ordered by time, never by id alone", () => {
  it("scans something", () => {
    // A scanner with nothing to scan finds nothing wrong, which reads as safety it never checked.
    assert.ok(sources().length > 100, `expected the backend and console sources, found ${sources().length}`);
  });

  it("never orders by an audit id without a time column first", () => {
    const offenders: string[] = [];
    for (const file of sources()) {
      const text = readFileSync(file, "utf8");
      for (const [index, line] of text.split("\n").entries()) {
        const trimmed = line.trim();
        // Comments explain the rule; they are not the rule.
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("--")) continue;
        const at = line.indexOf("ORDER BY");
        if (at === -1) continue;
        const clause = line.slice(at);
        if (!clause.includes("audit_event_id")) continue;
        // Time first, id after, is the correct shape.
        const time = clause.indexOf("occurred_at");
        if (time !== -1 && time < clause.indexOf("audit_event_id")) continue;
        offenders.push(`${relative(ROOT, file).split("\\").join("/")}:${index + 1}`);
      }
    }
    assert.deepEqual(offenders, [],
      `these order audit events by a random id — put occurred_at first:\n  ${offenders.join("\n  ")}`);
  });
});
