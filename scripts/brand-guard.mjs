import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * `check:brand` — the brand foundation (`docs/BRAND.md`) as a gate rather than a hope.
 *
 * The brand kept regressing - a hand-drawn tree in place of the logo, a stray hex, a third typeface - because nothing
 * enforced the doc. Three rules, over the console app and the design system:
 *
 *   1. **The logo is only ever the real asset** (the airtight one). No inline `<svg>` may reproduce the mark: one that
 *      carries the wordmark ("net zero" / "international") or a cluster of rounded `<rect rx>` foliage tiles is refused,
 *      as is an `<img>` / `url()` that points at a "logo" or "tree" file outside `/brand/netzero-logo*`.
 *   2. **Colour is a token.** A raw hex in component source (`*.tsx`, component CSS) must be one of the colours
 *      `packages/ui/src/styles.css` defines as a custom property. Components reference `var(--…)`.
 *   3. **Type is Inter** (or the system stack). A `font-family` that introduces any other face is refused.
 *
 * Like `check:terminology` it is a heuristic on source text, not a parse, so every exception is a line in
 * `BRAND_SANCTIONED` with its reason: an exception is a decision somebody wrote down, never a silent pass.
 * Comments and test files are not scanned.
 */

export const ROOTS = ["apps/console", "packages/ui"];
const EXTENSIONS = [".tsx", ".css"];
export const TOKEN_FILE = "packages/ui/src/styles.css";

/**
 * What may still carry an off-brand value, each with why. `file` is an exact path, or a prefix ending in `/`; `rule` is
 * `logo` | `colour` | `font`; `line` (optional) is a substring of the offending source line; `hexes` (optional) lists the only colours it covers.
 */
export const BRAND_SANCTIONED = [
  // The token-definition files. They *are* the palette, so they cannot be held to it.
  { file: TOKEN_FILE, rule: "colour", why: "the design-system stylesheet defines the tokens; its own component rules predate and sit beside them" },
  { file: "packages/charts/", rule: "colour", why: "charts carry explicit hex for print determinism (tokens.ts) - outside the scanned roots, listed so the exemption is on the record" },
  // Report and print surfaces: a printed or issued report carries explicit hex so it renders the same on paper, in the PDF and in the portal
  // (the same print-determinism reason as the charts' tokens.ts), and composed@1-6 are pinned layouts whose look never moves once issued.
  { file: "apps/console/app/reports/[versionId]/report-composed.css", rule: "colour", why: "composed@1-4 print stylesheet: a pinned layout, explicit hex for print determinism" },
  { file: "apps/console/app/reports/[versionId]/report-composed5.css", rule: "colour", why: "composed@5+ print stylesheet (its own --r5 palette): explicit hex for print determinism" },
  { file: "apps/console/app/reports/[versionId]/ReportComposedV5.tsx", rule: "colour", why: "composed@5+ draws its charts as SVG with explicit fills, so the PDF matches the screen" },
  { file: "apps/console/app/jobs/[jobId]/report/report-studio.css", rule: "colour", why: "the report studio previews the printed report, so it uses the report's explicit print palette" },
  { file: "apps/console/app/portal/jobs/[jobId]/print/print.css", rule: "colour", why: "the portal's print view of an issued report: explicit hex for print determinism" },
  // Colours that predate the guard and are not yet design-system tokens. Baselined per hex, so the file is still guarded: a *new* off-token colour
  // in it fails. Each is a candidate to become a token (or a token reference) - not a precedent.
  { file: "apps/console/app/portal/shell/portal-shell.css", rule: "colour", why: "the client portal shell's own light/dark palette, baselined until it is folded into tokens",
    hexes: ["#0b1622", "#0d1b2a", "#13293e", "#14202c", "#14713e", "#163354", "#1d3147", "#1f9d57", "#2a4258", "#2e9e5b", "#2f6fb0", "#2fa264", "#58697a", "#7f93a8", "#8695a5", "#8a6100", "#b3321f", "#f1f5f3", "#f2fbf6", "#fff3da", "#fff8e8", "#b9892f", "#cdd9e6", "#e4e9ef", "#e4f4ea", "#e7eff8", "#e8614d", "#eef1f5", "#eef2f6", "#efa93d", "#f6edd7", "#f6f8fa"] },
  { file: "apps/console/app/page.tsx", rule: "colour", hexes: ["#123d35", "#7ce1ae", "#c8d8d2"], why: "the Control Room hero's gradient and ink, baselined until tokenised" },
  { file: "apps/console/app/portal/jobs/[jobId]/print/page.tsx", rule: "colour", hexes: ["#68766f", "#eef2f0"], why: "inline style on the portal print page, baselined until tokenised" },
  { file: "apps/console/app/portal-preview/PortalWorkspace.tsx", rule: "colour", hexes: ["#68766f", "#bce8d0"], why: "inline styles in the portal preview, baselined until tokenised" },
  { file: "apps/console/app/jobs/SpendImportPanel.tsx", rule: "colour", hexes: ["#b23b2e"], why: "an inline error ink on the spend import issues column, baselined until it becomes var(--danger)" },
  { file: "apps/console/app/portal/portal-intensity.css", rule: "colour", hexes: ["#bce3ce"], why: "the verified chip's border, baselined until tokenised" },
  // The system monospace stack for a code a person copies - a system face, not a brand typeface.
  { file: TOKEN_FILE, rule: "font", line: "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace", why: "the system monospace stack for the recovery codes a person copies" },
];

/** Paths that are not component source: tests, fixtures and the built output. */
const SKIPPED_DIR = new Set(["node_modules", ".next", "public", "tests", "test", "__tests__", "e2e", "e2e-gate"]);
const isTestFile = (name) => /\.(test|spec)\.[tj]sx?$/.test(name);

/** Blanks comments (keeping every newline, so a line number stays true). `//` comments exist only outside strings. */
export function stripComments(text, css = false) {
  let out = "", i = 0, quote = null;
  while (i < text.length) {
    const c = text[i], next = text[i + 1];
    if (quote) {
      out += c;
      if (c === "\\" && !css) { out += next ?? ""; i += 2; continue; }
      if (c === quote) quote = null;
      else if (c === "\n" && quote !== "`") quote = null;
      i += 1; continue;
    }
    if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop; continue;
    }
    if (!css && c === "/" && next === "/" && text[i - 1] !== ":") {
      while (i < text.length && text[i] !== "\n") { out += " "; i += 1; }
      continue;
    }
    if (c === '"' || c === "'" || (c === "`" && !css)) quote = c;
    out += c; i += 1;
  }
  return out;
}

const lineOf = (text, offset) => text.slice(0, offset).split("\n").length;

/* ------------------------------------------------------------------ 1. the logo */

const WORDMARK = /net\s*zero|international|\blogo\b/i;
const SVG_BLOCK = /<svg\b[\s\S]*?<\/svg>/gi;
const FOLIAGE_TILE = /<rect\b[^>]*\brx\s*=/gi;
/** The most rounded tiles a legitimate chart/icon draws before it is a mosaic: a bar with rounded ends, a legend swatch. */
const TILE_LIMIT = 3;
/**
 * A literal image path with "logo" or "tree" in its file name that is not the approved asset. Only a literal path ending in an
 * image extension counts: a client's own uploaded logo is served from an `/api/…/logo` route, and is not the NZI mark.
 */
const LOGO_REF = /(?:src\s*=\s*\{?\s*|srcSet\s*=\s*\{?\s*|url\(\s*)(["'`])([^"'`]*(?:logo|tree)[^"'`/]*\.(?:png|webp|svg|jpe?g|gif))\1/gi;
const APPROVED_LOGO = /^\/brand\/netzero-logo(?:-big-tree)?\.(?:png|webp)$/;

/** Every place the NZI mark is hand-drawn or mis-referenced: `[{ line, why }]`. Pure; takes comment-stripped source. */
export function logoHits(text) {
  const hits = [];
  for (const match of text.matchAll(SVG_BLOCK)) {
    const svg = match[0];
    const words = svg.match(WORDMARK);
    const tiles = (svg.match(FOLIAGE_TILE) ?? []).length;
    const badge = /<circle\b/i.test(svg) && tiles >= 2;
    if (words) hits.push({ line: lineOf(text, match.index), why: `an inline <svg> carrying "${words[0]}" - the wordmark is a file, never drawn` });
    else if (tiles > TILE_LIMIT || badge) hits.push({ line: lineOf(text, match.index), why: `an inline <svg> of ${tiles} rounded tiles${badge ? " and a circle" : ""} - a hand-drawn mosaic tree` });
  }
  for (const match of text.matchAll(LOGO_REF)) {
    if (APPROVED_LOGO.test(match[2])) continue;
    hits.push({ line: lineOf(text, match.index), why: `a logo/tree image at "${match[2]}" - use /brand/netzero-logo* or <NziLogo> / <NziMark> from @nzi/ui` });
  }
  return hits.sort((a, b) => a.line - b.line);
}

/* ------------------------------------------------------------------ 2. colour */

const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-zA-Z_-])/g;

/** `#abc` -> `#AABBCC`; an alpha form (`#rgba`, `#rrggbbaa`) keeps its alpha so it can never equal a token. */
export function normaliseHex(hex) {
  let h = hex.slice(1).toUpperCase();
  if (h.length === 3 || h.length === 4) h = [...h].map((d) => d + d).join("");
  return `#${h}`;
}

/** The colours `styles.css` defines as custom properties (`--emerald:#0BA75E`), normalised. */
export function tokenHexes(css) {
  const found = new Set();
  for (const match of stripComments(css, true).matchAll(/--[\w-]+\s*:\s*([^;}]*)/g)) {
    for (const hex of match[1].matchAll(HEX)) found.add(normaliseHex(hex[0]));
  }
  return found;
}

/** Raw hex on one line of source that is not a token: `[hex, …]`. */
export function colourHits(line, tokens) {
  const bad = [];
  for (const match of line.matchAll(HEX)) {
    // An anchor or id (`href="#add"`, `url(#fade)`) is not a colour: a hex must not sit directly in a link, fragment or selector context.
    const before = line.slice(0, match.index);
    if (/(?:href|xlinkHref|id|htmlFor|aria-\w+)\s*=\s*["'{`]*$/.test(before) || /url\(\s*["']?$/.test(before)) continue;
    if (!tokens.has(normaliseHex(match[0]))) bad.push(match[0]);
  }
  return bad;
}

/* ------------------------------------------------------------------ 3. type */

/** A CSS declaration runs to the `;` (its list may hold quoted names); a JSX attribute or style-object value is the one string. */
const FONT_DECL = /font-family\s*:\s*([^;}\n]*)|fontFamily\s*[:=]\s*\{?\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/gi;
const ALLOWED_FACES = new Set([
  "inter", "system-ui", "ui-sans-serif", "-apple-system", "blinkmacsystemfont", "segoe ui", "roboto", "helvetica neue", "helvetica", "arial", "sans-serif",
  "ui-monospace", "sfmono-regular", "menlo", "consolas", "monospace",
  "inherit", "initial", "unset",
]);

/** The faces in a `font-family` value that are neither Inter nor the system stack (a `var(--…)` is the token and passes). */
export function fontFaces(value) {
  return value
    .replace(/!important/gi, "")
    .replace(/var\([^)]*\)/gi, "")
    .split(",")
    .map((face) => face.trim().replace(/^["'`]|["'`]$/g, "").trim())
    .filter((face) => face && !/^var\(/i.test(face) && !/^\$\{/.test(face) && !ALLOWED_FACES.has(face.toLowerCase()));
}

/** Off-brand faces declared on one line: `[face, …]`. */
export function fontHits(line) {
  const bad = [];
  for (const match of line.matchAll(FONT_DECL)) {
    const value = match[1] ?? match[2] ?? match[3] ?? match[4] ?? "";
    bad.push(...fontFaces(value));
  }
  return bad;
}

/* ------------------------------------------------------------------ the scan */

export function isBrandSanctioned(rel, rule, lineText = "", hex = "") {
  return BRAND_SANCTIONED.some((entry) =>
    entry.rule === rule
    && (entry.file.endsWith("/") ? rel.startsWith(entry.file) : rel === entry.file)
    && (!entry.line || lineText.includes(entry.line))
    && (!entry.hexes || (hex !== "" && entry.hexes.some((allowed) => normaliseHex(allowed) === normaliseHex(hex)))));
}

/** Every offence in one file: `[{ rule, line, message, source }]`. */
export function scanSource(rel, text, tokens) {
  const css = rel.endsWith(".css");
  const code = stripComments(text, css);
  const lines = code.split("\n");
  const out = [];
  const add = (rule, line, message) => out.push({ rule, line, message, source: (text.split("\n")[line - 1] ?? "").trim().slice(0, 110) });
  for (const hit of logoHits(code)) if (!isBrandSanctioned(rel, "logo", lines[hit.line - 1] ?? "")) add("logo", hit.line, hit.why);
  lines.forEach((lineText, index) => {
    for (const hex of colourHits(lineText, tokens)) if (!isBrandSanctioned(rel, "colour", lineText, hex)) add("colour", index + 1, `${hex} is not a styles.css token - use var(--…)`);
    for (const face of fontHits(lineText)) if (!isBrandSanctioned(rel, "font", lineText)) add("font", index + 1, `font "${face}" is not Inter or the system stack`);
  });
  return out;
}

const walk = (dir, found = []) => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (!SKIPPED_DIR.has(entry)) walk(path, found);
    } else if (EXTENSIONS.some((extension) => entry.endsWith(extension)) && !isTestFile(entry)) {
      found.push(path);
    }
  }
  return found;
};

export function runBrandGuard(cwd = process.cwd()) {
  const tokens = tokenHexes(readFileSync(join(cwd, TOKEN_FILE), "utf8"));
  const offences = [];
  let scanned = 0;
  for (const root of ROOTS) {
    for (const file of walk(join(cwd, root))) {
      const rel = relative(cwd, file).replace(/\\/g, "/");
      scanned += 1;
      for (const hit of scanSource(rel, readFileSync(file, "utf8"), tokens)) offences.push({ file: rel, ...hit });
    }
  }
  return { offences, scanned, tokens: tokens.size };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { offences, scanned, tokens } = runBrandGuard();
  // The floor every gate here carries: a scan over nothing passes, and would keep passing.
  if (scanned < 100 || tokens < 10) {
    console.error(`✖ brand: ${scanned} files scanned, ${tokens} tokens read - the roots are wrong, not the brand`);
    process.exit(1);
  }
  if (offences.length > 0) {
    console.error("✖ docs/BRAND.md: off-brand UI. The logo is the real asset, colours are styles.css tokens, type is Inter:");
    for (const o of offences) console.error(`    ${o.file}:${o.line}  [${o.rule}] ${o.message}\n        ${o.source}`);
    console.error("  Fix it - or, for a genuine one-off, add it to BRAND_SANCTIONED in scripts/brand-guard.mjs with the reason.");
    process.exit(1);
  }
  console.log(`✓ brand: ${scanned} files, no hand-drawn logo, no colour outside the styles.css tokens (bar the sanctioned print palettes and baseline), type is Inter (${tokens} tokens)`);
}
