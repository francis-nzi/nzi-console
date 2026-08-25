import type { ReactNode } from "react";
import { AppShell, WorkspaceRail, TopBar } from "@nzi/ui";
import { clients, job712 } from "@nzi/mock-data";
import { loadFixtureScreen } from "@nzi/api-client";
import { hasData } from "@nzi/contracts";
import { NAV, USER } from "./lib/nav";
import { ScreenState } from "./lib/ScreenState";

function num(s: string | null): number {
  return s ? Number(s.replace(/[^0-9.]/g, "")) : 0;
}

function PanelHead({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", padding: "13px 16px", borderBottom: "1px solid var(--line2)" }}>
      <h2 style={{ fontSize: 14.5, fontWeight: 600, margin: 0 }}>{title}</h2>
      {right && <div style={{ marginLeft: "auto", fontSize: 12.5, color: "var(--t2)" }}>{right}</div>}
    </div>
  );
}

function Bar({ pct, color }: { pct: number; color: string }) {
  return (
    <span style={{ width: 74, height: 6, background: "#E7ECE9", borderRadius: 6, overflow: "hidden", display: "inline-block" }}>
      <span style={{ display: "block", height: "100%", width: `${pct}%`, background: color }} />
    </span>
  );
}

export default function ControlRoom() {
  const result = loadFixtureScreen("control", { clients, attentionJob: job712 });
  if (!hasData(result)) return <ScreenState result={result}>{() => null}</ScreenState>;
  const portfolio = clients.reduce((n, c) => n + num(c.latestFootprint), 0);
  const openJobs = clients.reduce((n, c) => n + c.openJobs, 0);
  const reportsDue = clients.filter((c) => /202|Overdue/.test(c.nextReportDue)).length;
  const avgCompleteness = Math.round(clients.reduce((n, c) => n + c.completeness, 0) / clients.length);

  const stages: Record<string, number> = {};
  clients.forEach((c) => c.jobs.forEach((j) => { stages[j.status] = (stages[j.status] ?? 0) + 1; }));
  const stageRows = Object.entries(stages).sort((a, b) => b[1] - a[1]);
  const stageMax = Math.max(...stageRows.map(([, n]) => n), 1);

  type Alert = { sev: "high" | "med" | "low"; text: string; meta: string };
  const alerts: Alert[] = [];
  clients.filter((c) => c.status === "at-risk").forEach((c) =>
    alerts.push({ sev: "high", text: `${c.name} — report ${c.nextReportDue.toLowerCase()}`, meta: "At risk" }));
  alerts.push({
    sev: "med",
    text: `Job ${job712.number} (${job712.client}) — ${job712.counts.needs} sources need data, 1 with no matched factor`,
    meta: "Data entry",
  });
  clients.filter((c) => c.status === "onboarding").forEach((c) =>
    alerts.push({ sev: "med", text: `${c.name} — onboarding baseline ${c.completeness}% complete`, meta: "Onboarding" }));
  clients.filter((c) => c.status === "active" && c.completeness < 80).forEach((c) =>
    alerts.push({ sev: "low", text: `${c.name} — data completeness ${c.completeness}%, below 80% target`, meta: "Data quality" }));

  const sevColor: Record<Alert["sev"], string> = { high: "var(--coral)", med: "var(--amber)", low: "#378ADD" };

  const upcoming = clients.filter((c) => /202|Overdue/.test(c.nextReportDue));
  const withData = clients.filter((c) => c.completeness > 0);

  const rail = <WorkspaceRail sections={NAV} activeId="control" user={USER} />;

  return (
    <AppShell rail={rail}>
      <TopBar
        searchPlaceholder="Search clients, jobs, factors…"
        crumbs={<><b>Control Room</b> <span className="muted">/</span> Portfolio overview</>}
      />

      <div className="nz-head">
        <h1>Control Room</h1>
        <div className="sub">Portfolio overview · all clients · reporting cycle 2024</div>
      </div>

      <div className="nz-body" style={{ paddingTop: 16 }}>
        <div className="nz-metrics">
          <div className="nz-metric"><div className="l">Portfolio emissions (reported)</div><div className="v num">{portfolio.toLocaleString()} <span style={{ fontSize: 13, color: "var(--t3)" }}>tCO₂e</span></div></div>
          <div className="nz-metric"><div className="l">Open jobs</div><div className="v num">{openJobs}</div></div>
          <div className="nz-metric"><div className="l">Reports due / overdue</div><div className="v num">{reportsDue}</div></div>
          <div className="nz-metric"><div className="l">Avg data completeness</div><div className="v num">{avgCompleteness}%</div></div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: 16, alignItems: "start" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div className="nz-panel">
              <PanelHead title="Needs attention" right={`${alerts.length} items`} />
              <div>
                {alerts.map((a, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 11, padding: "11px 16px", borderBottom: "1px solid var(--line2)" }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: sevColor[a.sev], flex: "none" }} />
                    <span style={{ fontSize: 13 }}>{a.text}</span>
                    <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--t2)", background: "var(--paper)", border: "1px solid var(--line)", padding: "2px 8px", borderRadius: 20, whiteSpace: "nowrap" }}>{a.meta}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="nz-panel">
              <PanelHead title="Jobs by stage" right={`${stageRows.reduce((n, [, c]) => n + c, 0)} jobs`} />
              <div style={{ padding: "6px 16px 12px" }}>
                {stageRows.map(([label, n]) => (
                  <div key={label} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 0", fontSize: 13 }}>
                    <span style={{ width: 150 }}>{label}</span>
                    <span style={{ flex: 1, height: 7, background: "#E7ECE9", borderRadius: 6, overflow: "hidden" }}>
                      <span style={{ display: "block", height: "100%", width: `${(n / stageMax) * 100}%`, background: "var(--emerald)" }} />
                    </span>
                    <span className="num" style={{ width: 22, textAlign: "right", color: "var(--t2)" }}>{n}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div className="nz-panel">
              <PanelHead title="Upcoming reports" />
              <div>
                {upcoming.map((c) => {
                  const overdue = /Overdue/.test(c.nextReportDue);
                  return (
                    <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", borderBottom: "1px solid var(--line2)" }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 500 }}>{c.name}</div>
                        <div style={{ fontSize: 11.5, color: "var(--t2)" }}>{c.nextReportDue}</div>
                      </div>
                      <span className={`nz-st ${overdue ? "nof" : "est"}`} style={{ marginLeft: "auto" }}>{overdue ? "Overdue" : "Due"}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="nz-panel">
              <PanelHead title="Data completeness" />
              <div style={{ padding: "6px 16px 12px" }}>
                {withData.map((c) => {
                  const color = c.completeness >= 85 ? "var(--emerald)" : c.completeness >= 50 ? "var(--amber)" : "var(--coral)";
                  return (
                    <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "7px 0", fontSize: 12.5 }}>
                      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
                      <Bar pct={c.completeness} color={color} />
                      <span className="num" style={{ width: 34, textAlign: "right", color: "var(--t2)" }}>{c.completeness}%</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
