import type { ClientSiteReadModel, FigureEvidence } from "@nzi/contracts";

const signature = { factorSet: "DEFRA 2024", factorSetVersion: "v1.2", dataHash: "sha256:synthetic-bushy-tails-2024", asAtDate: "30/08/2026", sourceRef: "Reviewed snapshot · J000712 · v4", resolver: "crp.snapshot.resolve@1" };
const lineage = [{ title: "Reviewed snapshot", detail: "J000712 · version 4 · independently approved" }, { title: "Calculation", detail: "Assured activity rows × factor set, including row-level overrides" }];
export const clientFigureEvidence: { latest: FigureEvidence; scopes: Array<FigureEvidence & { scope: "1" | "2" | "3" }>; intensity: FigureEvidence } = {
  latest: { value: 1842, unit: "tCO2e", qualityTier: "Mixed", provenance: signature, lineage },
  scopes: [
    { scope: "1", value: 412, unit: "tCO2e", qualityTier: "Measured", provenance: signature, lineage },
    { scope: "2", value: 286, unit: "tCO2e", qualityTier: "Measured", provenance: signature, lineage },
    { scope: "3", value: 1144, unit: "tCO2e", qualityTier: "Mixed", provenance: signature, lineage },
  ],
  intensity: { value: 122.08, unit: "tCO2e / £m turnover", qualityTier: "Mixed", provenance: signature, lineage: [...lineage, { title: "Denominator", detail: "2024 assured turnover · £15.1m · J000712 business metric" }] },
};

export const clientSites: ClientSiteReadModel[] = [
  { id: "site-hq", name: "Manchester head office", isRegisteredOffice: true, inServiceFrom: "2023-04-01", vacatedEffective: null, status: "in-service", version: 1 },
  { id: "site-depot", name: "Trafford depot", isRegisteredOffice: false, inServiceFrom: "2023-04-01", vacatedEffective: "2024-07-01", status: "vacated", version: 2 },
  { id: "site-warehouse", name: "Salford warehouse", isRegisteredOffice: false, inServiceFrom: "2024-04-15", vacatedEffective: null, status: "in-service", version: 1 },
];
