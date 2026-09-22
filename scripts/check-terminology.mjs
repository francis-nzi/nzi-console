import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * NZC-039, enforced: user-facing copy says "emissions", never "footprint".
 *
 * The decision was confirmed on 29 Aug 2026 and the code drifted from it anyway — twenty-four separate
 * strings across the client board, the SRS forms, the portal, the report composer and the CRP chart
 * catalogue. A rule nobody checks is a rule that holds until somebody types the other word, which is the
 * same lesson as the conflict-marker and date gates.
 *
 * ## What it looks at, and what it deliberately does not
 *
 * **Copy a person reads**: string literals and JSX text in the console app and in the packages that
 * produce labels, chart titles and report prose.
 *
 * Out of scope, because NZC-039 is about copy rather than code:
 *
 *   * **identifiers** — `id: "footprint"`, `latestFootprint`, `latest_footprint_tco2e`,
 *     `footprint.scope1`. Renaming those is a separate decision Francis has reserved;
 *   * **comments**, which no user reads;
 *   * **migrations and seeds**, which are frozen and not copy;
 *   * **the PCF module**, which NZC-039 names as the one sanctioned home for the term — "Product Carbon
 *     Footprint" is the correct term of art there.
 *
 * It is a heuristic on lines rather than a parse, so it can be fooled; the allowlist below is where every
 * exception is stated with its reason, so an exception is a decision somebody wrote down rather than a
 * silent pass.
 */

const ROOTS = [
  "apps/console/app",
  "packages/contracts/src",
  "packages/charts/src",
  "packages/ui/src",
  "packages/mock-data/src",
];

const EXTENSIONS = [".ts", ".tsx", ".css"];

/** Lines that may say it, each with why. Matched as substrings against the trimmed line. */
const SANCTIONED = [
  // NZC-039's own exemption: the PCF module's term of art.
  { match: "Product Carbon Footprint", why: "NZC-039 reserves the term for the PCF module" },
  { match: "isPcf", why: "chooses the PCF wording, which is sanctioned" },
  { match: 'family === "pcf"', why: "chooses the PCF wording, which is sanctioned" },
  { match: 'family: "pcf"', why: "a PCF job, whose title is the sanctioned term of art" },
  // Identifiers, which Francis has held pending a separate call on scope.
  { match: 'id: "footprint"', why: "a chart id, not copy" },
  { match: "latestFootprint", why: "a read-model field name, not copy" },
  { match: "latest_footprint_tco2e", why: "a column name, not copy" },
  { match: "footprintsRecorded", why: "a local variable, not copy" },
  { match: '"footprint.scope', why: "an SRS requirement id, not copy" },
  { match: '"footprint.method"', why: "an SRS requirement id, not copy" },
  { match: '"footprint.provenance"', why: "an SRS requirement id, not copy" },
  { match: '"footprint.assurance"', why: "an SRS requirement id, not copy" },
  // Continuation lines of block or JSX comments, which no user reads. The line-based check cannot see
  // that they are inside a comment because they do not start with one.
  { match: "against the target and the measured footprint. */}", why: "a JSX comment" },
  { match: "as the assured footprint.", why: "a comment continuation" },
  { match: "footprint so the two can be compared", why: "a comment continuation" },
  // The LCA module. NZC-039 names PCF as the sanctioned home for the term and says nothing about LCA,
  // which shares the surface; whether the exemption extends to it is Francis's call, and these are
  // carbon-adjacent copy so they go through the review gate rather than being changed here.
  { match: "title: `${noun} footprint`", why: "LCA/PCF chart title — pending a ruling on whether LCA shares the PCF exemption" },
  { match: "Footprint by life-cycle module", why: "LCA chart subtitle — pending the same ruling" },
];

/** A comment line, which is not copy. Block-comment bodies conventionally start with `*` here. */
const isComment = (line) => /^(\/\/|\*|\/\*)/.test(line.trimStart());

const walk = (dir, found = []) => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      walk(path, found);
    } else if (EXTENSIONS.some((extension) => entry.endsWith(extension))) {
      found.push(path);
    }
  }
  return found;
};

const offences = [];
let scanned = 0;

for (const root of ROOTS) {
  for (const file of walk(root)) {
    scanned += 1;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (!/footprint/i.test(line)) return;
      if (isComment(line)) return;
      if (SANCTIONED.some((exception) => line.includes(exception.match))) return;
      offences.push(`${relative(process.cwd(), file)}:${index + 1}  ${line.trim().slice(0, 110)}`);
    });
  }
}

// The same floor every other gate here carries: a scan over nothing passes, and would keep passing.
if (scanned < 100) {
  console.error(`✖ only ${scanned} files scanned — the roots are wrong, not the copy`);
  process.exit(1);
}

if (offences.length > 0) {
  console.error(`✖ NZC-039: user-facing copy must say "emissions", not "footprint":`);
  for (const offence of offences) console.error(`    ${offence}`);
  console.error(`  Rewrite the copy, or — if this is the PCF module or an identifier — add it to`);
  console.error(`  SANCTIONED in scripts/check-terminology.mjs with the reason.`);
  process.exit(1);
}

console.log(`✓ terminology: ${scanned} files, no "footprint" in user-facing copy (NZC-039)`);
