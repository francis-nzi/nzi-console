export type ScreenKey = "control" | "clients" | "jobs" | "job" | "scopeRows" | "factorOptions" | "emissionsTarget" | "intensityTarget" | "sites" | "purchasedGoodsCategories" | "reviewedSnapshots" | "charts" | "datasets" | "reports" | "report" | "lca" | "portal" | "sales" | "platform";
export type ScreenIssue = { code: string; message: string; retryable: boolean; correlationId?: string };
export type ScreenMeta = { contract: ScreenKey; receivedAt: string; source: "fixture" | "api"; requestId: string };
export type ScreenResult<T> =
  | { state: "loading"; meta?: Partial<ScreenMeta> }
  | { state: "empty"; meta: ScreenMeta; message: string }
  | { state: "degraded"; meta: ScreenMeta; data: T; warning: ScreenIssue }
  | { state: "failed"; meta: ScreenMeta; error: ScreenIssue }
  | { state: "success"; meta: ScreenMeta; data: T };

export type ScreenContract<T> = { key: ScreenKey; isEmpty: (data: T) => boolean; validate: (value: unknown) => boolean };
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const rows = (value: unknown, field: string) => record(value) && Array.isArray(value[field]);

export const screenContracts: Record<ScreenKey, ScreenContract<unknown>> = {
  control: { key: "control", validate: record, isEmpty: () => false },
  clients: { key: "clients", validate: (value) => rows(value, "clients"), isEmpty: (value) => record(value) && (value.clients as unknown[]).length === 0 },
  jobs: { key: "jobs", validate: (value) => rows(value, "jobs"), isEmpty: (value) => record(value) && (value.jobs as unknown[]).length === 0 },
  job: { key: "job", validate: (value) => record(value) && record(value.job), isEmpty: () => false },
  scopeRows: { key: "scopeRows", validate: (value) => rows(value, "rows"), isEmpty: () => false },
  factorOptions: { key: "factorOptions", validate: (value) => rows(value, "factors") && rows(value, "datasets"), isEmpty: () => false },
  emissionsTarget: { key:"emissionsTarget",validate:(value)=>record(value)&&("target" in value),isEmpty:()=>false },
  intensityTarget:{key:"intensityTarget",validate:(value)=>record(value)&&("target" in value),isEmpty:()=>false},
  sites:{key:"sites",validate:(value)=>rows(value,"sites"),isEmpty:()=>false},
  purchasedGoodsCategories:{key:"purchasedGoodsCategories",validate:(value)=>rows(value,"categories"),isEmpty:()=>false},
  reviewedSnapshots:{key:"reviewedSnapshots",validate:(value)=>rows(value,"snapshots"),isEmpty:(value)=>record(value)&&(value.snapshots as unknown[]).length===0},
  charts: { key: "charts", validate: record, isEmpty: () => false },
  datasets: { key: "datasets", validate: (value) => rows(value, "datasets") && rows(value, "issues"), isEmpty: (value) => record(value) && (value.datasets as unknown[]).length === 0 },
  reports: { key: "reports", validate: (value) => rows(value, "reports"), isEmpty: (value) => record(value) && (value.reports as unknown[]).length === 0 },
  report: { key: "report", validate: (value) => record(value) && record(value.report), isEmpty: () => false },
  lca: { key: "lca", validate: (value) => rows(value, "assessments"), isEmpty: (value) => record(value) && (value.assessments as unknown[]).length === 0 },
  portal: { key: "portal", validate: record, isEmpty: () => false },
  sales: { key: "sales", validate: (value) => rows(value, "opportunities") && rows(value, "prospects") && rows(value, "runs"), isEmpty: (value) => record(value) && (value.opportunities as unknown[]).length === 0 && (value.prospects as unknown[]).length === 0 },
  platform: { key: "platform", validate: (value) => rows(value, "services") && rows(value, "events") && rows(value, "roles"), isEmpty: (value) => record(value) && (value.services as unknown[]).length === 0 },
};

export function contractFor<T>(key: ScreenKey): ScreenContract<T> { return screenContracts[key] as ScreenContract<T>; }
export function hasData<T>(result: ScreenResult<T>): result is Extract<ScreenResult<T>, { state: "success" | "degraded" }> { return result.state === "success" || result.state === "degraded"; }
export * from "./commands";
export * from "./spendImport";
export * from "./consultancyFamily";
