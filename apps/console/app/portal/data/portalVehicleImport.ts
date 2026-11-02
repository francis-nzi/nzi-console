// Portal bulk import — Company Vehicles (BRIEF-portal-data-entry-parity #3, kind 3). Pure: the CRM's own vehicle template reader and
// resolver (`vehicleTemplate.ts`, not a copy) and the step from a resolved vehicle to the one pending row the portal files for it.
//
// As the CRM: the factor comes from type · size · fuel and the unit; a name or registration tells vehicles apart; the plate goes only to the
// sealed asset identifier (never a label, never a note) — and, for a client that holds no registrations, the name does. As travel and
// commuting, the portal files each vehicle as a scope row of its own rather than the CRM's staff-register source.
import { parseVehicleFactorLabel, type FactorOption, type PortalScopeRowFields } from "@nzi/contracts";
import { parseVehicleTemplate, resolveVehicleTemplateRow, vehicleRowBlocking, vehicleTemplateCsv, type ResolvedVehicleRow, type VehicleTemplateRow } from "../../jobs/vehicleTemplate";

export type PortalVehicleFactor = { id: string; label: string; unit: string; datasetId: string; datasetVersion: string | null };

/** The job's Scope 1 dataset factors, in the library's own words — what type · size · fuel is resolved against (as the CRM's). */
export function vehicleFactorOptions(factors: readonly FactorOption[]): PortalVehicleFactor[] {
  return factors.filter((factor) => factor.scopes.includes("1") && factor.factorSource === "dataset" && factor.datasetId)
    .map((factor) => ({ id: factor.factorId, label: factor.label, unit: factor.activityUnit, datasetId: factor.datasetId!, datasetVersion: factor.datasetVersion ?? null }));
}

export type PortalVehicleLine = { row: VehicleTemplateRow; resolved: ResolvedVehicleRow; ready: boolean; issues: string[] };

/**
 * The preview: every row of the filled template, resolved by the CRM's resolver. A row with only a registration is not resolved here — the
 * portal's lookup never hands a factor to the client — so it says to add that vehicle from the drawer, where the lookup is.
 */
export function previewPortalVehicles(text: string, months: readonly string[], factors: readonly PortalVehicleFactor[], sites: ReadonlyArray<{ id: string; name: string }>, optedOut: boolean):
  { missing: string[]; lines: PortalVehicleLine[] } {
  const parsed = parseVehicleTemplate(text, months);
  if (parsed.missing.length) return { missing: parsed.missing, lines: [] };
  const lines = parsed.rows.map((row): PortalVehicleLine => {
    const resolved = resolveVehicleTemplateRow(row, factors, sites, optedOut);
    const issues = [...vehicleRowBlocking(resolved), ...(resolved.needsLookup ? ["Give the vehicle's type, size and fuel — a registration alone can't be looked up from a file here. Or add it from the Add entry drawer."] : [])]
      .filter((issue, index, all) => all.indexOf(issue) === index);
    return { row, resolved, issues, ready: resolved.option !== null && resolved.quantity !== null && issues.length === 0 };
  });
  return { missing: [], lines };
}

/** One resolved, ready vehicle as the row the portal files: the create command's own fields, nothing staff-only. */
export function portalVehicleRow(line: PortalVehicleLine, optedOut: boolean): PortalScopeRowFields {
  const { row, resolved } = line;
  const option = resolved.option as PortalVehicleFactor;
  const read = parseVehicleFactorLabel(option.label);
  return {
    scope: "1", categoryCode: "1.company-vehicles", siteId: resolved.siteId,
    // The vehicle's name, never its plate; the plate goes only to the sealed identifier — or, opted out, the name does.
    sourceLabel: row.name || ["Company vehicle", read?.size, read?.fuel].filter(Boolean).join(" · "),
    assetIdentifier: optedOut ? row.name || null : row.registration || null,
    // Months, when given, are the whole reporting period in order (the write requires it) and total to the quantity.
    quantity: resolved.monthly.length ? null : resolved.quantity, unit: option.unit, monthlyActivity: resolved.monthly,
    datasetId: option.datasetId, factorId: option.id, factorVersion: option.datasetVersion, factorLabel: option.label,
    notes: "Company vehicles template import",
  } as PortalScopeRowFields;
}

export const portalVehicleTemplateCsv = vehicleTemplateCsv;
/** The template's file name: the category and the reporting period it was issued for. */
export const portalVehicleTemplateName = (months: readonly string[]) =>
  months.length ? `Company Vehicles template ${months[0]} to ${months[months.length - 1]}.csv` : "Company Vehicles template.csv";
