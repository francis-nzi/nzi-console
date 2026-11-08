// Portal bulk import — Employee Commuting (BRIEF-portal-data-entry-parity #3, kind 2). Pure: the CRM's own commuting reader and mode matcher
// (`commutingBulk.ts`, not a copy) and the step from a confirmed line to the one pending row the portal files for it.
//
// As the CRM: the Employee column only lines a file up and is never kept or sent — a commuter is "Commuter n · mode" (D6 R2a). The mode is
// one of the controlled list; the factor is chosen per line (pre-filled with the category's declared factor, as the Add-entry drawer is).
// As travel, the portal files each commuter as a scope row of its own rather than the CRM's staff-register source.
import { COMMUTE_MODES, commuterLabel, type FactorOption, type PortalScopeRowFields } from "@nzi/contracts";
import { matchCommuteMode, parseCommutingLedger } from "../../jobs/commutingBulk";
import type { EntryFactorRef } from "../../jobs/emissionEntryModel";

/** Headers only — no example rows, so nothing invented is imported by being left in (the travel template's discipline). */
export const PORTAL_COMMUTING_COLUMNS = ["Employee", "Commute mode", "Distance per year", "Distance unit", "WFH days per year", "WFH hours per day"] as const;
export const portalCommutingTemplateCsv = () => PORTAL_COMMUTING_COLUMNS.map((header) => `"${header}"`).join(",") + "\r\n";
export const portalCommutingTemplateName = (months: readonly string[]) =>
  months.length ? `Employee Commuting template ${months[0]} to ${months[months.length - 1]}.csv` : "Employee Commuting template.csv";

export type PortalCommutingLine = {
  rowNumber: number; mode: string; distance: number | null; distanceUnit: "km" | "mi"; wfhDaysPerYear: number | null; wfhHoursPerDay: number | null;
  /** What stops the line before a factor is chosen. */
  issues: string[];
};

/** The file's lines, by the CRM's reader. The employee name is read for nothing here and is not returned. */
export function previewPortalCommuting(text: string): { lines: PortalCommutingLine[]; looksLikeTemplate: boolean } {
  const first = text.split(/\r?\n/).find((line) => line.trim() !== "") ?? "";
  const looksLikeTemplate = /commute mode|mode/i.test(first) && /distance/i.test(first);
  const lines = parseCommutingLedger(text).map((line, index): PortalCommutingLine => {
    const mode = matchCommuteMode(line.mode) ?? line.mode;
    const issues: string[] = [];
    if (!COMMUTE_MODES.includes(mode)) issues.push(mode ? `Mode "${mode}" is not one of the commute modes.` : "Give the commute mode.");
    if (line.distance === null) issues.push("Give the distance per year.");
    else if (line.distance < 0) issues.push("The distance cannot be negative.");
    if (line.wfhDaysPerYear !== null && (line.wfhDaysPerYear < 0 || line.wfhDaysPerYear > 366)) issues.push("WFH days is between 0 and 366.");
    if (line.wfhHoursPerDay !== null && (line.wfhHoursPerDay < 0 || line.wfhHoursPerDay > 24)) issues.push("WFH hours is between 0 and 24.");
    return { rowNumber: index + 1, mode, distance: line.distance, distanceUnit: line.distanceUnit, wfhDaysPerYear: line.wfhDaysPerYear, wfhHoursPerDay: line.wfhHoursPerDay, issues };
  });
  return { lines, looksLikeTemplate };
}

/** A line is ready when it has no issue of its own and a factor has been chosen — the CRM grid's own rule. */
export const commutingLineReady = (line: PortalCommutingLine, factor: EntryFactorRef | null) => line.issues.length === 0 && factor !== null;

/** One ready line as the row the portal files: the create command's own fields, no name, no staff-only field. */
export function portalCommutingRow(line: PortalCommutingLine, ordinal: number, factor: EntryFactorRef, sources: readonly FactorOption[], siteId: string | null = null): PortalScopeRowFields {
  const source = sources.find((candidate) => candidate.factorId === factor.factorId && candidate.datasetId === factor.datasetId);
  const wfh = line.wfhDaysPerYear !== null || line.wfhHoursPerDay !== null
    ? `Working from home: ${line.wfhDaysPerYear ?? "—"} days a year, ${line.wfhHoursPerDay ?? "—"} hours a day` : "";
  return {
    scope: "3.7", categoryCode: "3.7", sourceLabel: commuterLabel(ordinal, line.mode), siteId,
    quantity: line.distance, unit: line.distanceUnit === "mi" ? "mi" : "km", monthlyActivity: [],
    datasetId: factor.datasetId ?? null, factorId: factor.factorId ?? null, factorVersion: factor.datasetVersion ?? null, factorLabel: source?.label ?? factor.label,
    notes: [wfh, "Commuting template import"].filter(Boolean).join(" · "),
  } as PortalScopeRowFields;
}
