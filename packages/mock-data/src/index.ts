// Illustrative demonstrator data only — no real client data, no PII.

export * from "./clients";
export * from "./jobs";
export * from "./datasets";
export * from "./portal";
export * from "./reports";
export * from "./lca";
export * from "./sales";
export * from "./platform";

export type RowStatus = "complete" | "needs" | "estimated";

export type LineageStep = { title: string; detail: string };

export type ScopeRow = {
  id: string;
  source: string;
  scope: string;        // "1", "2", "3.4" …
  scopeColor: string;   // hex swatch
  activity: string | null;
  unit: string | null;
  factorSet: string;
  factorMatched: boolean;
  factorText: string;
  tco2e: string | null;
  quality: string;
  provenance: string;
  status: RowStatus;
  banner: { kind: "ok" | "warn"; text: string };
  lineage: LineageStep[] | null;
};

export type Job = {
  id: string;
  number: string;
  client: string;
  year: number;
  owner: string;
  statusLabel: string;
  progressLabel: string;
  progressPct: number;
  counts: { all: number; needs: number; estimated: number; complete: number };
  rows: ScopeRow[];
};

export const job712: Job = {
  id: "712",
  number: "J000712",
  client: "Bushy Tails Ltd",
  year: 2024,
  owner: "A. Shaw",
  statusLabel: "In progress · data entry",
  progressLabel: "142 of 214 sources",
  progressPct: 66,
  counts: { all: 9, needs: 2, estimated: 2, complete: 5 },
  rows: [
    {
      id: "diesel", source: "Diesel — company vehicles", scope: "1", scopeColor: "#FF5C48",
      activity: "48,200", unit: "litres", factorSet: "DEFRA 2024 · v1.2", factorMatched: true,
      factorText: "DEFRA 2024 → diesel (avg biofuel blend) · 2.664 kgCO₂e/L",
      tco2e: "128.4 tCO₂e", quality: "Measured", provenance: "Measured (primary)", status: "complete",
      banner: { kind: "ok", text: "Validated. Activity data, unit and factor all resolved; included in the total." },
      lineage: [
        { title: "Fuel invoices imported", detail: "Job J000712 · 12 line items" },
        { title: "Litres normalised & unit-checked", detail: "48,200 L confirmed" },
        { title: "Factor matched", detail: "DEFRA 2024 diesel" },
        { title: "Emissions computed", detail: "48,200 × 2.664 ÷ 1000 = 128.4" },
      ],
    },
    {
      id: "gas", source: "Natural gas — heating", scope: "1", scopeColor: "#FF5C48",
      activity: "96,000", unit: "kWh", factorSet: "DEFRA 2024 · v1.2", factorMatched: true,
      factorText: "DEFRA 2024 → natural gas · 0.183 kgCO₂e/kWh",
      tco2e: "17.6 tCO₂e", quality: "Measured", provenance: "Measured", status: "complete",
      banner: { kind: "ok", text: "Validated. Included in the total." },
      lineage: [
        { title: "Meter data imported", detail: "96,000 kWh" },
        { title: "Factor matched", detail: "DEFRA 2024 nat gas" },
        { title: "Emissions computed", detail: "96,000 × 0.183 ÷ 1000 = 17.6" },
      ],
    },
    {
      id: "fgas", source: "Refrigerant R410a top-up", scope: "1", scopeColor: "#FF5C48",
      activity: null, unit: null, factorSet: "—", factorMatched: false,
      factorText: "No factor matched — R410a is a blend; select an F-gas GWP factor.",
      tco2e: null, quality: "Not set", provenance: "—", status: "needs",
      banner: { kind: "warn", text: "Activity data required and no emission factor matched. This line is excluded from the total until resolved." },
      lineage: null,
    },
    {
      id: "elec", source: "Purchased electricity", scope: "2", scopeColor: "#FFC24B",
      activity: "312", unit: "MWh", factorSet: "DESNZ 2024 · v1.0", factorMatched: true,
      factorText: "DESNZ 2024 → UK grid · 0.308 kgCO₂e/kWh",
      tco2e: "96.1 tCO₂e", quality: "Measured", provenance: "Measured (primary)", status: "complete",
      banner: { kind: "ok", text: "Validated. Location-based factor applied; included in the total." },
      lineage: [
        { title: "Meter data imported", detail: "312 MWh" },
        { title: "Factor matched", detail: "DESNZ 2024 grid average" },
        { title: "Emissions computed", detail: "312,000 × 0.308 ÷ 1000 = 96.1" },
      ],
    },
    {
      id: "air", source: "Business travel — air", scope: "3.6", scopeColor: "#0BA75E",
      activity: null, unit: null, factorSet: "DEFRA 2024 · v1.2", factorMatched: true,
      factorText: "DEFRA 2024 → air travel (by haul & class) · awaiting activity",
      tco2e: null, quality: "Not set", provenance: "—", status: "needs",
      banner: { kind: "warn", text: "Activity data required. Factor set is selected but no distance/class data has been entered." },
      lineage: null,
    },
    {
      id: "freight", source: "Upstream freight — road", scope: "3.4", scopeColor: "#0BA75E",
      activity: "1,900,000", unit: "t·km", factorSet: "DEFRA 2024 · v1.2", factorMatched: true,
      factorText: "DEFRA 2024 → HGV average · 0.217 kgCO₂e/t·km",
      tco2e: "412.7 tCO₂e", quality: "Estimated", provenance: "Estimated (modelled)", status: "estimated",
      banner: { kind: "warn", text: "Estimated. Distance is modelled from spend; flag for primary data at next cycle." },
      lineage: [
        { title: "Spend mapped to distance", detail: "modelled t·km" },
        { title: "Factor matched", detail: "DEFRA 2024 HGV avg" },
        { title: "Emissions computed", detail: "1.9M × 0.217 ÷ 1000 = 412.7" },
      ],
    },
    {
      id: "spend", source: "Purchased goods — spend", scope: "3.1", scopeColor: "#0BA75E",
      activity: "4,100,000", unit: "GBP", factorSet: "CEDA 2025 · v1.0", factorMatched: true,
      factorText: "CEDA 2025 → sector average · 0.167 kgCO₂e/£",
      tco2e: "686.3 tCO₂e", quality: "Spend-based", provenance: "Spend-based (proxy)", status: "estimated",
      banner: { kind: "warn", text: "Spend-based proxy. Lower data quality; suitable for screening, flag material suppliers." },
      lineage: [
        { title: "Ledger spend imported", detail: "£4.1M" },
        { title: "Factor matched", detail: "CEDA 2025 sector avg" },
        { title: "Emissions computed", detail: "4.1M × 0.167 ÷ 1000 = 686.3" },
      ],
    },
    {
      id: "commute", source: "Employee commuting", scope: "3.7", scopeColor: "#0BA75E",
      activity: "210", unit: "staff", factorSet: "DEFRA 2024 · v1.2", factorMatched: true,
      factorText: "DEFRA 2024 → blended modal · survey weighted",
      tco2e: "74.8 tCO₂e", quality: "Survey", provenance: "Survey", status: "complete",
      banner: { kind: "ok", text: "Validated from staff survey; included in the total." },
      lineage: [
        { title: "Survey responses imported", detail: "210 staff" },
        { title: "Modal split applied", detail: "car / rail / bus" },
        { title: "Emissions computed", detail: "= 74.8" },
      ],
    },
    {
      id: "waste", source: "Waste — landfill", scope: "3.5", scopeColor: "#0BA75E",
      activity: "12", unit: "tonnes", factorSet: "DEFRA 2024 · v1.2", factorMatched: true,
      factorText: "DEFRA 2024 → landfill mixed · 0.175 tCO₂e/t",
      tco2e: "2.1 tCO₂e", quality: "Estimated", provenance: "Estimated", status: "complete",
      banner: { kind: "ok", text: "Validated; included in the total." },
      lineage: [
        { title: "Waste transfer notes", detail: "12 t" },
        { title: "Factor matched", detail: "DEFRA 2024 landfill" },
        { title: "Emissions computed", detail: "= 2.1" },
      ],
    },
  ],
};

export const statusClass: Record<RowStatus, string> = {
  complete: "done",
  needs: "need",
  estimated: "est",
};

export const statusLabel: Record<RowStatus, string> = {
  complete: "Complete",
  needs: "Needs data",
  estimated: "Estimated",
};
