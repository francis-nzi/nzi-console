import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {describe,it} from "node:test";

const root=process.cwd();
const read=(path:string)=>readFileSync(join(root,path),"utf8");
const routes=["apps/console/app/clients/page.tsx","apps/console/app/clients/[clientId]/page.tsx","apps/console/app/jobs/page.tsx","apps/console/app/jobs/[jobId]/page.tsx","apps/console/app/datasets/page.tsx","apps/console/app/reports/page.tsx","apps/console/app/reports/[versionId]/page.tsx","apps/console/app/platform/page.tsx"];

// The client page renders through these; they carry its empty states and must not reach for stand-in data.
const clientWorkspace=["apps/console/app/clients/[clientId]/ClientWorkspaceView.tsx","apps/console/app/clients/[clientId]/ClientSites.tsx","apps/console/app/clients/[clientId]/FigureEvidence.tsx","apps/console/app/clients/[clientId]/ClientFinancials.tsx"];

describe("staff workspace acceptance contracts",()=>{
  it("renders each client from its own resolved figures, sites and ledger — no shared mock records (NZC-005/069/070)",()=>{for(const file of ["apps/console/app/clients/[clientId]/page.tsx",...clientWorkspace]){const source=read(file);assert.doesNotMatch(source,/import\s*(type\s*)?\{[^}]*\b(clientFigureEvidence|clientSites|documentHistory|financials|FinancialsReadModel|CommercialDocument)\b[^}]*\}\s*from\s*"@nzi\/mock-data"/,file)}});
  it("never hard-codes a Xero connection — the status is derived (NZC-069)",()=>{const source=read("packages/isolated-backend/src/readModels.ts");assert.doesNotMatch(source,/xeroStatus:\s*\{\s*state:\s*"connected"\s*,/);assert.match(source,/if \(!integration\.configured\) return \{ state: "not_configured", label: "Not connected" \}/)});
  it("keeps every canonical staff workspace free of mock record fallbacks",()=>{for(const route of routes){const source=read(route);assert.doesNotMatch(source,/loadFixtureScreen|fixtureClients|fixtureJobs|reportVersions|reportTemplates|platformServices|staffRoles|datasetAuditIssues/ ,route)}});
  it("loads live staff resources through the isolated boundary",()=>{for(const route of routes){const source=read(route);if(route.endsWith("reports/page.tsx"))continue;assert.match(source,/loadScreen|LiveReportRegister/,route)}});
  it("protects governance reads with staff identity and tenant context",()=>{for(const route of ["datasets","platform-governance","audit-events","report-versions"]){const source=read(`apps/console/app/api/isolated/${route}/route.ts`);assert.match(source,/currentStaff\(request\)/,route);assert.match(source,/withTenantRead/,route);assert.match(source,/private, no-store/,route)}});
  it("returns every collection required by the platform screen contract",()=>{const source=read("apps/console/app/api/isolated/platform-governance/route.ts");for(const token of ["listStaffRoleGovernance","listAuditEvents","roles,services,events"])assert.ok(source.includes(token),token)});
  it("provides shared keyboard focus, skip navigation, reduced motion and responsive breakpoints",()=>{const shell=read("packages/ui/src/index.tsx"),styles=read("packages/ui/src/styles.css");assert.match(shell,/className="nz-skip-link"/);assert.match(shell,/id="nzi-main-content"/);for(const token of ["a:focus-visible","button:focus-visible",'[role="tab"]:focus-visible',"prefers-reduced-motion:reduce","max-width:1200px","max-width:900px","max-width:680px","max-width:420px"])assert.ok(styles.includes(token),token)});
  it("exposes honest empty and failure states instead of inferred records",()=>{const combined=[...routes,"apps/console/app/datasets/DatasetBoard.tsx",...clientWorkspace].map(read).join("\n");for(const token of ["No engagements","No sites configured","No governed factor datasets","Live report version unavailable"])assert.ok(combined.includes(token),token)});
});
