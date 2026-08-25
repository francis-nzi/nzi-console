export type JobFamily = "crp" | "consultancy" | "lca" | "pcf" | "training";
export type JobLifecycleStatus = "draft" | "open" | "on-hold" | "complete" | "cancelled";

export const jobFamilyMeta: Record<JobFamily, { code: string; label: string; description: string }> = {
  crp: { code: "CRP", label: "Carbon Reduction Plan", description: "Scope data, factors, QA and carbon reduction reporting" },
  consultancy: { code: "CON", label: "Consultancy", description: "Deliverables, effort, client review and completion" },
  lca: { code: "LCA", label: "Life Cycle Assessment", description: "Assessment, BOM, transport, scenarios and report" },
  pcf: { code: "PCF", label: "Product Carbon Footprint", description: "Product boundary, BOM, factors and product report" },
  training: { code: "TRN", label: "Training", description: "Course run, sessions, bookings, attendance and certificates" },
};

export function formatJobNumber(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 999999) throw new RangeError("Job sequence must be an integer from 0 to 999999.");
  return `J${String(sequence).padStart(6, "0")}`;
}

export type JobHeader = {
  id: string;
  version: number;
  sequence: number;
  number: string;
  family: JobFamily;
  clientId: string;
  client: string;
  title: string;
  reportingYear?: number;
  status: JobLifecycleStatus;
  workflowStage: string;
  owner: string;
  startDate: string;
  dueDate: string;
  quoteId?: string;
  progressPct: number;
};

export type CrpDetail = { kind: "crp"; reportingPeriod: string; includedScopes: string[]; reviewedRows: number; totalRows: number };
export type ConsultancyDetail = { kind: "consultancy"; scope: string; deliverables: string[]; plannedDays: number; usedDays: number };
export type LcaDetail = { kind: "lca"; assessment: string; boundary: string; bomLines: number; scenarios: number };
export type PcfDetail = { kind: "pcf"; product: string; functionalUnit: string; bomLines: number; readinessPct: number };
export type TrainingDetail = { kind: "training"; course: string; sessions: number; bookings: number; attendancePct: number };
export type JobDetail = CrpDetail | ConsultancyDetail | LcaDetail | PcfDetail | TrainingDetail;
export type JobStageEvent = { id: string; fromStage: string; toStage: string; actorId: string; note?: string; occurredAt: string };
export type FamilyJob = { header: JobHeader; detail: JobDetail; stageHistory: JobStageEvent[] };

export const jobs: FamilyJob[] = [
  { header: { id: "712", version: 1, sequence: 712, number: formatJobNumber(712), family: "crp", clientId: "bushy-tails", client: "Bushy Tails Ltd", title: "2024 Carbon Reduction Plan", reportingYear: 2024, status: "open", workflowStage: "Data entry", owner: "A. Shaw", startDate: "2025-01-06", dueDate: "2025-03-31", quoteId: "Q-2024-188", progressPct: 66 }, detail: { kind: "crp", reportingPeriod: "1 Jan–31 Dec 2024", includedScopes: ["1", "2", "3"], reviewedRows: 142, totalRows: 214 }, stageHistory: [] },
  { header: { id: "713", version: 1, sequence: 713, number: formatJobNumber(713), family: "consultancy", clientId: "cedar-cra", client: "Cedar & Crane Architects", title: "Net-zero strategy support", status: "open", workflowStage: "Delivery", owner: "M. Osei", startDate: "2025-02-03", dueDate: "2025-05-30", progressPct: 45 }, detail: { kind: "consultancy", scope: "Develop and facilitate an operational net-zero roadmap", deliverables: ["Discovery workshop", "Roadmap", "Board presentation"], plannedDays: 18, usedDays: 8 }, stageHistory: [] },
  { header: { id: "714", version: 1, sequence: 714, number: formatJobNumber(714), family: "lca", clientId: "verdant", client: "Verdant Foods Co", title: "Packaging life cycle assessment", status: "open", workflowStage: "Inventory", owner: "A. Shaw", startDate: "2025-02-10", dueDate: "2025-06-20", progressPct: 38 }, detail: { kind: "lca", assessment: "Recyclable food packaging", boundary: "Cradle-to-grave", bomLines: 34, scenarios: 3 }, stageHistory: [] },
  { header: { id: "715", version: 1, sequence: 715, number: formatJobNumber(715), family: "pcf", clientId: "quaymed", client: "Quaymed Devices", title: "Device product carbon footprint", status: "open", workflowStage: "Factor mapping", owner: "M. Osei", startDate: "2025-02-17", dueDate: "2025-06-30", progressPct: 52 }, detail: { kind: "pcf", product: "QMD Diagnostic Unit", functionalUnit: "One device over service life", bomLines: 86, readinessPct: 71 }, stageHistory: [] },
  { header: { id: "716", version: 1, sequence: 716, number: formatJobNumber(716), family: "training", clientId: "harbourline", client: "Harbourline Logistics", title: "Carbon literacy cohort", status: "open", workflowStage: "Delivery", owner: "A. Shaw", startDate: "2025-03-01", dueDate: "2025-04-15", progressPct: 60 }, detail: { kind: "training", course: "Carbon Literacy for Operations", sessions: 4, bookings: 28, attendancePct: 89 }, stageHistory: [] },
];

export function findJob(idOrNumber: string): FamilyJob | undefined {
  const normalised = idOrNumber.toUpperCase();
  return jobs.find((job) => job.header.id === idOrNumber || job.header.number === normalised);
}
