export type PortalAccessGrant = {
  portalUserId: string;
  clientId: string;
  jobIds: string[];
  dataEntryExpiresAt: string;
  permissions: Array<"view-results" | "download-report" | "comment" | "enter-data">;
};

export type PortalDataBucket = {
  id: string;
  label: string;
  scope: "1" | "2" | "3";
  allowedUnits: string[];
  status: "complete" | "needs-data" | "submitted";
  rows: number;
};

export type PublishedReportVersion = {
  id: string;
  jobId: string;
  jobNumber: string;
  manifestId: string;
  manifestVersion: number;
  reviewedSnapshotId: string;
  dataHash: string;
  publishedAt: string;
  publishedBy: string;
};

export const portalAccessSample: PortalAccessGrant = {
  portalUserId: "portal-priya",
  clientId: "bushy-tails",
  jobIds: ["712"],
  dataEntryExpiresAt: "2026-09-30T23:59:59Z",
  permissions: ["view-results", "download-report", "comment", "enter-data"],
};

export const portalBucketsSample: PortalDataBucket[] = [
  { id: "stationary-fuel", label: "Fuel and heating", scope: "1", allowedUnits: ["litres", "kWh"], status: "complete", rows: 2 },
  { id: "electricity", label: "Purchased electricity", scope: "2", allowedUnits: ["kWh", "MWh"], status: "submitted", rows: 1 },
  { id: "business-travel", label: "Business travel", scope: "3", allowedUnits: ["km", "passenger-km"], status: "needs-data", rows: 0 },
  { id: "waste", label: "Waste", scope: "3", allowedUnits: ["kg", "tonnes"], status: "complete", rows: 1 },
];

export const publishedReportSample: PublishedReportVersion = {
  id: "CRP-J000712-v1", jobId: "712", jobNumber: "J000712", manifestId: "crp_professional",
  manifestVersion: 1, reviewedSnapshotId: "reviewed-crp-J000712-v1",
  dataHash: "sha256-demo-reviewed-crp-J000712-v1", publishedAt: "2026-08-24T20:00:00Z", publishedBy: "A. Shaw",
};

export function canAccessPortalJob(grant: PortalAccessGrant, clientId: string, jobId: string): boolean {
  return grant.clientId === clientId && grant.jobIds.includes(jobId) && grant.permissions.includes("view-results");
}

export function canEnterPortalData(grant: PortalAccessGrant, nowIso: string): boolean {
  return grant.permissions.includes("enter-data") && nowIso <= grant.dataEntryExpiresAt;
}
