import { isReportGap, reportTokenCatalogue, type ReportComposition } from "@nzi/contracts";
import { dd, employeesOf, f1, pc, reportingYearLabel, siteCount, targetPoints, yearLabel } from "./composed5Helpers";

/**
 * B2-4 (`composed@6`; RULING-report-studio-B2-4): a narrative body's tokens, resolved from the **frozen composition** at draw — so a
 * published report shows the figures it froze, and a body never holds a typed number. Each token prints exactly what composed@5's
 * template prints in its place (the same helpers, `composed5Helpers.ts`), so the catalogue default — composed@5's wording — draws
 * word for word as composed@5 does, and "Reset" returns what the report shows.
 *
 * A figure token is a locked chip. A phrase token is a clause composed@5 says only when the data holds it (a baseline, sites, a
 * net zero target): its text, its own figures still chips — or nothing; a paragraph a phrase leaves empty is not drawn.
 */
export type ComposedToken = { ok: true; kind: "figure" | "phrase"; html: string; text: string; label: string } | { ok: false; label: string; reason: string };

const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const chip = (value: string) => `<span class="r5-tok">${escape(value)}</span>`;
const LABEL = new Map(reportTokenCatalogue.map((token) => [token.key as string, token.label]));

/** Resolve one token against a composition. Never a guess: a figure the composition does not hold is unresolved, with the reason. */
export function resolveComposedToken(key: string, composition: ReportComposition): ComposedToken {
  const label = LABEL.get(key) ?? key;
  const figure = (value: string): ComposedToken => ({ ok: true, kind: "figure", html: chip(value), text: value, label });
  const phrase = (html: string, text: string): ComposedToken => ({ ok: true, kind: "phrase", html, text, label });
  const missing = (reason: string): ComposedToken => ({ ok: false, label, reason });
  if (!LABEL.has(key)) return missing(`"${key}" is not a report figure.`);

  const emissions = isReportGap(composition.emissions) ? null : composition.emissions;
  const by = new Map((emissions?.byScope ?? []).map((entry) => [entry.scope, entry.tco2e]));
  const scopes = (["1", "2", "3"] as const).map((scope) => ({ label: `Scope ${scope}`, value: by.get(scope) ?? 0 }));
  const ranked = [...scopes].sort((a, b) => b.value - a.value);
  const total = emissions?.totalTco2e ?? null;
  const points = targetPoints(composition);
  const intensity = isReportGap(composition.intensity) ? null : composition.intensity;
  const reported = intensity?.metrics.find((metric) => metric.reported) ?? null;
  const strategies = isReportGap(composition.plan) ? null : composition.plan.groups.flatMap((group) => group.strategies);
  const noEmissions = () => missing(isReportGap(composition.emissions) ? composition.emissions.reason : "Emissions are unavailable for this report.");
  const tonnes = (value: number) => `${f1(value)} tCO₂e`;
  const nth = (index: 0 | 1 | 2, part: "scope" | "total" | "pct"): ComposedToken => {
    if (total === null) return noEmissions();
    const scope = ranked[index]!;
    return part === "scope" ? phrase(escape(scope.label), scope.label) : part === "total" ? figure(tonnes(scope.value)) : figure(`${pc(scope.value, total)}%`);
  };

  switch (key) {
    case "client": return figure(composition.client);
    case "total": return total === null ? noEmissions() : figure(tonnes(total));
    case "scope1": case "scope2": case "scope3": return total === null ? noEmissions() : figure(tonnes(by.get(key.slice(-1)) ?? 0));
    case "scope1Pct": case "scope2Pct": case "scope3Pct": return total === null ? noEmissions() : figure(`${pc(by.get(key.slice(5, 6)) ?? 0, total)}%`);
    case "reportingYear": return figure(reportingYearLabel(composition));
    case "reportingPeriod": return composition.reportingPeriod ? figure(`${dd(composition.reportingPeriod.from)} – ${dd(composition.reportingPeriod.to)}`) : missing("This report holds no reporting period.");
    case "siteCount": { const sites = siteCount(composition); return figure(`${sites} site${sites === 1 ? "" : "s"}`); }
    case "employees": { const employees = employeesOf(composition); return employees ? figure(employees) : missing("This report holds no employees measure."); }
    case "netZeroYear": return points?.netZero ? figure(String(points.netZero.year)) : missing("No net zero target was set for this client when the report was issued.");
    case "interimYear": return points?.interim ? figure(String(points.interim.year)) : missing("No interim target was set for this client when the report was issued.");
    case "interimReductionPct": return points?.interim ? figure(`${points.interim.pct}%`) : missing("No interim target was set for this client when the report was issued.");
    case "baselineYear": return points?.benchmark ? figure(yearLabel(composition, points.benchmark.year)) : missing("No baseline was set for this client when the report was issued.");
    case "baselineTotal": return points?.benchmark ? figure(tonnes(points.benchmark.totalTco2e)) : missing("No baseline was set for this client when the report was issued.");
    case "intensityValue": return reported && reported.value !== null ? figure(f1(reported.value)) : missing("This report holds no reported intensity figure.");
    case "intensityUnit": return reported ? figure(reported.unit) : missing("This report holds no reported intensity measure.");
    case "intensityMeasures": {
      if (!intensity || intensity.metrics.length === 0) return missing("No intensity measures were set up for this client when the report was issued.");
      const text = `${intensity.metrics.length === 1 ? "one intensity measure" : `${intensity.metrics.length} intensity measures`}: ${intensity.metrics.map((metric) => metric.label.toLowerCase()).join(", ")}`;
      return phrase(escape(text), text);
    }
    case "largestScope": return nth(0, "scope");
    case "largestTotal": return nth(0, "total");
    case "largestPct": return nth(0, "pct");
    case "secondScope": return nth(1, "scope");
    case "secondTotal": return nth(1, "total");
    case "thirdScope": return nth(2, "scope");
    case "thirdTotal": return nth(2, "total");
    case "actionCount": return strategies ? figure(String(strategies.length)) : missing(isReportGap(composition.plan) ? composition.plan.reason : "This report holds no plan.");
    case "actionsPlural": return strategies ? phrase(strategies.length === 1 ? "" : "s", strategies.length === 1 ? "" : "s") : missing("This report holds no plan.");
    // The clauses composed@5 says only when the data holds them — and the same words, figures locked, when it does.
    case "baselineAnchor": {
      if (!points?.benchmark) return phrase("", "");
      const year = yearLabel(composition, points.benchmark.year);
      return phrase(` anchored to the client&#x27;s ${chip(year)} baseline set in its targets`, ` anchored to the client's ${year} baseline set in its targets`);
    }
    case "siteClause": {
      const sites = siteCount(composition);
      if (sites === 0) return phrase("", "");
      const count = `${sites} site${sites === 1 ? "" : "s"}`;
      return phrase(`, across ${chip(count)} in its reporting boundary`, `, across ${count} in its reporting boundary`);
    }
    case "actionsTarget":
      return total === null ? phrase("", "") : phrase(` and targeted at the categories that drive its ${chip(tonnes(total))} emissions`, ` and targeted at the categories that drive its ${tonnes(total)} emissions`);
    case "progressReview": {
      if (!points?.netZero) return phrase("", "");
      const interim = points.interim ? `−${points.interim.pct}% by ${points.interim.year}` : null;
      return phrase(`Progress is reviewed at least annually alongside the recalculated emissions${interim ? `, on the pathway to ${chip(interim)}` : ""} and net zero by ${chip(String(points.netZero.year))}.`,
        `Progress is reviewed at least annually alongside the recalculated emissions${interim ? `, on the pathway to ${interim}` : ""} and net zero by ${points.netZero.year}.`);
    }
    default: return missing("Unhandled token.");
  }
}

const TOKEN = /<span\b[^>]*\bdata-token="([^"]*)"[^>]*>[\s\S]*?<\/span>/g;

/**
 * A frozen body, drawn: each token replaced by what it resolves to — a figure's chip, a phrase's clause, or a marked gap ("—", with
 * its reason) — and any paragraph left empty dropped. The prose around the tokens is the body's own, untouched.
 */
export function drawNarrativeBody(bodyHtml: string, composition: ReportComposition): string {
  return bodyHtml
    .replace(TOKEN, (_match, key: string) => {
      const token = resolveComposedToken(key, composition);
      return token.ok ? token.html : `<span class="r5-tok r5-tok-missing" title="${escape(`${token.label}: ${token.reason}`)}">—</span>`;
    })
    .replace(/<p>\s*<\/p>/g, "");
}

/**
 * The body as the studio's editor shows it: each token a locked, non-editable span keeping its key — a figure as its chip, a
 * phrase as its plain words (no nested chip, so `serializeReportSectionBody` collapses it back to the bare key exactly), a gap as
 * "—". Typing goes around them; the stored body never holds a resolved number.
 */
export function narrativeForEditing(bodyHtml: string, composition: ReportComposition): string {
  return bodyHtml.replace(TOKEN, (_match, key: string) => {
    const token = resolveComposedToken(key, composition);
    if (!token.ok) return `<span class="r5-tok r5-tok-missing" data-token="${escape(key)}" contenteditable="false" title="${escape(`${token.label}: ${token.reason}`)}">—</span>`;
    return token.kind === "figure"
      ? `<span class="r5-tok" data-token="${escape(key)}" contenteditable="false" title="${escape(token.label)}">${escape(token.text)}</span>`
      : `<span class="r5-phrase" data-token="${escape(key)}" contenteditable="false" title="${escape(token.label)}">${escape(token.text)}</span>`;
  });
}

/** Every token a body uses that this composition cannot resolve — what the studio's draft says before validate. */
export function unresolvedNarrativeTokens(bodyHtml: string, composition: ReportComposition): Array<{ key: string; label: string; reason: string }> {
  return [...bodyHtml.matchAll(TOKEN)].map((match) => ({ key: match[1]!, token: resolveComposedToken(match[1]!, composition) }))
    .flatMap(({ key, token }) => token.ok ? [] : [{ key, label: token.label, reason: token.reason }]);
}
