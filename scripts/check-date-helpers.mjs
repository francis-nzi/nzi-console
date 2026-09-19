#!/usr/bin/env node
/**
 * The guard on calendar-day conversions (NZC-106).
 *
 * Twice now a date has moved by a day in production code — NZC-096 in a reporting period,
 * NZC-105 in the monthly entry grid — and both times the mechanism was identical: a local
 * one-liner turning a Postgres `date` into a string with `toISOString().slice(0, 10)`.
 * `node-postgres` materialises a `date` as *local* midnight, so that expression answers with
 * the day before wherever the process runs ahead of UTC. London in BST runs ahead of UTC.
 *
 * Fixing the copies was not enough, because the copies were never the cause — writing one was
 * simply the obvious thing to do at each of eleven call sites. So the expression itself is now
 * refused, and the only way to convert is through the shared helpers in
 * `@nzi/contracts/dayValues`, each of which names which kind of value it is for.
 *
 * ## It also refuses a shadow
 *
 * NZC-105's defect was not an absent helper — the correct one existed and was exported. A
 * local `const dateOnly = …` quietly took precedence over it in the same file. A declaration
 * that shadows a shared day helper is therefore an error in its own right, whatever it does.
 *
 * ## Exemptions are allowed, and must say why
 *
 * Some of these expressions are correct: a round-trip validity check pinned at a UTC anchor,
 * an idempotency key that cannot be changed without reconciling the keys already stored. Those
 * carry `date-helper-exempt` with the reason in the comment. The marker is not a way to quiet
 * the gate — it is a requirement to write down what a later reader would otherwise "fix".
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not `new URL(...).pathname`: the repository path contains a space, and a URL
// pathname percent-encodes it — which resolves to a directory that does not exist, walks
// nothing, and reports a confident tick. A gate that scans nothing is worse than no gate.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Product code only. Tests construct dates freely, and are the place that proves the rule. */
const TREES = ["packages", join("apps", "console", "app")];
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "tests", "e2e"]);

/** Where the helpers are defined. Nothing else may declare these names. */
const CANONICAL = join("packages", "contracts", "src", "dayValues.ts");
const HELPER_NAMES = ["dateOnly", "dateOnlyOrNull", "utcDay", "utcDayOrNull", "todayInLondon", "monthsBetween", "monthKey"];

const EXEMPT_MARKER = "date-helper-exempt";
/** How far above a line its exemption may sit, so the reason can be a paragraph. */
const EXEMPT_LOOKBACK = 10;

const files = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) { walk(path); continue; }
    if (/\.tsx?$/.test(entry)) files.push(path);
  }
};
for (const tree of TREES) walk(join(ROOT, tree));

// The check that makes the rest of this meaningful. A resolution mistake — a mistyped tree, a
// percent-encoded path — would otherwise walk an empty list and pass everything.
if (files.length < 50) {
  console.error(`✖ scanned only ${files.length} files under ${ROOT} — that cannot be the whole product.`);
  console.error("  The gate is not reading the code it is supposed to guard. Fix the paths, not this number.");
  process.exit(1);
}

/** A comment line — prose about the rule is not a use of it. */
const isComment = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);

const problems = [];
for (const path of files) {
  const rel = relative(ROOT, path).split(sep).join("/");
  const lines = readFileSync(path, "utf8").split("\n");
  const canonical = relative(ROOT, path) === CANONICAL;

  const exemptedAt = (index) => {
    for (let back = 0; back <= EXEMPT_LOOKBACK; back += 1) {
      const line = lines[index - back];
      if (line !== undefined && line.includes(EXEMPT_MARKER)) return true;
    }
    return false;
  };

  lines.forEach((line, index) => {
    const at = `${rel}:${index + 1}`;
    if (isComment(line)) return;

    if (/\.toISOString\(\)\s*\.\s*(slice|substring|substr)\(/.test(line) && !exemptedAt(index)) {
      problems.push(`${at}\n    Slicing an ISO string to a day or a month reads a SQL \`date\` as an instant, which\n    moves it a day at any positive offset (NZC-096, NZC-105). Use dateOnly / utcDay /\n    monthsBetween from @nzi/contracts, or mark the line \`${EXEMPT_MARKER}\` with the reason.`);
    }

    if (!canonical) {
      const shadow = new RegExp(`(?:const|let|var|function)\\s+(${HELPER_NAMES.join("|")})\\b`).exec(line);
      if (shadow && !exemptedAt(index)) {
        problems.push(`${at}\n    Declares \`${shadow[1]}\`, shadowing the shared day helper of that name. A local copy is\n    how NZC-105 reached production: the correct helper existed and a shadow took precedence.\n    Import it from @nzi/contracts instead.`);
      }
    }
  });
}

if (problems.length > 0) {
  console.error(`\n✖ ${problems.length} calendar-day problem${problems.length === 1 ? "" : "s"}:\n`);
  for (const problem of problems) console.error(`  ${problem}\n`);
  console.error("  The helpers, and what each is for: packages/contracts/src/dayValues.ts\n");
  process.exit(1);
}

console.log(`✓ calendar days: ${files.length} files, no sliced ISO strings and no shadowed day helpers`);
