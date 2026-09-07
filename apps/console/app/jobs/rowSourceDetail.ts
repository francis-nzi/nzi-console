// The "Source detail" section of the reworked row-detail drawer (data-entry UX
// review item 2). It adapts to the row type: a vehicle row shows the vehicle
// record (reg / make / model / fuel); a spend / PG&S row shows the ledger
// detail (net / VAT / GL code / PG&S category / invoice ref). This is how the
// PG&S complexity becomes one tucked-away, type-specific section instead of
// noise on every row.
//
// Read-only display only — the values come from `provenance.detail` /
// `provenance.spendDetail`, frozen when the row was synced from the register or
// the client portal. The editable scope-row fields (source label, report
// label, PG&S category, reference) are rendered alongside by the drawer.
import type { ScopeRowReadModel } from "@nzi/contracts";

export type SourceDetailKind = "vehicle" | "spend" | "travel" | "generic";
export type SourceDetailField = { label: string; value: string };
export type RowSourceDetail = { title: string; kind: SourceDetailKind; fields: SourceDetailField[] };

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

const text = (value: unknown): string | null => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  return String(value).trim() || null;
};

const compact = (pairs: Array<[string, string | null | undefined]>): SourceDetailField[] =>
  pairs.filter((pair): pair is [string, string] => text(pair[1]) !== null).map(([label, value]) => ({ label, value: text(value)! }));

export function rowSourceDetail(row: ScopeRowReadModel): RowSourceDetail {
  const provenance = asRecord(row.provenance);
  const detail = asRecord(provenance.detail ?? provenance.spendDetail);
  const detailKind = typeof detail.kind === "string" ? detail.kind : null;

  if (detailKind === "vehicle" || row.categoryCode === "1.company-vehicles") {
    return {
      title: "Vehicle detail",
      kind: "vehicle",
      fields: compact([
        ["Registration", text(detail.vehicleRegistration) ?? row.assetIdentifier],
        ["Make", text(detail.make)],
        ["Model", text(detail.model)],
        ["Fuel", text(detail.fuel)],
      ]),
    };
  }

  if (detailKind === "travel" || row.categoryCode === "3.6") {
    const leg = [text(detail.origin), text(detail.destination)].filter(Boolean).join(" → ");
    return {
      title: "Travel detail",
      kind: "travel",
      fields: compact([
        ["Mode", text(detail.travelMode)],
        ["Leg", leg || null],
        ["Carrier", text(detail.carrier)],
        ["Passengers", text(detail.passengers)],
        ["Traveller / ref", row.assetIdentifier],
      ]),
    };
  }

  if (detailKind === "spend" || row.scope === "3.1" || row.categoryCode === "3.1") {
    return {
      title: "Spend detail (PG&S)",
      kind: "spend",
      fields: compact([
        ["Net value", text(detail.netValue)],
        ["VAT %", text(detail.vatPercent)],
        ["GL code", text(detail.glCode)],
        ["PG&S category", row.purchasedGoodsCategoryLabel ?? text(detail.category)],
        ["Invoice date / reference", row.assetIdentifier],
      ]),
    };
  }

  return {
    title: "Source detail",
    kind: "generic",
    fields: compact([
      ["ID / reference", row.assetIdentifier],
      ["Report column heading", row.columnText],
    ]),
  };
}
