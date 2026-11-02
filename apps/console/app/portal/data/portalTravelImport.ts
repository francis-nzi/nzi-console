// Portal bulk import — Business Travel (BRIEF-portal-data-entry-parity #3, kind 1). Pure: the CRM's own template reader and resolver
// (`travelTemplate.ts`, not a copy), and the step from a resolved trip to the one row the portal files for it.
//
// The CRM files each mode-and-factor as a roll-up *source group* — a staff register the client has no write to. The portal files the
// same resolved trip as a scope row of its own (a pending, client-provenanced row, exactly what the Add-entry drawer files), so the
// client's trips are visible to them one by one and staff review them as they review any client entry. What a trip *resolves to* —
// mode, haul, class, factor, quantity in the factor's unit, site, date — is the CRM adapter's output, unchanged.
import type { FactorOption, PortalScopeRowFields } from "@nzi/contracts";
import { travelModeLabel } from "@nzi/contracts";
import { parseTravelTemplate, resolveTravelTemplateRow, travelSourceName, type ResolvedTravelRow, type TravelTemplateRow } from "../../jobs/travelTemplate";

export type PortalTravelFactor = { id: string; label: string; unit: string; datasetId: string; datasetVersion: string | null };

/** The job's Scope 3 dataset factors, in the library's own words — what a mode, haul and class are resolved against (as the CRM's). */
export function travelFactorOptions(factors: readonly FactorOption[]): PortalTravelFactor[] {
  return factors.filter((factor) => factor.scopes.includes("3") && factor.factorSource === "dataset" && factor.datasetId)
    .map((factor) => ({ id: factor.factorId, label: factor.label, unit: factor.activityUnit, datasetId: factor.datasetId!, datasetVersion: factor.datasetVersion ?? null }));
}

export type PortalTravelLine = { row: TravelTemplateRow; resolved: ResolvedTravelRow; ready: boolean; issues: string[] };

/**
 * The preview: every row of the filled template, resolved by the CRM's resolver. A grey-fleet trip given only a registration is not
 * resolved here — the portal's lookup never hands a factor to the client — so it says to enter that trip in the drawer.
 */
export function previewPortalTravel(text: string, factors: readonly PortalTravelFactor[], sites: ReadonlyArray<{ id: string; name: string }>):
  { missing: string[]; lines: PortalTravelLine[] } {
  const parsed = parseTravelTemplate(text);
  if (parsed.missing.length) return { missing: parsed.missing, lines: [] };
  const lines = parsed.rows.map((row): PortalTravelLine => {
    const resolved = resolveTravelTemplateRow(row, factors, sites);
    const issues = [...resolved.issues, ...(resolved.needsLookup ? ["A registration can't be read from a file here — add this trip from the Add entry drawer."] : [])];
    return { row, resolved, issues, ready: resolved.option !== null && resolved.quantity !== null && issues.length === 0 };
  });
  return { missing: [], lines };
}

/** One resolved, ready trip as the row the portal files: the create command's own fields, nothing staff-only, no plate, no name. */
export function portalTravelRow(line: PortalTravelLine): PortalScopeRowFields {
  const { row, resolved } = line;
  const option = resolved.option as PortalTravelFactor;
  const mode = travelModeLabel({ travelMode: resolved.mode, airHaul: resolved.haul, cabinClass: resolved.cabinClass });
  const notes = [mode, resolved.tripDate, row.passengers && row.passengers > 1 ? `${row.passengers} passengers` : "", "Business travel template import"].filter(Boolean).join(" · ");
  return {
    scope: "3.6", categoryCode: "3.6", sourceLabel: travelSourceName(row, resolved), siteId: resolved.siteId,
    quantity: resolved.quantity, unit: option.unit, monthlyActivity: [],
    datasetId: option.datasetId, factorId: option.id, factorVersion: option.datasetVersion, factorLabel: option.label,
    notes,
  } as PortalScopeRowFields;
}

/** The template's file name: the category and the reporting period it was issued for. */
export const portalTravelTemplateName = (months: readonly string[]) =>
  months.length ? `Business Travel template ${months[0]} to ${months[months.length - 1]}.csv` : "Business Travel template.csv";
