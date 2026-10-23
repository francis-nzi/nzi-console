// Insights (BUILD-portal-shell-lookandfeel, Support): plain-language observations drawn from the job's assured figures — the
// dashboard's own (`PortalAssuredDashboard`), never a new metric — each saying where it comes from. Pure, so tested. The
// mockup's grounded assistant and knowledge library are staff-side today; the view says so rather than imitating them.
import type { PortalAssuredDashboard } from "@nzi/contracts";

export type Insight = { id: string; title: string; detail: string };
type Published = Extract<PortalAssuredDashboard, { published: true }>;

const share = (part: number, whole: number) => whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;
const tonnes = (value: number) => value.toLocaleString("en-GB", { maximumFractionDigits: value >= 100 ? 0 : 1 });
const SCOPE: Record<"1" | "2" | "3", string> = { "1": "Scope 1 (direct)", "2": "Scope 2 (purchased energy)", "3": "Scope 3 (value chain)" };

export function insightsFrom(dashboard: Published): Insight[] {
  const insights: Insight[] = [];
  const top = dashboard.byCategory[0];
  if (top && dashboard.total > 0) {
    insights.push({ id: "largest-category", title: "Your biggest reduction opportunity",
      detail: `${top.label} is ${share(top.tco2e, dashboard.total)}% of your emissions (${tonnes(top.tco2e)} tCO₂e) — the area where action has the most leverage.` });
  }
  const scopes = (["1", "2", "3"] as const).map((scope) => ({ scope, value: dashboard.byScope[scope] })).sort((a, b) => b.value - a.value);
  if (dashboard.total > 0 && scopes[0]!.value > 0) {
    insights.push({ id: "largest-scope", title: "Where your emissions sit",
      detail: `${SCOPE[scopes[0]!.scope]} makes up ${share(scopes[0]!.value, dashboard.total)}% of your ${tonnes(dashboard.total)} tCO₂e.` });
  }
  if (dashboard.target && dashboard.target.baselineTco2e > 0) {
    const change = share(dashboard.total - dashboard.target.baselineTco2e, dashboard.target.baselineTco2e);
    const interim = dashboard.target.interimReductionPercent;
    insights.push({ id: "against-baseline", title: "Against your baseline",
      detail: change <= 0
        ? `Down ${Math.abs(change)}% on your ${dashboard.target.baselineYear} baseline — your interim target is −${interim}% by ${dashboard.target.interimYear}.`
        : `Up ${change}% on your ${dashboard.target.baselineYear} baseline — your interim target is −${interim}% by ${dashboard.target.interimYear}.` });
  }
  const sites = dashboard.bySite.filter((site) => site.siteId !== null);
  if (sites.length > 1 && dashboard.total > 0) {
    insights.push({ id: "largest-site", title: "Your largest site",
      detail: `${sites[0]!.label} accounts for ${share(sites[0]!.tco2e, dashboard.total)}% of your emissions.` });
  }
  return insights;
}
