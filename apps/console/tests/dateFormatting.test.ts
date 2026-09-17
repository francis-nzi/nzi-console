import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Dates read dd/mm/yyyy, everywhere a person sees one (NZC-040).
 *
 * The rule has existed since NZC-040 and `formatDate` has been the single render edge for it.
 * What was missing was anything that noticed when a date went round the edge instead of through
 * it — so `2024-01-01 → 2024-12-31` reached the job Setup card, and a validation message told a
 * user their date "must use YYYY-MM-DD", which is the wire format and not something they typed.
 *
 * Neither failed anything. A raw ISO date renders perfectly; it is just wrong for the reader.
 * That is the same class as the committed conflict markers (NZC-086): damage no gate can see,
 * because every gate asks whether the code works.
 *
 * **ISO stays the storage and transport shape** — SQL `date`, command inputs, and the `value` of
 * an `<input type="date">`, which the browser then displays in the viewer's own locale. This
 * suite is about what is *rendered as text*, and deliberately ignores attribute values.
 */

/**
 * Located from this file, not from the working directory and not from git.
 *
 * Two failure modes are designed out here, both of which pass silently rather than failing:
 *
 * `git ls-files <path>` resolves its pathspec against the **working directory**, so an earlier
 * version scanned the whole console from the repo root and **nothing** from `apps/console` —
 * where it passed, having looked at no files at all. A vacuous pass is worse than a failure: it
 * reports safety it never checked.
 *
 * And shelling out to git at all is a liability in CI, where a checkout the runner does not own
 * makes `git rev-parse` fail outright with "dubious ownership" — a test that cannot run is a test
 * that cannot protect anything. This file knows where it is, so it walks the tree itself: no
 * subprocess, no git, no cwd.
 *
 * Every assertion still checks it actually looked at something before asserting what it found.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const SCANNED = ["apps/console/app", "packages/ui/src"];

const files = () => {
  const listed = SCANNED.flatMap((area) =>
    readdirSync(join(ROOT, area), { recursive: true, encoding: "utf8" })
      .filter((name) => name.endsWith(".tsx") || name.endsWith(".ts"))
      .map((name) => join(ROOT, area, name)));
  assert.ok(listed.length > 50, `expected to scan the console and ui sources, found ${listed.length} files`);
  return listed;
};

const read = (name: string) => readFileSync(name, "utf8");

/** Repo-relative, so a CI log names a file someone can open. */
const where = (name: string) => relative(ROOT, name).split("\\").join("/");

/**
 * Fields that hold a date or timestamp, named explicitly.
 *
 * A suffix pattern (`*Date`, `*At`, `*To`) was tried first and matched `validate`, `detail.what`
 * and `scopedTo` — which holds "Scope 1 · Direct emissions". A check that cries wolf gets
 * switched off, so this lists the fields rather than guessing at them. Adding a date-bearing
 * field to a read model means adding it here; that is the intended cost.
 */
const DATE_FIELDS = [
  "startDate", "dueDate", "targetDate", "assessedOn", "effectiveFrom", "inServiceFrom",
  "reportingFrom", "reportingTo", "validFrom", "validTo", "createdAt", "updatedAt",
  "capturedAt", "startedAt", "recordedAt", "reviewedAt", "sessionDate", "invoiceDate",
  "completedAt", "publishedAt", "approvedAt", "issuedAt", "floorFrom",
];

describe("every date a person sees is formatted", () => {
  it("renders no date field bare in text position", () => {
    const field = new RegExp(`(?:^|\\.)(?:${DATE_FIELDS.join("|")})$`);
    // Text position: `>{expr}` or ` {expr}` — never `attr={expr}`, which is a value, not a render.
    const interpolation = /([>\s])\{([A-Za-z0-9_.?[\]]+)\}/g;
    const leaks: string[] = [];

    for (const name of files()) {
      const text = read(name);
      for (const match of text.matchAll(interpolation)) {
        if (/=\s*$/.test(text.slice(Math.max(0, match.index - 40), match.index))) continue;
        if (!field.test(match[2]!)) continue;
        leaks.push(`${where(name)}:${text.slice(0, match.index).split("\n").length}  {${match[2]}}`);
      }
    }

    assert.deepEqual(leaks, [],
      `these render a raw ISO date to a reader — wrap them in formatDate/formatDateTime:\n  ${leaks.join("\n  ")}`);
  });

  it("tells a user about dd/mm/yyyy, never about YYYY-MM-DD", () => {
    // The wire format is not a thing the reader typed, so it is not a thing to correct them with.
    const leaks: string[] = [];
    for (const name of [...files(), join(ROOT, "packages/contracts/src/commands.ts")]) {
      let text: string;
      try { text = read(name); } catch { continue; }
      for (const match of text.matchAll(/message:\s*[`"']([^`"']*)[`"']/g)) {
        if (match[1]!.includes("YYYY-MM-DD")) leaks.push(`${where(name)}: ${match[1]}`);
      }
    }
    assert.deepEqual(leaks, [], `user-facing messages naming the wire format:\n  ${leaks.join("\n  ")}`);
  });

  it("keeps ISO where ISO belongs — the value of a date input", () => {
    // The complement, so a later "fix" cannot format an input value and break the control: a
    // date input requires ISO and renders it in the viewer's own locale.
    const inputs = files().map(read).join("\n").match(/type="date"[^>]*/g) ?? [];
    assert.ok(inputs.length > 0, "there are date inputs to protect");
    for (const input of inputs) {
      assert.ok(!/value=\{formatDate/.test(input), "a date input's value must stay ISO, not formatted");
    }
  });
});
