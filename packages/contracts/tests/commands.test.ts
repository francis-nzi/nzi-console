import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commandDefinitions, isAllowedJobStageTransition, jobWorkflowStages, validateCommand, type CommandContext } from "../src/index";
const context: CommandContext = { organisationId: "org-nzi", actorId: "user-1", principal: "staff", idempotencyKey: "idem-1", correlationId: "corr-1" };
describe("command contracts", () => {
  it("defines adjacent forward and backward transitions for every job family", () => {
    for (const [family, stages] of Object.entries(jobWorkflowStages)) {
      const typedFamily = family as keyof typeof jobWorkflowStages;
      assert.equal(isAllowedJobStageTransition(typedFamily, stages[0]!, stages[1]!), true);
      assert.equal(isAllowedJobStageTransition(typedFamily, stages[1]!, stages[0]!), true);
      assert.equal(isAllowedJobStageTransition(typedFamily, stages[0]!, stages[2]!), false);
    }
  });
  it("validates client and job creation before transport", () => {
    assert.equal(validateCommand("client.create", { name: "", status: "active", sector: "Services", location: "London", owner: "A" }, context).some((issue) => issue.field === "name"), true);
    assert.equal(validateCommand("job.create", { clientId: "c1", family: "crp", title: "CRP", workflowStage: "Setup", owner: "A", startDate: "2026-12-31", dueDate: "2026-01-01" }, context).some((issue) => issue.code === "INVALID_RANGE"), true);
  });
  it("validates canonical scope-row quantity, scope and factor provenance", () => {
    const base = { jobId: "job-a", scope: "3.1", sourceLabel: "Purchased goods", quantity: 100, unit: "GBP", datasetId: "dataset-a", factorId: "factor-a", factorVersion: "2026 v1", factorLabel: "Synthetic factor", qualityTier: "spend-based" as const };
    assert.equal(validateCommand("scope.row.create", base, context).length, 0);
    assert.ok(validateCommand("scope.row.create", { ...base, scope: "4", quantity: -1, datasetId: null }, context).some((issue) => issue.field === "scope"));
    assert.ok(validateCommand("scope.row.create", { ...base, datasetId: null }, context).some((issue) => issue.field === "datasetId"));
    assert.equal(validateCommand("scope.row.create", { ...base, scope: "3.15" }, context).length, 0);
    assert.ok(validateCommand("scope.row.create", { ...base, scope: "3.16" }, context).some((issue) => issue.field === "scope"));
    assert.equal(validateCommand("scope.row.create", { ...base, applyPct: 60, dataConfidence: "H", sourceQuantity: 125, sourceUnit: "GBP" }, context).length, 0);
    assert.ok(validateCommand("scope.row.create", { ...base, applyPct: 101 }, context).some((issue) => issue.field === "applyPct"));
    assert.ok(validateCommand("scope.row.create", { ...base, sourceQuantity: 125, sourceUnit: null }, context).some((issue) => issue.field === "sourceUnit"));
    assert.ok(validateCommand("scope.row.create", { ...base, factorSource: "client", clientFactorId: "cf-a", isCustomEntry: false, datasetId: null }, context).some((issue) => issue.field === "clientFactorId"));
  });
  it("registers each material mutation with permission, transaction and audit action", () => { for (const definition of Object.values(commandDefinitions)) { assert.ok(definition.permission); assert.ok(definition.transaction); assert.ok(definition.auditAction); } });
  it("blocks report publication without the validated precondition", () => assert.ok(validateCommand("report.publish", { reportVersionId: "r1", expectedStatus: "draft" as "validated", manifestVersion: 1, reviewedSnapshotId: "s1" }, context).some((issue) => issue.code === "PRECONDITION")));
  it("requires a reviewed snapshot and manifest version for validation",()=>assert.ok(validateCommand("report.validate",{reviewedSnapshotId:"",manifestVersion:0},context).length===2));
  it("requires a reason for manual dataset overrides", () => assert.ok(validateCommand("dataset.override.add", { jobId: "712", scope: "3", datasetId: "d1", reportingFrom: "2024-01-01", reportingTo: "2024-12-31" }, context).some((issue) => issue.field === "reason")));
  it("requires optimistic versioning for scope-row calculation", () => assert.ok(validateCommand("scope.row.calculate", { jobId: "712", rowId: "row-a", expectedVersion: 0 }, context).some((issue) => issue.field === "expectedVersion")));
  it("requires a reason for a scope-row emissions override", () => {
    const base = { jobId: "job-a", scope: "1", sourceLabel: "Gas", quantity: 10, unit: "kWh", datasetId: "dataset-a", factorId: "factor-a", factorVersion: "v1", factorLabel: "Gas factor", qualityTier: "measured" as const };
    assert.ok(validateCommand("scope.row.create", { ...base, overrideTco2e: 2.4, overrideReason: null }, context).some((issue) => issue.field === "overrideReason"));
    assert.equal(validateCommand("scope.row.create", { ...base, overrideTco2e: 2.4, overrideReason: "Invoice evidence supersedes estimated activity" }, context).length, 0);
  });
  it("validates monthly activity slot identity and quantities",()=>{const base={jobId:"job-a",scope:"1",sourceLabel:"Gas",quantity:30,unit:"kWh",datasetId:"dataset-a",factorId:"factor-a",factorVersion:"v1",factorLabel:"Gas factor",qualityTier:"measured" as const};assert.equal(validateCommand("scope.row.create",{...base,monthlyActivity:[{month:"2026-01",quantity:10},{month:"2026-02",quantity:20}]},context).length,0);assert.ok(validateCommand("scope.row.create",{...base,monthlyActivity:[{month:"January",quantity:-1},{month:"January",quantity:2}]},context).length>=3);});
  it("requires a reviewer note for rejection",()=>assert.ok(validateCommand("scope.review.reject",{jobId:"712",rowIds:["row-a"],expectedReviewVersion:2,reviewerNote:""},context).some(issue=>issue.field==="reviewerNote")));
  it("requires the expected job version before snapshotting",()=>assert.ok(validateCommand("report.snapshot.create",{jobId:"712",expectedJobVersion:0},context).some(issue=>issue.field==="expectedJobVersion")));
  it("validates target chronology and reduction bounds",()=>{assert.equal(validateCommand("emissions.target.upsert",{jobId:"712",baselineYear:2024,baselineTco2e:1418,interimYear:2030,interimReductionPercent:50,netZeroYear:2045,expectedVersion:0},context).length,0);assert.ok(validateCommand("emissions.target.upsert",{jobId:"712",baselineYear:2030,baselineTco2e:0,interimYear:2028,interimReductionPercent:100,netZeroYear:2045,expectedVersion:0},context).length>=3);});
  it("validates intensity targets and denominators",()=>{assert.equal(validateCommand("emissions.intensity.upsert",{jobId:"712",metric:"turnover",denominatorUnit:"£m revenue",reportingDenominator:12,baselineYear:2024,baselineIntensity:100,interimYear:2030,interimReductionPercent:50,netZeroYear:2045,expectedVersion:0},context).length,0);assert.ok(validateCommand("emissions.intensity.upsert",{jobId:"712",metric:"turnover",denominatorUnit:"",reportingDenominator:0,baselineYear:2030,baselineIntensity:0,interimYear:2028,interimReductionPercent:100,netZeroYear:2045,expectedVersion:0},context).length>=5);});
  it("requires a name for purchased-goods categories",()=>assert.ok(validateCommand("purchased.goods.category.create",{jobId:"712",name:""},context).some(issue=>issue.field==="name")));
});
