// B2-2 (REVIEW-B2-1-and-B2-rulings): the Report Studio's draft is read with the plan and scope the rail has chosen, carried in
// the URL so a draft is a link like any other read. One encoding, shared by the studio and the route, so they cannot disagree.
// A value that does not parse reads as "nothing asked" — validate's own fallbacks (the client's profile, else the default; the
// whole client) then apply — never as a guessed plan.
import { isReportDataSection, isReportNarrativeSection, type ReportPlanSectionKey, type ReportSectionPlan } from "./reportComposition";
import type { ReportScope } from "./reportScope";

/** "cover:1,executive-summary:1,…": every plan entry, in order, with 1 (in) or 0 (out). */
export const encodeStudioPlan = (plan: ReportSectionPlan): string => plan.map((entry) => `${entry.key}:${entry.included ? 1 : 0}`).join(",");

export function decodeStudioPlan(value: string | null | undefined): ReportSectionPlan | null {
  if (!value) return null;
  const entries = value.split(",").map((part) => {
    const at = part.lastIndexOf(":"), key = part.slice(0, at), flag = part.slice(at + 1);
    return at > 0 && (flag === "1" || flag === "0") && (isReportDataSection(key) || isReportNarrativeSection(key)) ? { key: key as ReportPlanSectionKey, included: flag === "1" } : null;
  });
  return entries.length > 0 && entries.every((entry) => entry !== null) ? entries as ReportSectionPlan : null;
}

/** "whole", or "sites:a,b". */
export const encodeStudioScope = (scope: ReportScope): string => scope.kind === "whole" ? "whole" : `sites:${scope.siteIds.join(",")}`;

export function decodeStudioScope(value: string | null | undefined): ReportScope | null {
  if (!value) return null;
  if (value === "whole") return { kind: "whole" };
  if (!value.startsWith("sites:")) return null;
  return { kind: "sites", siteIds: value.slice("sites:".length).split(",").map((id) => id.trim()).filter(Boolean) };
}
