// BRIEF-client-custom-factors PR B in the console (GAPS G1/G2/G3/G6): the manager sets a factor's values by year, holds the value box
// of a factor priced by year, runs every per-factor act through the factor's own route (a client's or the organisation's), and makes
// factors on the client page, the Clients page's Organisation factors tab and an LCA job. The commands are proved in
// isolated-backend's clientFactorsManageReal.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const source = (path: string) => readFileSync(resolve(here, "..", path), "utf8");

describe("client factors, fully manageable", () => {
  const manager = source("app/clients/ClientFactorsManager.tsx");

  it("G2: a Years expander sets the whole set through the factor's years route, and says a priced row keeps its figure", () => {
    assert.match(manager, /aria-expanded=\{showYears\} onClick=\{\(\) => showYears \? setYears\(null\) : openYears\(factor\)\}>Years<\/button>/);
    assert.match(manager, /postBrowserCommand<\{ version: number; years: number\[\] \}>\(`\$\{factorUrl\(factor\.clientFactorId\)\}\/years`, \{ expectedVersion: factor\.version, values \}/);
    assert.match(manager, /Rows already priced keep their figures until re-priced\./);
  });

  it("G1: a factor priced by year has its value box held, pointing to Years", () => {
    assert.match(manager, /isEditing && !byYear\(factor\) \? <input className="nz-inp" type="number" min="0" step="any" aria-label="kgCO2e per unit"/);
    assert.match(manager, /aria-label="kgCO2e per unit" value=\{draft\.kgco2ePerUnit\} disabled \/>.*Priced by year · <button type="button" className="nz-editlink" onClick=\{\(\) => openYears\(factor\)\}>change in Years<\/button>/s);
  });

  it("G3: every per-factor act goes through the factor's own route; the organisation's list is its own", () => {
    assert.match(manager, /const factorUrl = \(id: string\) => `\/api\/isolated\/client-factors\/\$\{id\}`;/);
    assert.match(manager, /const listUrl = organisation \? "\/api\/isolated\/client-factors" : `\/api\/isolated\/clients\/\$\{clientId\}\/client-factors`;/);
    const board = source("app/clients/ClientsBoard.tsx");
    assert.match(board, /\{ id: "organisation-factors", label: "Organisation factors" \}/);
    assert.match(board, /<ClientFactorsManager organisation \/>/);
  });

  it("G6: made on the client page, on the Organisation factors tab, on a CRP job and on an LCA job — one form", () => {
    assert.match(manager, /endpoint=\{organisation \? "\/api\/isolated\/client-factors" : `\/api\/isolated\/clients\/\$\{clientId\}\/client-factors`\} reusableChoice=\{false\}/);
    assert.match(source("app/jobs/ClientFactorPanel.tsx"), /<ClientFactorCreateForm endpoint=\{`\/api\/isolated\/jobs\/\$\{jobId\}\/client-factors`\} reusableChoice/);
    assert.match(source("app/jobs/lca/LcaWorkspace.tsx"), /<ClientFactorCreateForm endpoint=\{`\/api\/isolated\/jobs\/\$\{header\.id\}\/client-factors`\} reusableChoice/);
    for (const route of ["app/api/isolated/client-factors/route.ts", "app/api/isolated/clients/[clientId]/client-factors/route.ts", "app/api/isolated/jobs/[jobId]/client-factors/route.ts"]) {
      assert.match(source(route), /requireCommandPrincipal\(request, ?"client\.factor\.create"\)/, route);
    }
  });
});
