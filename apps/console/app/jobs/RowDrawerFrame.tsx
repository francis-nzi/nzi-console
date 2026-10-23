// The row drawer's frame, shared by the CRM's Editor and the client portal's row drawer (BUILD-portal-data-crm-parity R1, R4):
// the calculation banner and the seven key fields (data-entry UX review item 2), lifted out of the CRM Editor unchanged so both
// drawers draw one layout. Presentational only — what is editable is the caller's: the CRM passes its Quantity input, the portal
// a read-only figure. Each caller supplies its own words for the banner.
import type { ReactNode } from "react";
import { crpScopeCategoryPath } from "@nzi/contracts";

export function RowCalcBanner({ calculated, pending, done }: { calculated: boolean; pending: ReactNode; done: ReactNode }) {
  return <div className={`nz-banner ${calculated ? "ok" : "warn"}`}>{calculated ? done : pending}</div>;
}

/** The row's figure as both drawers show it: an override beats a calculation, as everywhere else. */
export const rowDisplayTco2e = (row: { overrideTco2e: number | null; calculatedTco2e: number | null }) => row.overrideTco2e ?? row.calculatedTco2e;

export function RowKeyFields({ siteLabel, scope, category, reportLabel, quantity, unit, tco2e }: {
  siteLabel: string | null; scope: string; category: string; reportLabel: string;
  /** The Quantity cell: an editor (the CRM's input) or, given a plain value, a read-only figure. */
  quantity: { edit: ReactNode } | { value: ReactNode };
  unit: string | null; tco2e: number | null;
}) {
  return (
    <div className="nz-rd-keys">
      <div className="kv"><span className="l">Site</span><span className="v">{siteLabel ?? "Unallocated"}</span></div>
      <div className="kv"><span className="l">Scope</span><span className="v">{crpScopeCategoryPath(scope).join(" › ")}</span></div>
      <div className="kv"><span className="l">Category</span><span className="v">{category}</span></div>
      <div className="kv"><span className="l">Report label</span><span className="v">{reportLabel}</span></div>
      {"edit" in quantity
        ? <label className="kv edit"><span className="l">Quantity</span>{quantity.edit}</label>
        : <div className="kv"><span className="l">Quantity</span><span className="v">{quantity.value}</span></div>}
      <div className="kv"><span className="l">UoM</span><span className="v">{unit ?? "—"}</span></div>
      <div className="kv"><span className="l">tCO₂e</span><span className="v co2">{tco2e === null ? "—" : tco2e.toLocaleString("en-GB", { maximumFractionDigits: 3 })}</span></div>
    </div>
  );
}
