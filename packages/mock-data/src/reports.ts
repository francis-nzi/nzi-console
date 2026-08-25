export type ReportTemplateVariable = { key: string; label: string; type: "text" | "date" | "number" | "contact"; required: boolean };
export type ReportTemplate = {
  id: string; family: "crp" | "consultancy" | "lca" | "pcf" | "training";
  name: string; version: number; manifestId: string; status: "draft" | "active" | "retired";
  variables: ReportTemplateVariable[];
};

export type ReportAssignment = { jobId: string; templateId: string; assignedAt: string; assignedBy: string };
export type ReportVersion = {
  readonly id: string; readonly jobId: string; readonly jobNumber: string; readonly client: string;
  readonly templateId: string; readonly templateVersion: number; readonly manifestId: string;
  readonly manifestVersion: number; readonly reviewedSnapshotId: string; readonly dataHash: string;
  readonly version: number; readonly status: "draft" | "validated" | "published";
  readonly createdAt: string; readonly createdBy: string; readonly publishedAt?: string;
};

export const reportTemplates: ReportTemplate[] = [{
  id: "crp-professional-v1", family: "crp", name: "CRP Professional", version: 1,
  manifestId: "crp_professional", status: "active",
  variables: [
    { key: "report_date", label: "Report date", type: "date", required: true },
    { key: "report_signee", label: "Report signee", type: "contact", required: true },
    { key: "executive_summary", label: "Executive summary", type: "text", required: true },
  ],
}];

export const reportAssignments: ReportAssignment[] = [{ jobId: "712", templateId: "crp-professional-v1", assignedAt: "2026-08-24T18:00:00Z", assignedBy: "A. Shaw" }];
export const reportVersions: ReportVersion[] = [{
  id: "CRP-J000712-v1", jobId: "712", jobNumber: "J000712", client: "Bushy Tails Ltd",
  templateId: "crp-professional-v1", templateVersion: 1, manifestId: "crp_professional", manifestVersion: 1,
  reviewedSnapshotId: "reviewed-crp-J000712-v1", dataHash: "sha256-demo-reviewed-crp-J000712-v1",
  version: 1, status: "published", createdAt: "2026-08-24T19:55:00Z", createdBy: "A. Shaw", publishedAt: "2026-08-24T20:00:00Z",
}, {
  id: "CRP-J000712-v2-draft", jobId: "712", jobNumber: "J000712", client: "Bushy Tails Ltd",
  templateId: "crp-professional-v1", templateVersion: 1, manifestId: "crp_professional", manifestVersion: 1,
  reviewedSnapshotId: "reviewed-crp-J000712-v1", dataHash: "sha256-demo-reviewed-crp-J000712-v1",
  version: 2, status: "validated", createdAt: "2026-08-25T08:30:00Z", createdBy: "A. Shaw",
}];

export function findReportVersion(id: string): ReportVersion | undefined { return reportVersions.find((version) => version.id === id); }
export function reportVersionCompatible(version: ReportVersion, template: ReportTemplate): boolean {
  return version.templateId === template.id && version.templateVersion === template.version && version.manifestId === template.manifestId;
}
