import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { BRAND_SANCTIONED, isBrandSanctioned, runBrandGuard, scanSource, stripComments, tokenHexes } from "../../../scripts/brand-guard.mjs";

/**
 * `check:brand` (docs/BRAND.md as a gate): the real logo only, colours are styles.css tokens, type is Inter. This pins what the guard refuses, what it lets
 * through, every exception with its reason - and that the repository passes it, so the brand cannot quietly regress.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");

type Hit = { rule: string; line: number; message: string };
const TOKENS = tokenHexes(":root{--emerald:#0BA75E;--card:#FFFFFF;--t1:#0B1B2B;--danger:#FF5C48}");
const scan = (source: string, rel = "apps/console/app/Example.tsx"): Hit[] => scanSource(rel, source, TOKENS);
const rules = (source: string, rel?: string) => scan(source, rel).map((hit) => hit.rule);

/** The mosaic tree, hand-vectored: a circle badge with rounded foliage tiles. The repeat offender. */
const HAND_DRAWN_TREE = `
<svg viewBox="0 0 100 100" aria-hidden="true">
  <circle cx="50" cy="50" r="48" fill="none" stroke="orange" />
  <rect x="30" y="20" width="10" height="10" rx="2" fill="lime" />
  <rect x="42" y="18" width="10" height="10" rx="2" fill="green" />
  <rect x="54" y="22" width="10" height="10" rx="2" fill="orange" />
  <rect x="38" y="32" width="10" height="10" rx="2" fill="lime" />
</svg>`;

describe("the brand guard", () => {
  it("refuses a hand-drawn logo: the mosaic tree, or the wordmark set in an svg", () => {
    assert.deepEqual(rules(HAND_DRAWN_TREE), ["logo"]);
    assert.equal(scan(HAND_DRAWN_TREE)[0]?.line, 2, "names the line of the <svg>");
    assert.deepEqual(rules('<svg width="120"><text x="0" y="20">net zero.</text><text y="40">international</text></svg>'), ["logo"]);
    assert.deepEqual(rules('<svg role="img" aria-label="NZI logo"><path d="M0 0h10v10z" /></svg>'), ["logo"]);
    // Foliage tiles alone, with no badge and no words, are still a mosaic once there are enough of them.
    const tiles = Array.from({ length: 5 }, (_, i) => `<rect x="${i * 12}" y="0" width="10" height="10" rx="2" />`).join("");
    assert.deepEqual(rules(`<svg>${tiles}</svg>`), ["logo"]);
    // ...and a drawn mark in a CSS data URI, or a template string, is found the same way.
    assert.deepEqual(rules("const mark = `" + HAND_DRAWN_TREE + "`;"), ["logo"]);
  });

  it("lets the real asset through: the files, the brand components, and a client's own uploaded logo", () => {
    for (const line of [
      '<img src="/brand/netzero-logo.webp" alt="net zero. international" />',
      '<img src="/brand/netzero-logo.png" alt="" width={1428} height={600} />',
      '<source srcSet="/brand/netzero-logo-big-tree.webp" type="image/webp" />',
      "<NziLogo className=\"nz-brand-logo\" />",
      "<NziMark />",
      "const src = `/api/isolated/clients/${id}/logo?v=${asset}`;",
      "<img className=\"r5-nzilogo\" src={issuerLogoSrc(issuer.logoAssetId)} alt={issuer.displayName} />",
      "<LogoMark src={client.logoSrc} name={client.name} />",
    ]) assert.deepEqual(rules(line), [], line);
  });

  it("refuses a logo or tree image that is not the approved asset", () => {
    for (const line of ['<img src="/images/logo.png" alt="" />', '<img src="/tree.svg" />', '.x{background:url("/assets/netzero-tree.png")}', '<img src="/brand/netzero-logo-old.png" />'])
      assert.deepEqual(rules(line, line.startsWith(".x") ? "apps/console/app/x.css" : undefined), ["logo"], line);
  });

  it("does not mistake an ordinary icon or chart for the mark", () => {
    assert.deepEqual(rules('<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" /></svg>'), []);
    assert.deepEqual(rules('<svg><rect rx="3" width="4" height="9" /><rect rx="3" x="6" width="4" height="5" /></svg>'), [], "two rounded bars");
    assert.deepEqual(rules('<svg><title>Emissions by scope</title><circle r="4" /><rect width="3" height="3" /></svg>'), []);
  });

  it("refuses a raw off-token hex in a component, and passes a token", () => {
    assert.deepEqual(rules('<div style={{ color: "#123456" }} />'), ["colour"]);
    assert.equal(scan('<div style={{ color: "#123456" }} />')[0]?.message.startsWith("#123456"), true);
    assert.deepEqual(rules(".x{border:1px solid #ABCDEF}", "apps/console/app/x.css"), ["colour"]);
    assert.deepEqual(rules(".x{color:#f0a}", "apps/console/app/x.css"), ["colour"], "3-digit form");
    assert.deepEqual(rules(".x{color:#12345678}", "apps/console/app/x.css"), ["colour"], "alpha form");
    for (const line of [
      '<div style={{ color: "var(--emerald)" }} />', ".x{color:var(--t1);background:var(--card)}",
      ".x{color:#0ba75e}", ".x{background:#fff}", ".x{color:#0B1B2B}", // a raw hex that *is* a token passes (lower case, short form)
      '<a href="#add">Add</a>', "<use href=\"#fade\" />", ".x{fill:url(#grad)}",
    ]) assert.deepEqual(rules(line, "apps/console/app/x.css"), [], line);
  });

  it("refuses a non-Inter font-family, and passes Inter and the system stack", () => {
    assert.deepEqual(rules(".x{font-family:Georgia,serif}", "apps/console/app/x.css"), ["font", "font"]);
    assert.deepEqual(rules('.x{font-family:"Comic Sans MS",cursive}', "apps/console/app/x.css"), ["font", "font"]);
    assert.deepEqual(rules('<text fontFamily="Playfair Display" />'), ["font"]);
    assert.deepEqual(rules('<div style={{ fontFamily: "Courier New, monospace" }} />'), ["font"]);
    for (const line of [
      ".x{font-family:Inter,system-ui,-apple-system,\"Segoe UI\",Roboto,sans-serif}", ".x{font-family:var(--font-inter,Inter),system-ui,sans-serif}",
      ".x{font-family:inherit}", ".x{font-family:var(--r5-font)}", ".x{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}",
    ]) assert.deepEqual(rules(line, "apps/console/app/x.css"), [], line);
    assert.deepEqual(rules('<text fontFamily="Inter" fontSize={9} />'), []);
  });

  it("allows the token files, and the charts' print hex, with their reasons", () => {
    assert.deepEqual(rules(".nz-x{background:#FFDE00;color:#123456}", "packages/ui/src/styles.css"), []);
    assert.equal(isBrandSanctioned("packages/charts/src/tokens.ts", "colour", "export const INK = \"#0B1B2B\";"), true);
    assert.equal(isBrandSanctioned("packages/charts/src/index.tsx", "colour", "#123456"), true);
    // The token file's font allowance is the monospace stack only; a new typeface there is still refused.
    assert.deepEqual(rules(".x{font-family:Georgia}", "packages/ui/src/styles.css"), ["font"]);
    assert.equal(isBrandSanctioned("packages/ui/src/styles.css", "logo", ""), false, "no file is exempt from the logo rule");
  });

  it("states every exception with a reason, and exempts nothing from the logo rule", () => {
    for (const entry of BRAND_SANCTIONED as Array<{ why: string; rule: string }>) {
      assert.ok(entry.why.trim().length > 25, entry.why);
      assert.notEqual(entry.rule, "logo", "the logo rule has no allowlist: the real asset is always available");
    }
  });

  it("keeps a baselined file guarded: a new off-token colour in it still fails", () => {
    const portal = "apps/console/app/portal/shell/portal-shell.css";
    assert.deepEqual(rules(".x{color:#0b1622}", portal), [], "an existing baselined colour");
    assert.deepEqual(rules(".x{color:#010203}", portal), ["colour"], "a new one");
    assert.deepEqual(rules(".x{color:#010203}", "apps/console/app/reports/[versionId]/report-composed5.css"), [], "print palettes are exempt as a file");
  });

  it("skips comments, and keeps line numbers true across them", () => {
    assert.deepEqual(rules("// color: #123456\n/* font-family: Georgia */\n{/* #123456 */}\nconst x = 1;"), []);
    assert.deepEqual(rules("// color: #123456\n.x{}", "apps/console/app/x.css"), ["colour"], "// is not a comment in CSS");
    assert.deepEqual(rules("/* a\n   multi-line\n   comment */\n.x{color:#123456}", "apps/console/app/x.css"), ["colour"]);
    assert.equal(scan("/* a\n b */\n<div style={{color:\"#123456\"}} />")[0]?.line, 3);
    assert.equal(stripComments("const u = \"http://x.test/#abcdef\"; // #123456").includes("#123456"), false);
    assert.equal(stripComments("const u = \"http://x.test/a\";").includes("http://x.test/a"), true, "a URL's // is not a comment");
  });

  it("scans the components and skips tests", () => {
    const dir = mkdtempSync(join(tmpdir(), "brand-guard-"));
    try {
      for (const [path, body] of Object.entries({
        "packages/ui/src/styles.css": ":root{--emerald:#0BA75E;--card:#fff;--t1:#0B1B2B;--t2:#51605A;--t3:#616B65;--line:#E4EAE7;--paper:#F6F8F7;--pine:#0B7A4B;--amber:#FFC24B;--coral:#FF5C48}",
        "apps/console/app/Good.tsx": "export const A = () => <b style={{ color: 'var(--emerald)' }} />;",
        "apps/console/app/Bad.tsx": "export const A = () => <b style={{ color: '#123456' }} />;",
        "apps/console/tests/Bad.test.tsx": "const x = '#123456';",
        "apps/console/app/Bad.spec.tsx": "const x = '#123456';",
        "apps/console/tests/e2e-gate/Bad.tsx": "const x = '#123456';",
        "apps/console/public/brand/x.css": ".x{color:#123456}",
      })) { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), body); }
      const { offences, scanned } = runBrandGuard(dir);
      assert.deepEqual(offences.map((offence: { file: string }) => offence.file), ["apps/console/app/Bad.tsx"]);
      assert.equal(scanned, 3, "the stylesheet and the two components; no test, spec or public file");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("is run by CI as check:brand, and the repository passes it", () => {
    const { offences, scanned } = runBrandGuard(repo);
    assert.deepEqual(offences, []);
    assert.ok(scanned > 100, `${scanned} files scanned`);
    const output = execFileSync(process.execPath, ["scripts/brand-guard.mjs"], { cwd: repo, encoding: "utf8" });
    assert.match(output, /^✓ brand:/);
  });
});
