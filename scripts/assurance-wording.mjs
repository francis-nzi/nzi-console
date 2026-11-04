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
 * "validated" / "validation" are valid copy and are never flagged: they are the right words for a forward-looking plan or projection (a reduction
 * pathway, a strategy estimate), where "verified" would claim a measurement that has not happened. Only the assur- family is looked for.
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
 * Only what is not copy (identifiers) and the pinned report layouts composed@1-4, whose issued wording never moves. Nothing else is exempt.
 */
export const ASSURANCE_SANCTIONED = [
  // Identifiers that happen to be a bare word.
  { line: "const assurance = {", why: "a local variable, not copy" },
  { line: "{ ...composition, assurance, ", why: "an object shorthand property, not copy" },
  { line: "const assured = await listAssuredPeriodSnapshots", why: "a local variable, not copy" },
  { line: "as the assured footprint.", why: "a JSX comment continuation (the same line check-terminology already sanctions for NZC-039)" },
  // Not emissions verification.
  { file: "apps/console/app/platform/PlatformBoard.tsx", line: "Run assurance checks", why: "platform security and audit assurance (the Platform governance page), not the emissions verification service" },
  { file: "apps/console/app/platform/PlatformBoard.tsx", line: "Tenant assurance", why: "platform security and audit assurance (tenant isolation and audit evidence), not the emissions verification service" },
  // Pinned layouts. A report issued under composed@1-4 reads as it was issued (F-0): their wording is frozen, so a wording change rides a new layout version.
  { file: "apps/console/app/reports/[versionId]/ReportComposedView.tsx", why: "ComposedV1 draws composed@1-4, pinned byte for byte: an issued report's wording never moves" },
  { file: "packages/contracts/src/reportComposition.ts", line: "assured emissions", why: "reportHeadline is read at render time only by ComposedV1 (composed@1-4): frozen with them" },
  { file: "packages/contracts/src/reportComposition.ts", line: "first assured", why: "reportHeadline (the first-period sentences), frozen with composed@1-4 as above" },
  { file: "packages/contracts/src/reportComposition.ts", line: '"Assurance basis"', why: "reportMethodologyRows is drawn by composed@3/4 only (composed@5+ draws its own Verification basis): frozen with them" },
  { file: "packages/contracts/src/reportComposition.ts", line: 'eyebrow: "Assurance"', why: "reportSectionMetaV4 is composed@4's heading table; composed@5+ use reportSectionMetaV5" },
];

export const isAssuranceSanctioned = (relativePath, line) => {
  const path = relativePath.replace(/\\/g, "/");
  return ASSURANCE_SANCTIONED.some((entry) => (entry.file === undefined || entry.file === path) && (entry.line === undefined || line.includes(entry.line)));
};
