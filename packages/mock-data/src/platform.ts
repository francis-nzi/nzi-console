import { capabilities, roleCapabilityGrants, roleLabels, staffRoles as contractStaffRoles, type StaffRole as ContractStaffRole } from "@nzi/contracts";
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

/** NZC-022 — the five matrix roles, derived from the one code copy of PERMISSION_MATRIX.md (illustrative member counts). */
const illustrativeMembers: Record<ContractStaffRole, number> = { admin: 2, consultant: 7, reviewer: 3, finance: 2, viewer: 4 };
export const staffRoles: StaffRole[] = contractStaffRoles.map((role) => {
  const held = roleCapabilityGrants(role);
  return {
    id: role, name: roleLabels[role], members: illustrativeMembers[role],
    permissions: held.map((grant) => grant.scope === "own_clients" ? `${grant.capability} (own)` : grant.capability),
    restricted: capabilities.filter((name) => !held.some((grant) => grant.capability === name)),
  };
});

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
