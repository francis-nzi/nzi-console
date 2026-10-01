import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { organisationCopy } from "../app/lib/organisationName";

/**
 * D3b (ruled) — the organisation is named from its profile, never typed into client-facing copy. This fails if
 * "Net Zero International" or a bare "NZI" reappears outside the allow-list:
 *  - the portal terms (legal text, ruled unchanged), which are not scanned;
 *  - in `portal-preview/PortalWorkspace.tsx` — scanned by name, because the client job page renders it (Q3, ruled in) —
 *    only the hard-coded sample conversation, `function Messages()`;
 *  - identifiers: the `NZI-` verify-code prefix and `NZI_` environment names;
 *  - comments, and the product name "NZ Insights Pro" (which the pattern never matches).
 */
const repo = join(__dirname, "..", "..", "..");
const app = join(__dirname, "..", "app");

/** Every surface a client, trainee or certificate holder reads — and the issued report, and its staff review thread. */
const CLIENT_FACING_ROOTS = ["portal", "trainee", "verify", "api/portal", "api/trainee", "reports"].map((root) => join(app, root));
/** Copy built outside the console that reaches a client: readiness, the trainee record, invitations, reminder emails. */
const CLIENT_FACING_FILES = [
  // The client job page (`portal/jobs/[jobId]`) renders this component, so it is client-facing wherever it lives.
  "apps/console/app/portal-preview/PortalWorkspace.tsx",
  "packages/isolated-backend/src/portalReadiness.ts",
  "packages/isolated-backend/src/traineePortal.ts",
  "packages/isolated-backend/src/traineeAuth.ts",
  "packages/contracts/src/strategyReminders.ts",
].map((file) => join(repo, file));
const ALLOW_LISTED = new Set([join(app, "portal", "portalTermsContent.ts")]);
/** Lines allowed by file: the sample conversation in the preview's `Messages()`, ruled left as it is. */
const ALLOWED_LINES: Record<string, RegExp> = { [join(app, "portal-preview", "PortalWorkspace.tsx")]: /^function Messages\(\)\{/ };

function sourcesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourcesUnder(path);
    return /\.(ts|tsx)$/.test(name) && !ALLOW_LISTED.has(path) ? [path] : [];
  });
}

/** The code with its comments removed — block, JSX `{/* … *\/}` and line comments (not the `//` inside a URL). */
const withoutComments = (source: string) => source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

const HARD_CODED = [
  { name: "Net Zero International", pattern: /Net Zero International/ },
  { name: "a bare NZI", pattern: /\bNZI\b(?![-_])/ },
];

describe("client-facing copy names the organisation from its profile (D3b)", () => {
  const files = [...CLIENT_FACING_ROOTS.flatMap(sourcesUnder), ...CLIENT_FACING_FILES];

  it("scans the surfaces it claims to", () => {
    const scanned = new Set(files.map((file) => relative(repo, file).split(sep).join("/")));
    for (const expected of [
      "apps/console/app/portal/PortalHome.tsx",
      "apps/console/app/portal/PortalSpendEntry.tsx",
      "apps/console/app/trainee/TraineeWorkspace.tsx",
      "apps/console/app/portal-preview/PortalWorkspace.tsx",
      "apps/console/app/verify/[verifyCode]/page.tsx",
      "apps/console/app/api/trainee/export/route.ts",
      "apps/console/app/reports/[versionId]/ReportComposedView.tsx",
      "apps/console/app/reports/[versionId]/reportPrintRules.ts",
      "packages/contracts/src/strategyReminders.ts",
    ]) assert.ok(scanned.has(expected), `${expected} is scanned`);
    assert.ok(!scanned.has("apps/console/app/portal/portalTermsContent.ts"), "the portal terms are allow-listed (legal text)");
  });

  for (const { name, pattern } of HARD_CODED) {
    it(`never hard-codes ${name}`, () => {
      const offenders = files.flatMap((file) => withoutComments(readFileSync(file, "utf8")).split("\n")
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => pattern.test(line) && !ALLOWED_LINES[file]?.test(line))
        .map(({ line, index }) => `${relative(repo, file)}:${index + 1}: ${line.trim().slice(0, 120)}`));
      assert.deepEqual(offenders, [], `name the organisation through organisationCopy() / the frozen issuer instead:\n${offenders.join("\n")}`);
    });
  }

  it("still allows the identifiers and the product name", () => {
    for (const allowed of ["begins <code>NZI-</code>", "process.env.NZI_DEMO_ORGANISATION_ID", "NZ Insights Pro"]) {
      assert.ok(HARD_CODED.every(({ pattern }) => !pattern.test(withoutComments(allowed))), allowed);
    }
    assert.ok(HARD_CODED.some(({ pattern }) => pattern.test("Submitted to NZI for review")), "the guard catches the copy it is for");
  });
});

describe("organisationCopy — the one place a sentence names the organisation", () => {
  it("uses the short name, and the display name for a footer", () => {
    const org = organisationCopy({ displayName: "Acme Carbon Ltd", shortName: "Acme" });
    assert.equal(org.short, "Acme");
    assert.equal(org.your("consultant"), "your Acme consultant");
    assert.equal(org.Your("team"), "Your Acme team");
    assert.equal(org.your("adviser", "named"), "your named Acme adviser");
    assert.equal(org.display, "Acme Carbon Ltd");
  });

  it("reads without a name, rather than inventing one, when the profile is unavailable", () => {
    const org = organisationCopy(null);
    assert.equal(org.your("consultant"), "your consultant");
    assert.equal(org.Your("team"), "Your team");
    assert.equal(org.your("adviser", "named"), "your named adviser");
    assert.equal(org.short, "your adviser");
    assert.equal(org.display, null, "the footer omits the name rather than guessing it");
  });
});

describe("every surface that names the organisation has it to hand", () => {
  const read = (path: string) => readFileSync(join(app, path), "utf8");

  it("serves the names to the portal, trainee portal, staff preview and review thread", () => {
    for (const path of ["portal/layout.tsx", "trainee/layout.tsx", "portal-preview/page.tsx", "reports/page.tsx"]) {
      assert.match(read(path), /<WithOrganisationName>/, path);
    }
  });

  it("reads the live profile per request, never at build time", () => {
    const brand = read("lib/organisationBrand.tsx");
    assert.match(brand, /await connection\(\)/);
    assert.match(brand, /readOrganisationBrand/);
    assert.doesNotMatch(brand, /readOrganisationBank|accountNumber|sortCode/, "names only — never the bank details");
  });

  it("names an issued document from what it froze, not the live profile", () => {
    assert.match(read("reports/[versionId]/ReportComposedView.tsx"), /composition\.issuer/);
    assert.match(read("reports/[versionId]/page.tsx"), /issuerFooter:version\.issuer\?\.footer/);
    assert.match(read("portal/jobs/[jobId]/print/page.tsx"), /report\.issuer\.shortName/);
    assert.match(read("api/portal/jobs/[jobId]/deliverables/[kind]/route.ts"), /result\.report\.issuer\?\.displayName/);
    assert.match(read("verify/[verifyCode]/page.tsx"), /held by \{result\.issuer\}/);
  });
});
