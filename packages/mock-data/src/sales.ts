export type OpportunityStage = "discovery" | "proposal" | "negotiation";
export type OpportunityStatus = "OPEN" | "WON" | "LOST";
export type SalesEvidence = { source: string; capturedAt: string; summary: string; url?: string };

export type SalesOpportunity = {
  id: string;
  company: string;
  contact: string;
  service: string;
  owner: string;
  stage: OpportunityStage;
  status: OpportunityStatus;
  value: number;
  probability: number;
  nextTask: string;
  nextTaskDue: string;
  ageDays: number;
  evidence: SalesEvidence[];
  history: { at: string; event: string; actor: string }[];
  handoff?: { clientId?: string; quoteNumber?: string; jobNumber?: string; commandKey: string };
};

export type SalesProspect = {
  id: string;
  company: string;
  status: "new" | "under-review" | "promoted" | "rejected";
  reason: string;
  evidenceCount: number;
  source: string;
  runId: string;
};

export const salesOpportunities: SalesOpportunity[] = [
  { id: "opp-104", company: "Alder Manufacturing Group", contact: "S. Mercer · Sustainability Director", service: "Carbon Reduction Plan", owner: "M. Osei", stage: "negotiation", status: "OPEN", value: 28600, probability: 75, nextTask: "Confirm procurement timetable", nextTaskDue: "27 Aug 2026", ageDays: 41, evidence: [{ source: "Companies House", capturedAt: "18 Aug 2026", summary: "Active UK company; identity and registered office verified." }, { source: "Company sustainability report", capturedAt: "18 Aug 2026", summary: "Public 2035 net-zero commitment and Scope 3 data gap identified." }], history: [{ at: "22 Aug 2026", event: "Moved Proposal → Negotiation", actor: "M. Osei" }, { at: "19 Aug 2026", event: "Proposal Q000231 created", actor: "M. Osei" }], handoff: { quoteNumber: "Q000231", commandKey: "convert:opp-104:v1" } },
  { id: "opp-108", company: "Northbank Care Partnership", contact: "R. Ellis · Procurement Lead", service: "Supplier emissions programme", owner: "A. Shaw", stage: "proposal", status: "OPEN", value: 18400, probability: 50, nextTask: "Review proposal with client", nextTaskDue: "29 Aug 2026", ageDays: 24, evidence: [{ source: "NHS supplier portal", capturedAt: "20 Aug 2026", summary: "Published procurement requirement for a current CRP." }], history: [{ at: "21 Aug 2026", event: "Moved Discovery → Proposal", actor: "A. Shaw" }], handoff: { commandKey: "convert:opp-108:v1" } },
  { id: "opp-111", company: "Mariner Packaging Ltd", contact: "T. Morgan · Technical Manager", service: "Packaging LCA", owner: "M. Osei", stage: "discovery", status: "OPEN", value: 12200, probability: 25, nextTask: "Obtain product BOM sample", nextTaskDue: "26 Aug 2026", ageDays: 9, evidence: [{ source: "Companies House", capturedAt: "23 Aug 2026", summary: "Company identity and SIC classification verified." }, { source: "Client enquiry", capturedAt: "23 Aug 2026", summary: "Inbound request for cradle-to-grave packaging comparison." }], history: [{ at: "23 Aug 2026", event: "Lead qualified; opportunity opened", actor: "M. Osei" }], handoff: { commandKey: "convert:opp-111:v1" } },
  { id: "opp-097", company: "Fellside Distribution", contact: "J. Ward · Operations Director", service: "Carbon literacy training", owner: "A. Shaw", stage: "negotiation", status: "WON", value: 7800, probability: 100, nextTask: "Training job mobilisation", nextTaskDue: "2 Sep 2026", ageDays: 52, evidence: [{ source: "Signed proposal", capturedAt: "15 Aug 2026", summary: "Accepted scope and commercial terms." }], history: [{ at: "15 Aug 2026", event: "Marked WON; client, quote and job transaction completed", actor: "A. Shaw" }], handoff: { clientId: "fellside", quoteNumber: "Q000224", jobNumber: "J000719", commandKey: "convert:opp-097:v1" } },
];

export const salesProspects: SalesProspect[] = [
  { id: "pro-301", company: "Helix Cold Chain", status: "under-review", reason: "SECR disclosure plus fleet transition programme", evidenceCount: 3, source: "Run PR-0826-04", runId: "PR-0826-04" },
  { id: "pro-302", company: "Crownfield Components", status: "new", reason: "Public tender requests supplier carbon reporting", evidenceCount: 2, source: "Run PR-0826-04", runId: "PR-0826-04" },
  { id: "pro-298", company: "Solent Fabrications", status: "promoted", reason: "Verified inbound product-footprint requirement", evidenceCount: 4, source: "Inbound", runId: "IN-0822" },
];

export const prospectingRuns = [
  { id: "PR-0826-04", profile: "UK manufacturers · 50–500 staff", state: "review-ready" as const, candidates: 18, verified: 12, failed: 2, startedAt: "25 Aug 2026, 06:30" },
  { id: "PR-0820-03", profile: "Public-sector suppliers", state: "complete" as const, candidates: 24, verified: 19, failed: 0, startedAt: "20 Aug 2026, 06:30" },
];

export function weightedPipeline(opportunities: SalesOpportunity[]) {
  return opportunities.filter((item) => item.status === "OPEN").reduce((sum, item) => sum + item.value * item.probability / 100, 0);
}

export function canCreateJob(opportunity: SalesOpportunity) {
  return opportunity.status === "WON" && Boolean(opportunity.handoff?.quoteNumber);
}
