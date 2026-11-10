import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { srsByFramework, srsCodeFrameworkKey, srsRequirementCode } from "@nzi/contracts";

/**
 * BRIEF-srs-framework-rework, Phase A: "Standard" reads "Framework" on every SRS surface, and the reference fix — the
 * framework is named once, as the group, then the bare pillar code, with Strategy never a lone "S" that reads as S1/S2.
 * Display only: the stored codes and the S1/S2 rows are unchanged, so the two frameworks are the two seeded standards.
 */
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const area = read("app/clients/[clientId]/SrsArea.tsx");
const forms = read("app/clients/[clientId]/SrsAssessmentForms.tsx");
const bridge = read("app/clients/[clientId]/SrsBridgeForm.tsx");
const portal = read("app/portal/PortalReadiness.tsx");
const admin = read("app/admin/srs-framework/SrsFrameworkBoard.tsx");
const seed = read("../../packages/isolated-backend/migrations/0070_srs_readiness.sql");

describe("the reference, as a person reads it", () => {
  it("drops the framework prefix and spells Strategy Str", () => {
    assert.deepEqual(["S2 G1", "S2 S1", "S2 R3", "S2 M7", "S1 S4", "S1 G2"].map(srsRequirementCode), ["G1", "Str1", "R3", "M7", "Str4", "G2"]);
    assert.equal(srsRequirementCode("S1"), "Str1", "a code already bare still never reads as a lone S");
    for (const odd of ["", "Custom-9", "S2 GOV1", "s2 g1"]) assert.equal(srsRequirementCode(odd), odd, `${odd} is shown as stored`);
  });

  it("reads a stored code's framework, for a surface that holds only the code", () => {
    assert.deepEqual(["S2 G1", "S1 M3", "G1", ""].map(srsCodeFrameworkKey), ["S2", "S1", null, null]);
  });

  it("groups by framework in the frameworks' order, each once, and keeps an unlisted one in a last unlabelled group", () => {
    const frameworks = [{ key: "S2", label: "UK SRS S2 — Climate" }, { key: "S1", label: "UK SRS S1 — General" }];
    const groups = srsByFramework(["S1 G1", "S2 G1", "X 1", "S2 G2"], srsCodeFrameworkKey, frameworks);
    assert.deepEqual(groups.map((group) => [group.label, group.rows]), [["UK SRS S2 — Climate", ["S2 G1", "S2 G2"]], ["UK SRS S1 — General", ["S1 G1"]], [null, ["X 1"]]]);
    assert.deepEqual(srsByFramework([], srsCodeFrameworkKey, frameworks), [], "no empty group is drawn");
  });
});

describe("the two frameworks are the seeded S1/S2, every requirement intact", () => {
  const frameworks = [...seed.matchAll(/\('(S\d)', '(UK SRS S\d — \w+)'/g)].map((match) => ({ key: match[1]!, label: match[2]! }));
  const rows = [...seed.matchAll(/\('(s\d-[a-z]\d+)','(S\d)','([a-z]+)','(S\d [A-Z]\d+)'/g)].map((match) => ({ id: match[1]!, framework: match[2]!, pillar: match[3]!, code: match[4]! }));

  it("seeds UK SRS S2 — Climate and UK SRS S1 — General", () => {
    assert.deepEqual(frameworks, [{ key: "S2", label: "UK SRS S2 — Climate" }, { key: "S1", label: "UK SRS S1 — General" }]);
  });

  it("gives every requirement a bare code that is unique within its framework, Strategy as Str", () => {
    assert.ok(rows.length >= 40, `${rows.length} requirements read from the seed`);
    for (const row of rows) assert.equal(srsCodeFrameworkKey(row.code), row.framework, `${row.code} starts with its own framework`);
    for (const { key } of frameworks) {
      const bare = rows.filter((row) => row.framework === key).map((row) => srsRequirementCode(row.code));
      assert.equal(new Set(bare).size, bare.length, `${key}: no two requirements read alike once the prefix goes`);
    }
    for (const row of rows.filter((entry) => entry.pillar === "strategy")) assert.match(srsRequirementCode(row.code), /^Str\d+$/, row.code);
    for (const row of rows.filter((entry) => entry.pillar !== "strategy")) assert.doesNotMatch(srsRequirementCode(row.code), /^S/, row.code);
  });
});

describe("Standard reads Framework on every SRS surface", () => {
  it("labels the dashboard filter, the admin column and the admin field Framework", () => {
    assert.match(area, /<label>Framework <select className="nz-sel" value=\{standardKey \?\? ""\}/);
    assert.match(area, /<option value="">Both frameworks — S2 climate-led, S1 general<\/option>/);
    assert.match(admin, /header: "Framework · pillar"/);
    assert.match(admin, /<SelectField label="Framework" value=\{draft\.frameworkKey\}/);
    for (const [name, source] of [["SrsArea", area], ["SrsAssessmentForms", forms], ["PortalReadiness", portal], ["SrsFrameworkBoard", admin]] as const) {
      assert.doesNotMatch(source, /label="Standard"|>Standard <|"Standard · |S1 and S2"|as the standards move|UK SRS standards/, name);
    }
  });
});

describe("the reference fix: the framework once, then the bare code", () => {
  it("cuts the register's pillar tables by framework, a header row each, and drops the trailing standard", () => {
    assert.match(area, /srsByFramework\(rows, \(requirement\) => requirement\.standardKey, model\.standards\)\.map\(\(group\) => <tbody key=\{group\.key \?\? "other"\}>/);
    assert.match(area, /<th scope="colgroup" colSpan=\{9\}><span className="nz-eyebrow">\{group\.label\}<\/span><\/th>/);
    assert.match(area, /<div className="muted">\{srsRequirementCode\(requirement\.code\)\}\{requirement\.source === "auto"/);
    assert.doesNotMatch(area, /\{requirement\.code\} · \{requirement\.standardKey\}/, "the old S2 G1 · S2");
  });

  it("names the framework, not its key, on Path to SRS-ready and in the wizard's header", () => {
    assert.match(area, /\?\.label\} · \{frameworkLabels\.get\(gap\.requirement\.standardKey\) \?\? gap\.requirement\.standardKey\}/);
    assert.match(forms, /`\$\{frameworkLabel\} · \$\{pillar\.label\}`/);
    assert.match(forms, /const code = srsRequirementCode\(requirement\.code\);/);
  });

  it("reads the bare code on Auto allocation, the bridge drawer and the portal, the framework named once beside it", () => {
    assert.match(area, /<b>\{srsRequirementCode\(requirement\.code\)\}<\/b> \{requirement\.title\}/);
    assert.match(bridge, /Bridge a readiness gap · \{reference\}/);
    assert.match(portal, /srsByFramework\(group\.requirements,requirement=>requirement\.standardKey,model\.standards\)/);
    assert.match(portal, /srsByFramework\(pillar\.gaps,gap=>srsCodeFrameworkKey\(gap\.code\),frameworks\)/);
    assert.match(portal, /<span className="nz-tag">\{srsRequirementCode\(requirement\.code\)\}<\/span>/);
    assert.match(portal, /<span className="nz-tag">\{srsRequirementCode\(gap\.code\)\}<\/span>/);
    assert.match(portal, /\{frameworkLabel\} · \{requirement\.pillarLabel\} · \{srsRequirementCode\(requirement\.code\)\}/);
  });

  it("keeps the stored code where it is data: the admin code column and the client's proposal note", () => {
    assert.match(admin, /cell: \(row\) => <span className="nz-a-mono">\{row\.code\}<\/span>/);
    assert.match(portal, /\(An idea suggested by AI for \$\{code\}\.\)/);
  });
});

describe("the SRS readiness report (PDF) reads the same way (Phase B)", () => {
  const report = read("app/clients/[clientId]/srs-report/SrsReportDocument.tsx");

  it("draws one heatmap per framework, named once, with bare codes in its cells", () => {
    assert.match(report, /srsByFramework\(dashboard\.requirements, \(requirement\) => requirement\.standardKey, dashboard\.standards\)\.map\(\(framework\) =>/);
    assert.match(report, /\{framework\.label \? <h3>\{framework\.label\}<\/h3> : null\}/);
    assert.match(report, /cells: group\.requirements\.map\(\(requirement\) => \(\{ code: srsRequirementCode\(requirement\.code\)/);
  });

  it("names the framework once in the metrics table and the roadmap, then the bare code", () => {
    assert.match(report, /<tr><th scope="colgroup" colSpan=\{3\}>\{framework\.label\}<\/th><\/tr>/);
    assert.match(report, /<th scope="row">\{srsRequirementCode\(requirement\.code\)\} · \{requirement\.title\}<\/th>/);
    assert.match(report, /srsByFramework\(pillar\.gaps, \(gap\) => srsCodeFrameworkKey\(gap\.code\), dashboard\.standards\)/);
    assert.match(report, /\{framework\.label \? <h4>\{framework\.label\}<\/h4> : null\}/, "each pillar's gaps name their framework once");
    assert.match(report, /<b>\{srsRequirementCode\(gap\.code\)\}<\/b> \{gap\.title\}/);
    assert.doesNotMatch(report, /\{requirement\.code\} · |<b>\{gap\.code\}<\/b>|code: requirement\.code,/, "no stored code printed as the reference");
  });
});
