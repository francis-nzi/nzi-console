export type QualityTier = "Measured" | "Estimated" | "Spend-based" | "Survey";

export type ProvenanceSignature = {
  factorSet: string;
  factorSetVersion: string;
  dataHash: string;
  asAtDate: string;
  sourceRef: string;
  resolver: string;
};

export type FigureEvidence = {
  value: number;
  unit: string;
  qualityTier: QualityTier | "Mixed";
  provenance: ProvenanceSignature | null;
  lineage: Array<{ title: string; detail: string }>;
};

export type SiteLifecycle = "in-service" | "vacated";
export type ClientSiteReadModel = {
  id: string;
  name: string;
  isRegisteredOffice: boolean;
  inServiceFrom: string;
  vacatedEffective: string | null;
  status: SiteLifecycle;
  version: number;
};

export function siteIsInReportingBoundary(site: Pick<ClientSiteReadModel, "inServiceFrom" | "vacatedEffective">, reportingYear: number): boolean {
  const yearStart = `${reportingYear}-01-01`;
  const yearEnd = `${reportingYear}-12-31`;
  return site.inServiceFrom <= yearEnd && (site.vacatedEffective === null || site.vacatedEffective >= yearStart);
}

export function resolveSiteBoundary<T extends Pick<ClientSiteReadModel, "inServiceFrom" | "vacatedEffective">>(sites: readonly T[], reportingYear: number): T[] {
  return sites.filter((site) => siteIsInReportingBoundary(site, reportingYear));
}