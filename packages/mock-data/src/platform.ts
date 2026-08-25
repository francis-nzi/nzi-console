export type HealthState = "success" | "degraded" | "failed" | "loading" | "empty";
export type AuditSeverity = "info" | "warning" | "critical";

export type PlatformService = { id: string; name: string; area: string; state: HealthState; detail: string; checkedAt: string; latencyMs?: number };
export type AuditEvent = {
  id: string; at: string; actor: string; principal: "staff" | "portal" | "system"; organisation: string;
  action: string; entity: string; entityId: string; result: "allowed" | "denied" | "failed"; severity: AuditSeverity;
  correlationId: string; before?: string; after?: string; reason?: string;
};
export type StaffRole = { id: string; name: string; members: number; permissions: string[]; restricted: string[] };

export const platformServices: PlatformService[] = [
  { id: "console", name: "Console web", area: "Application", state: "success", detail: "Static shell and route health normal", checkedAt: "25 Aug 2026, 14:42", latencyMs: 84 },
  { id: "api", name: "Isolated API", area: "Application", state: "success", detail: "Typed mock contract adapter responding", checkedAt: "25 Aug 2026, 14:42", latencyMs: 112 },
  { id: "database", name: "Tenant database", area: "Data", state: "success", detail: "RLS policy check and connection pool normal", checkedAt: "25 Aug 2026, 14:41", latencyMs: 31 },
  { id: "pdf", name: "PDF worker", area: "Background", state: "degraded", detail: "One retry queued; last successful render 14:34", checkedAt: "25 Aug 2026, 14:41", latencyMs: 1460 },
  { id: "prospecting", name: "Prospecting worker", area: "Background", state: "success", detail: "Evidence verification queue has 6 pending", checkedAt: "25 Aug 2026, 14:40", latencyMs: 240 },
  { id: "xero", name: "Xero projection", area: "Integration", state: "empty", detail: "Not connected in this isolated environment", checkedAt: "25 Aug 2026, 14:40" },
];

export const auditEvents: AuditEvent[] = [
  { id: "aud-901", at: "25 Aug 2026, 14:38:12", actor: "A. Shaw", principal: "staff", organisation: "NZI", action: "report.publish", entity: "ReportVersion", entityId: "CRP-J000712-v1", result: "allowed", severity: "info", correlationId: "req-81f2a", before: "draft", after: "published" },
  { id: "aud-902", at: "25 Aug 2026, 14:31:04", actor: "Portal · Bushy Tails", principal: "portal", organisation: "Bushy Tails Ltd", action: "scope_row.update", entity: "ScopeRow", entityId: "commute", result: "denied", severity: "warning", correlationId: "req-81e91", reason: "Data-entry grant expired" },
  { id: "aud-903", at: "25 Aug 2026, 14:20:55", actor: "M. Osei", principal: "staff", organisation: "NZI", action: "opportunity.convert", entity: "Opportunity", entityId: "opp-097", result: "allowed", severity: "info", correlationId: "cmd-convert-097", before: "WON", after: "Client + Q000224 + J000719" },
  { id: "aud-904", at: "25 Aug 2026, 14:12:19", actor: "System", principal: "system", organisation: "NZI", action: "pdf.render", entity: "ReportVersion", entityId: "CRP-J000712-v2-draft", result: "failed", severity: "critical", correlationId: "job-pdf-442", reason: "Renderer timeout; retry 1 of 3 queued" },
  { id: "aud-905", at: "25 Aug 2026, 13:58:47", actor: "F. Doherty", principal: "staff", organisation: "NZI", action: "dataset.manual_add", entity: "DatasetResolution", entityId: "J000712-S3", result: "allowed", severity: "warning", correlationId: "req-81c10", reason: "Client-specific supplier factor required" },
];

export const staffRoles: StaffRole[] = [
  { id: "admin", name: "Administrator", members: 2, permissions: ["All workspaces", "Manage users and roles", "Manage datasets", "Emergency override with reason"], restricted: [] },
  { id: "consultant", name: "Consultant", members: 7, permissions: ["View and edit assigned clients/jobs", "Enter and map data", "Draft reports", "Create sales activity"], restricted: ["Publish reports", "Manage users", "Change platform settings"] },
  { id: "reviewer", name: "Reviewer", members: 3, permissions: ["Review all jobs", "Approve overrides", "Publish reports", "Release to portal"], restricted: ["Manage users", "Edit financials"] },
  { id: "finance", name: "Finance", members: 2, permissions: ["View clients and jobs", "Manage quotes/invoices", "View commercial reporting"], restricted: ["Edit emissions", "Publish reports", "Manage datasets"] },
  { id: "readonly", name: "Read-only", members: 4, permissions: ["View permitted staff workspaces"], restricted: ["All mutations", "Portal impersonation"] },
];

export function platformSummary(services: PlatformService[]) {
  return {
    healthy: services.filter((item) => item.state === "success").length,
    degraded: services.filter((item) => item.state === "degraded").length,
    failed: services.filter((item) => item.state === "failed").length,
    unconfigured: services.filter((item) => item.state === "empty").length,
  };
}

export function tenantIsolationPass(events: AuditEvent[]) {
  return events.every((event) => Boolean(event.organisation && event.correlationId));
}
