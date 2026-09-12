import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const area = (name: string) => read(`apps/console/app/clients/[clientId]/${name}`);

/**
 * Client workspace phase 2. The rule these tests hold: an area is "built" only when it has
 * real records behind it. Where a store does not exist, the area says so — it never renders
 * an empty list that reads like "this client has nothing".
 */
describe("client workspace phase 2 areas", () => {
  it("marks as built only the areas that have a record behind them", () => {
    const areas = area("clientAreas.ts");
    for (const built of ["overview", "analytics", "reporting", "profile", "comms", "files", "ai"]) {
      assert.match(areas, new RegExp(`"${built}"`), built);
    }
    const builtSet = /BUILT_AREAS[^=]*=[\s\S]*?\]\)/.exec(areas)?.[0] ?? "";
    for (const notBuilt of ["tasks", "notes", "srs", "financials"]) {
      assert.ok(!builtSet.includes(`"${notBuilt}"`), `${notBuilt} must not be marked built`);
    }
  });

  it("holds SRS Readiness back deliberately rather than building it to a superseded design", () => {
    const states = area("ClientAreaStates.tsx");
    assert.match(states, /srs:[\s\S]*?redesign/, "the SRS state names the redesign");
    assert.doesNotMatch(states, /srs:[^}]*next phase of this rebuild/, "it no longer claims this phase will build it");
  });

  it("says plainly that tasks and notes have no store, rather than showing an empty list", () => {
    const states = area("ClientAreaStates.tsx");
    assert.match(states, /tasks:[\s\S]*?no tasks table, route or command/);
    assert.match(states, /notes:[\s\S]*?never against the client itself/);
  });

  it("lists the client's own report versions, resolved from its jobs", () => {
    const reporting = area("ReportingArea.tsx");
    assert.match(reporting, /workspace\.reports|\{ reports \}/, "reads the resolved report list");
    for (const token of ["Published", "Validated", "Draft", "Superseded", "Open report →"]) assert.ok(reporting.includes(token), token);
    assert.match(reporting, /No report version has been created for this client yet/, "an honest empty state");
    assert.doesNotMatch(reporting, /\b(3|5|12) reports\b/, "no seeded counts");
    // NZC-066: the provenance stamp is context, never a retrieval gate.
    assert.match(reporting, /stay retrievable whatever its provenance stamp/);
  });

  it("shows the company record and sends every edit to the drawer that already owns it", () => {
    const profile = area("ProfileArea.tsx");
    for (const field of ["Financial year end", "Reporting frameworks", "Certifications", "Primary Scope 3 categories", "Registered", "Billing"]) {
      assert.ok(profile.includes(field), field);
    }
    for (const drawer of ["identity", "compliance", "address", "factors", "portal", "contact"]) {
      assert.match(profile, new RegExp(`kind: "${drawer}"`), drawer);
    }
    // One editor per thing: the area reads the record, it does not grow its own form.
    assert.doesNotMatch(profile, /<input|<textarea|putBrowserCommand/, "no second editor for the same fields");
    assert.match(profile, /GatedButton/, "editing is permission-gated");
  });

  it("scopes communications to what the platform actually records, and says what it does not", () => {
    const comms = area("CommsFilesAreas.tsx");
    assert.match(comms, /workspace\.messages|\{ messages \}/);
    assert.match(comms, /Email and calls are not recorded by this platform/, "it does not imply a full inbox");
    assert.match(comms, /No review message has been exchanged/, "an honest empty state");
  });

  it("shows only files that genuinely exist, and where the bytes are", () => {
    const files = area("CommsFilesAreas.tsx");
    assert.match(files, /no general document store yet/);
    assert.match(files, /This platform|External provider/, "it says where each file lives");
    assert.match(files, /keeps the reference and its hash, not the bytes/);
  });

  it("grounds the AI profile in recorded facts and generates nothing", () => {
    const ai = area("AiProfileArea.tsx");
    assert.match(ai, /No model integration exists in this platform/);
    assert.match(ai, /grounding inputs on record/);
    // The give-away of a faked advisory screen would be prose presented as insight.
    assert.doesNotMatch(ai, /recommend|we suggest|insight:/i, "no fabricated advice");
  });

  it("reads every area from one resolved workspace model — no area fetches its own truth", () => {
    for (const file of ["ReportingArea.tsx", "ProfileArea.tsx", "CommsFilesAreas.tsx", "AiProfileArea.tsx"]) {
      const source = area(file);
      assert.match(source, /ClientWorkspaceReadModel/, `${file} takes the workspace model`);
      assert.doesNotMatch(source, /fetch\(|loadScreen/, `${file} must not fetch its own data`);
      assert.doesNotMatch(source, /@nzi\/mock-data/, `${file} must not reach for mock data`);
    }
  });

  it("projects the new areas from the client's own records in the backend", () => {
    const records = read("packages/isolated-backend/src/clientAreaRecords.ts");
    assert.match(records, /FROM nzi_console\.report_versions[\s\S]*?WHERE j\.client_id=\$1/, "reports are scoped to the client");
    assert.match(records, /FROM nzi_console\.portal_report_comments[\s\S]*?WHERE m\.client_id=\$1/, "messages are scoped to the client");
    assert.match(records, /client_logo_assets[\s\S]*?WHERE client_id=\$1/, "files are scoped to the client");
    assert.doesNotMatch(records, /INSERT|UPDATE |DELETE /, "these projections are read-only");
  });
});
