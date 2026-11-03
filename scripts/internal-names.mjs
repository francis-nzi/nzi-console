/**
 * The internal-name rule behind `check:terminology`: user-facing copy never says "v7".
 *
 * "v7" / "NZ Insights Pro v7" is what the platform was called before the console - a developer's word, meaningless to a client or to staff. It stays
 * in code comments, migration names, commit messages and developer docs; it must not appear in anything a person reads. This is the pure part (one
 * line in, the offending positions out), so it can be tested on its own.
 *
 * It is a heuristic on lines, like the rest of the guard. It flags the word `v7` standing alone (`v7`, `v7's`, `NZ Insights Pro v7`) and lets through
 * what is not copy: identifiers (`v7Record`, `V7_REINGEST_ACTOR`, `v7RowId`), kebab and dotted codes (`v7-record`, `nzi-pro-v7`, `v7.reingest.job`),
 * a lone code literal (`"v7"`, the provenance value) and an object key (`v7: "Imported"`).
 */

const STANDALONE = /(?<![\w.-])v7(?![\w-])(?!\.[A-Za-z])/gi;

/** A line without the comment that trails it (a double-slash note, a block note, a JSX comment); quotes are respected for the double slash. */
export function withoutTrailingComment(line) {
  let out = line.replace(/\{\/\*.*?\*\/\}/g, "").replace(/\/\*.*?\*\//g, "");
  let quote = null;
  for (let i = 0; i < out.length; i += 1) {
    const c = out[i];
    if (quote) { if (c === "\\") i += 1; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "/" && out[i + 1] === "/" && (i === 0 || /\s/.test(out[i - 1]))) return out.slice(0, i);
  }
  return out;
}

/** Column positions of every user-facing "v7" on a line of source (empty for a comment line or code that only uses it as an identifier). */
export function internalNameHits(line) {
  if (/^\s*(\/\/|\*|\/\*)/.test(line)) return [];
  const code = withoutTrailingComment(line);
  const hits = [];
  for (const match of code.matchAll(STANDALONE)) {
    const at = match.index;
    const before = code[at - 1], after = code[at + 2];
    if ((before === '"' || before === "'" || before === "`") && after === before) continue;       // "v7" - a code, not a sentence
    if ((after === ":" || (after === "?" && code[at + 3] === ":")) && /^\s*$|[{,]\s*$/.test(code.slice(0, at))) continue; // v7: "..." / v7?: - an object key
    hits.push(at);
  }
  return hits;
}

/**
 * Files that are operator tooling or importers, not a screen: their messages go to a developer's terminal. Each is stated with why, so an exception is
 * a decision somebody wrote down. (Anything they write that a person later reads is passed through `plainInternalNames` where it is shown.)
 */
export const INTERNAL_NAME_EXEMPT = [
  { match: /^packages\/contracts\/src\/userFacingText\.ts$/, why: "the helper that rewrites the name in stored text must name what it rewrites" },
  { match: /^packages\/contracts\/src\/v7Reingest\.ts$/, why: "the re-ingest tool's plan validation: run from a script by an operator, never drawn on a screen" },
  { match: /^packages\/isolated-backend\/src\/v7[A-Z]\w*\.ts$/, why: "the importers and the re-ingest tool: their output is a developer's terminal" },
  { match: /^packages\/isolated-backend\/src\/demoJobNumberRetirement\.ts$/, why: "a one-off operator command (its refusals go to the terminal)" },
  { match: /^packages\/isolated-backend\/src\/legacyReportSeal\.ts$/, why: "the importer's integrity refusal, raised while loading, not shown to a user" },
];
export const isInternalNameExempt = (relativePath) => INTERNAL_NAME_EXEMPT.some((entry) => entry.match.test(relativePath.replace(/\\/g, "/")));
