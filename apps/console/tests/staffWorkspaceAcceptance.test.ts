import assert from "node:assert/strict";
import {existsSync, readFileSync} from "node:fs";
import {describe,it} from "node:test";

// Resolved from this file, not the shell's cwd — the suite has to pass whether it is run
// from the repo root or from the package (which is how `npm test -w @nzi/console` runs it).
const read=(path:string)=>readFileSync(new URL(`../../../${path}`,import.meta.url),"utf8");
const exists=(path:string)=>existsSync(new URL(`../../../${path}`,import.meta.url));
const routes=["apps/console/app/clients/page.tsx","apps/console/app/clients/[clientId]/page.tsx","apps/console/app/jobs/page.tsx","apps/console/app/jobs/[jobId]/page.tsx","apps/console/app/datasets/page.tsx","apps/console/app/reports/page.tsx","apps/console/app/reports/[versionId]/page.tsx","apps/console/app/platform/page.tsx"];

// The client page renders through these; they carry its empty states and must not reach for stand-in data.
const clientWorkspace=["apps/console/app/clients/[clientId]/ClientWorkspaceView.tsx","apps/console/app/clients/[clientId]/ClientSites.tsx","apps/console/app/clients/[clientId]/FigureEvidence.tsx","apps/console/app/clients/[clientId]/ClientContacts.tsx","apps/console/app/clients/[clientId]/ClientIdentity.tsx","apps/console/app/clients/[clientId]/ClientTargets.tsx","apps/console/app/clients/[clientId]/ClientPathway.tsx","apps/console/app/clients/[clientId]/OverviewArea.tsx","apps/console/app/clients/[clientId]/AnalyticsArea.tsx","apps/console/app/clients/[clientId]/ClientAreaStates.tsx","apps/console/app/clients/[clientId]/ClientRecordDrawers.tsx"];

describe("staff workspace acceptance contracts",()=>{
  it("renders the client workspace as the v10 shell: rail, client area sub-nav, content, drawer",()=>{
    const shell=read("apps/console/app/clients/[clientId]/ClientWorkspaceView.tsx");
    assert.ok(shell.includes("<ClientWorkspaceNav"),"the client area sub-nav");
    assert.ok(shell.includes("areas={"),"the nav sits in the shell's own column");
    assert.ok(shell.includes("<EvidenceDrawer"),"the evidence drawer keeps the shell slot");
    const areas=read("apps/console/app/clients/[clientId]/clientAreas.ts");
    for(const area of ["overview","analytics","reporting","actions","srs","tasks","notes","files","comms","profile","financials","ai"])assert.ok(areas.includes(`"${area}"`),area);
    for(const group of ["Client","Manage","Record"])assert.ok(areas.includes(`label: "${group}"`),group);
  });
  it("hosts every record drawer in one place — no card owns a drawer, and there is no separate edit page",()=>{
    const shell=read("apps/console/app/clients/[clientId]/ClientWorkspaceView.tsx");
    for(const kind of ["identity","targets","rebaseline","address","compliance","factors","portal","contact","site"])assert.ok(shell.includes(`drawer?.kind === "${kind}"`),kind);
    for(const card of ["ClientContacts.tsx","ClientSites.tsx","ClientTargets.tsx","ClientIdentity.tsx"]){
      assert.doesNotMatch(read(`apps/console/app/clients/[clientId]/${card}`),/<Drawer\b/,`${card} still owns a drawer`);
    }
    assert.ok(!exists("apps/console/app/clients/[clientId]/edit/page.tsx"),"the /edit route is gone");
    assert.doesNotMatch(read("apps/console/app/clients/[clientId]/ClientWorkspaceView.tsx"),/\/edit/,"nothing links to the retired edit page");
  });
  it("tells the truth about areas that are not built, and holds the commercial ledger",()=>{
    const states=read("apps/console/app/clients/[clientId]/ClientAreaStates.tsx");
    assert.ok(states.includes("Not available yet"),"unavailable areas say so");
    assert.match(states,/NZC-069/,"financials names the held decision");
    assert.doesNotMatch(states,/£[0-9]|outstanding balance of|invoice #/i,"no invented ledger figures");
  });
  it("derives the analytics series from the client's own assured years",()=>{
    const analytics=read("apps/console/app/clients/[clientId]/AnalyticsArea.tsx");
    for(const token of ["history","EmissionsScopeDonut","ScopeYearOnYearBar","ClientPathway","Reporting year"])assert.ok(analytics.includes(token),token);
    assert.doesNotMatch(analytics,/\bconst (actual|series|values)\s*=\s*\[\s*\d/,"no seeded series");
  });
  it("offers intensity on every basis the client's own data supports, and says why one is missing (client workspace v10)",()=>{
    const analytics=read("apps/console/app/clients/[clientId]/AnalyticsArea.tsx");
    for(const token of ["Intensity basis","per £M revenue","per employee (FTE)","per m² floor area","All bases (indexed)","IntensityBasesIndexed","Intensity detail"])assert.ok(analytics.includes(token),token);
    // A basis without a denominator reads unavailable with its reason — never borrowed from another basis.
    assert.ok(analytics.includes("BasisReasons"),"the unavailable reason is surfaced");
    assert.doesNotMatch(analytics,/reportingDenominator\s*\?\?\s*\d/,"no fallback denominator");
  });
  it("keeps the client record edited one thing at a time — no omnibus Edit client button",()=>{
    const shell=read("apps/console/app/clients/[clientId]/ClientWorkspaceView.tsx");
    assert.doesNotMatch(shell,/>Edit client</,"the omnibus edit button is gone");
  });
  it("edits the forward targets in the drawer, gated on target.edit, with the benchmark read-only (client workspace v10)",()=>{
    const source=read("apps/console/app/clients/[clientId]/ClientTargets.tsx");
    for(const token of ["Reduction targets","Near-term target","Net-zero target","Per-scope targets","Benchmark year","Read from the baseline in force","No targets set","Save targets","/targets"])assert.ok(source.includes(token),token);
    assert.ok(read("apps/console/app/clients/[clientId]/ClientWorkspaceView.tsx").includes('useEditAccess("target.edit"'),"target.edit");
    // The benchmark is never typed here — it is shown disabled and read from the baseline.
    assert.match(source,/value=\{`FY\$\{benchmark\.year\}[^`]*`\} disabled readOnly/);
  });
  it("draws the pathway from the target model rather than fixed points (client workspace v10)",()=>{
    const source=read("apps/console/app/clients/[clientId]/ClientPathway.tsx");
    assert.ok(source.includes("targets.trajectory.map"),"the target line comes from the model");
    assert.ok(source.includes("actuals.map"),"actual comes from the assured years");
    assert.doesNotMatch(source,/target:\s*\[\s*\{\s*year:\s*\d{4}/,"no hard-coded target points");
    assert.ok(source.includes("targets.latestGap"),"the gap shown is the one the engine measured");
  });
  it("gates each client-workspace control on the capability its command enforces (NZC-022)",()=>{const view=read("apps/console/app/clients/[clientId]/ClientWorkspaceView.tsx");for(const capability of ["site.manage","contact.manage","client.edit"])assert.ok(view.includes(`useEditAccess(\"${capability}\"`),capability);assert.doesNotMatch(read("apps/console/app/lib/useEditAccess.ts"),/permissions?.includes/);});
  it("shows contact role badges and the v9 role checkboxes, removing by deactivation (client workspace v9)",()=>{const source=read("apps/console/app/clients/[clientId]/ClientContacts.tsx");for(const token of ["nz-rolebadges","nz-tag rr","Primary","nz-rolechk","Primary contact","/deactivate","Save contact","Signee appears on published reports"])assert.ok(source.includes(token),token);});
  it("edits the financial year end as a month and uploads the logo with a monogram fallback (client workspace v9)",()=>{const source=read("apps/console/app/clients/[clientId]/ClientIdentity.tsx");for(const token of ["Financial year end","MONTHS.map","300–400 day rule","⭱ Upload logo","clientLogoContentTypes","monogram(client.name)","onError"])assert.ok(source.includes(token),token);assert.ok(read("apps/console/app/lib/LogoMark.tsx").includes("monogramOf(name)"));for(const surface of ["apps/console/app/portal/PortalHome.tsx","apps/console/app/reports/[versionId]/page.tsx","apps/console/app/portal/jobs/[jobId]/print/page.tsx"])assert.ok(read(surface).includes("<LogoMark"),surface);});
  it("renders each client from its own resolved figures and sites — no shared mock evidence or sites (NZC-005/070)",()=>{
    for(const file of ["apps/console/app/clients/[clientId]/page.tsx",...clientWorkspace]){
      const source=read(file);
      // Only presentation helpers may come from the mock package — never a figure, site, ledger or contact fixture.
      const mockImport=/import\s*\{([^}]*)\}\s*from\s*"@nzi\/mock-data"/.exec(source)?.[1]??"";
      assert.doesNotMatch(mockImport,/clientFigureEvidence|clientSites|documentHistory|financials|clients\b|jobs\b|contacts/,`${file} imports fixture data`);
      assert.doesNotMatch(source,/clientFigureEvidence|documentHistory/,file);
    }
  });
  it("keeps every canonical staff workspace free of mock record fallbacks",()=>{for(const route of routes){const source=read(route);assert.doesNotMatch(source,/loadFixtureScreen|fixtureClients|fixtureJobs|reportVersions|reportTemplates|platformServices|staffRoles|datasetAuditIssues/ ,route)}});
  it("loads live staff resources through the isolated boundary",()=>{for(const route of routes){const source=read(route);if(route.endsWith("reports/page.tsx"))continue;assert.match(source,/loadScreen|LiveReportRegister/,route)}});
  it("protects governance reads with staff identity and tenant context",()=>{for(const route of ["datasets","platform-governance","audit-events","report-versions"]){const source=read(`apps/console/app/api/isolated/${route}/route.ts`);assert.match(source,/currentStaff\(request\)/,route);assert.match(source,/withTenantRead/,route);assert.match(source,/private, no-store/,route)}});
  it("returns every collection required by the platform screen contract",()=>{const source=read("apps/console/app/api/isolated/platform-governance/route.ts");for(const token of ["listStaffRoleGovernance","auditEventsFor","roles,services,events"])assert.ok(source.includes(token),token)});
  it("provides shared keyboard focus, skip navigation, reduced motion and responsive breakpoints",()=>{const shell=read("packages/ui/src/index.tsx"),styles=read("packages/ui/src/styles.css");assert.match(shell,/className="nz-skip-link"/);assert.match(shell,/id="nzi-main-content"/);for(const token of ["a:focus-visible","button:focus-visible",'[role="tab"]:focus-visible',"prefers-reduced-motion:reduce","max-width:1200px","max-width:900px","max-width:680px","max-width:420px"])assert.ok(styles.includes(token),token)});
  it("exposes honest empty and failure states instead of inferred records",()=>{const combined=[...routes,"apps/console/app/datasets/DatasetBoard.tsx",...clientWorkspace].map(read).join("\n");for(const token of ["No engagements","No sites configured","No governed factor datasets","Live report version unavailable"])assert.ok(combined.includes(token),token)});
});
