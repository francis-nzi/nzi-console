#!/usr/bin/env node
/**
 * The decision register's two invariants, checked at the gate.
 *
 * `docs/DECISIONS.md merge=union` (see `.gitattributes`) makes the recurring append-collision
 * resolve itself: every branch adds entries at the end, so two in flight always conflict there
 * even though neither touched the other's text, and union keeps both sides — which is the
 * resolution we reached by hand every time.
 *
 * **Union cannot detect the one thing that actually matters.** If two branches each mint the next
 * free number, union happily produces a file carrying that number twice, and the second heading to
 * be read wins wherever anything resolves a citation. That is the failure this script exists for,
 * and it is exactly the failure the automatic resolution makes more likely.
 *
 * (An example number is deliberately not written above: this scans its own source, so a decision id
 * used for illustration would be a citation pointing at nothing — which is the rule, working.)
 *
 * Two rules:
 *
 *   1. **Unique** — no number may appear as a heading twice. Hard failure.
 *   2. **No citation without a heading** — a `NZC-###` in code pointing at nothing is worse than no
 *      citation, because it reads as though the reasoning exists somewhere and the reader simply
 *      has not found it. Hard failure.
 *
 * Ordering is deliberately **not** enforced. The register is not sorted today — NZC-076 precedes
 * 075 and 074, from the days those were written — and a check that fails on existing, correct
 * content teaches people to skip the check. New entries are appended, which sorts them naturally
 * without a rule; the anomaly is reported for information and does not fail.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTER = join(ROOT, "docs", "DECISIONS.md");
/** Where a citation must resolve. Docs may name a decision in passing; code may not dangle. */
const CODE_AREAS = ["packages", "apps", "scripts"];
const CODE_EXTENSIONS = [".ts", ".tsx", ".mjs", ".js", ".sql"];

const fail = (message) => { console.error(`✖ ${message}`); process.exitCode = 1; };

const register = readFileSync(REGISTER, "utf8");
const headings = [...register.matchAll(/^### (NZC-(\d+))/gm)].map((match) => ({ id: match[1], number: Number(match[2]) }));

if (headings.length === 0) fail("No NZC headings found — is docs/DECISIONS.md intact?");

// 1. Unique. The failure union makes more likely, and cannot see.
const seen = new Map();
for (const heading of headings) {
  const count = (seen.get(heading.id) ?? 0) + 1;
  seen.set(heading.id, count);
}
const duplicates = [...seen.entries()].filter(([, count]) => count > 1).map(([id]) => id);
if (duplicates.length > 0) {
  fail(`Duplicate decision numbers: ${duplicates.join(", ")}.\n`
    + `  Two branches minted the same number. Renumber the later one to the next free id and\n`
    + `  update every citation of it in that branch's code.`);
}

// 2. No citation without a heading.
const known = new Set(headings.map((heading) => heading.id));
const sources = CODE_AREAS.flatMap((area) => {
  let entries;
  try { entries = readdirSync(join(ROOT, area), { recursive: true, encoding: "utf8" }); }
  catch { return []; }
  return entries
    .filter((name) => CODE_EXTENSIONS.some((extension) => name.endsWith(extension)))
    .filter((name) => !name.includes("node_modules"))
    .map((name) => ({ path: join(ROOT, area, name), label: `${area}/${name.split("\\").join("/")}` }));
});

if (sources.length < 100) fail(`Only ${sources.length} source files scanned — the scan is not reaching the code.`);

const dangling = new Map();
for (const source of sources) {
  let text;
  try { text = readFileSync(source.path, "utf8"); } catch { continue; }
  for (const match of text.matchAll(/NZC-(\d+)/g)) {
    const id = `NZC-${match[1]}`;
    if (known.has(id)) continue;
    if (!dangling.has(id)) dangling.set(id, new Set());
    dangling.get(id).add(source.label);
  }
}
if (dangling.size > 0) {
  const detail = [...dangling.entries()]
    .map(([id, files]) => `    ${id} — cited by ${[...files].slice(0, 3).join(", ")}${files.size > 3 ? ` (+${files.size - 3} more)` : ""}`)
    .join("\n");
  fail(`Decisions cited in code with no heading in docs/DECISIONS.md:\n${detail}\n`
    + `  Write the entry, or correct the citation. A pointer to nothing reads as reasoning that exists.`);
}

// Reported, never failed: the register is not sorted and does not need to be.
const unsorted = headings.filter((heading, index) => index > 0 && heading.number <= headings[index - 1].number);
if (unsorted.length > 0) {
  console.log(`  note: ${unsorted.length} heading(s) are out of numeric order `
    + `(${unsorted.slice(0, 3).map((heading) => heading.id).join(", ")}${unsorted.length > 3 ? ", …" : ""}). `
    + `Pre-existing and not an error — new entries append.`);
}

if (process.exitCode !== 1) {
  console.log(`✔ ${headings.length} decisions, all numbered uniquely; every NZC cited in code has a heading.`);
}
