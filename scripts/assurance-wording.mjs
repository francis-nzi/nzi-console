import { withoutTrailingComment } from "./internal-names.mjs";

/**
 * The verification-wording rule behind `check:terminology` (NZC-170): in the carbon context NZI offers emissions **verification**, not assurance.
 * User-facing copy says "verification" / "verified" (and "verify"), never "assurance" / "assured" / "assure".
 *
 * What it looks at is copy: the words standing alone in a string or JSX text. It lets through what is not copy -
 *
 *   * identifiers and compounds: `assuredTotal`, `AssuranceGap`, `nz-assurance-drawer`, `data-assurance`, `facts.assuredYears`;
 *   * dotted codes: `"assurance.gap.resolve"` (a command key, an audit topic);
 *   * a lone lowercase code literal: `"assurance"` (a tab id) or `"assured"` (a stored provenance value) - a value, not a sentence;
 *   * an object key (`assurance: ...`), comments (whole-line and trailing).
 *
 * Internal names (tables such as `assured_period_snapshots`, the `assurance.gap.resolve` command, component and CSS names) are deliberately
 * not renamed; only what a person reads is. The existing email/MFA "verify / verification" is a different word's business and untouched.
 *
 * Like the rest of the guard it is a heuristic on lines. Every exception is stated with its reason below.
 */

const STANDALONE = /(?<![\w\-.$\/@#])([Aa]ssur(?:ance|ed|er|e|es|ing))(?![\w\-]|\.\w)/g;

/** Offsets of each user-facing "assurance / assured / assure" on a line of source (empty for a comment line or an identifier-only use). */
export function assuranceHits(line) {
  if (/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(line)) return [];
  const code = withoutTrailingComment(line);
  const hits = [];
  for (const match of code.matchAll(STANDALONE)) {
    const at = match.index, word = match[1];
    const before = code[at - 1], after = code[at + word.length];
    if ((before === '"' || before === "'" || before === "`") && after === before && word === word.toLowerCase()) continue;       // "assured" - a code, not a sentence
    if (word === word.toLowerCase() && /^\s*:/.test(code.slice(at + word.length)) && /^\s*$|[{,]\s*$/.test(code.slice(0, at))) continue; // assurance: ... - an object key
    hits.push(at);
  }
  return hits;
}

/**
 * Lines and files that may still say it, each with why. A line entry is a substring of the trimmed line; a file entry exempts the file.
 * These are the occurrences that are NOT "NZI offers carbon verification" copy, or are not mine to change in a UI sweep.
 */
export const ASSURANCE_SANCTIONED = [
  // Identifiers that happen to be a bare word.
  { line: "const assurance = {", why: "a local variable, not copy" },
  { line: "{ ...composition, assurance, ", why: "an object shorthand property, not copy" },
  { line: "const assured = await listAssuredPeriodSnapshots", why: "a local variable, not copy" },
  { line: "as the assured footprint.", why: "a JSX comment continuation (the same line check-terminology already sanctions for NZC-039)" },
  // Not carbon verification.
  { file: "apps/console/app/platform/PlatformBoard.tsx", why: "'Tenant assurance' / 'assurance checks' are the platform's security and audit assurance, not emissions verification" },
  { line: "placeholder=\"e.g. Limited assurance\"", why: "ISO 14064-3 'level of assurance' is a term of art for a supplier's service; held for review rather than rewritten" },
  // Pinned layouts. A report issued under composed@1-4 reads as it was issued (F-0): their wording is frozen, so a wording change rides a new layout version.
  { file: "apps/console/app/reports/[versionId]/ReportComposedView.tsx", why: "ComposedV1 draws composed@1-4, pinned byte for byte: an issued report's wording never moves" },
  { file: "packages/contracts/src/reportComposition.ts", line: "assured emissions", why: "reportHeadline is read at render time only by ComposedV1 (composed@1-4): frozen with them" },
  { file: "packages/contracts/src/reportComposition.ts", line: "first assured", why: "reportHeadline (the first-period sentences), frozen with composed@1-4 as above" },
  { file: "packages/contracts/src/reportComposition.ts", line: '"Assurance basis"', why: "reportMethodologyRows is drawn by composed@3/4 only (composed@5+ draws its own Verification basis): frozen with them" },
  { file: "packages/contracts/src/reportComposition.ts", line: 'eyebrow: "Assurance"', why: "reportSectionMetaV4 is composed@4's heading table; composed@5+ use reportSectionMetaV5" },
  // Held for a decision, not decided here.
  { file: "apps/console/app/portal/portalTermsContent.ts", why: "the portal's terms of access are legal text: changing the wording needs a new terms version and sign-off" },
  { line: "\"Advanced\", \"Assured\"]", why: "the SRS maturity ladder's top level, mirroring the versioned SRS framework held in the database (seeded by migrations 0070/0080/0082); renamed with a framework version, not here" },
];

export const isAssuranceSanctioned = (relativePath, line) => {
  const path = relativePath.replace(/\\/g, "/");
  return ASSURANCE_SANCTIONED.some((entry) => (entry.file === undefined || entry.file === path) && (entry.line === undefined || line.includes(entry.line)));
};
