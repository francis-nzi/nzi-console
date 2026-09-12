"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AppShell, WorkspaceRail, TopBar, EvidenceDrawer } from "@nzi/ui";
import { type Client, type ClientStatus, clientStatusMeta } from "@nzi/mock-data";
import { NAV, USER } from "../lib/nav";
import { crumbTrail, workspaceCrumbs } from "../lib/crumbTrail";

type Filter = "all" | ClientStatus;

function Completeness({ pct }: { pct: number }) {
  const color = pct >= 85 ? "var(--emerald)" : pct >= 50 ? "var(--amber)" : "var(--coral)";
  return (
    <span className="nz-client-completeness">
      <span role="progressbar" aria-label="Client data completeness" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <span style={{ display: "block", height: "100%", width: `${pct}%`, background: color }} />
      </span>
      <span className="num">{pct}%</span>
    </span>
  );
}

function ClientDrawer({ c }: { c: Client }) {
  const meta = clientStatusMeta[c.status];
  const banner =
    c.status === "at-risk"
      ? { kind: "warn" as const, text: "At risk — a report is overdue or data is stalled. Prioritise for outreach." }
      : c.status === "prospect"
      ? { kind: "warn" as const, text: "Prospect — proposal sent, not yet onboarded. No live engagement." }
      : c.status === "onboarding"
      ? { kind: "warn" as const, text: "Onboarding — baseline in progress; data still being collected." }
      : { kind: "ok" as const, text: "Active client — no relationship risk flag is recorded." };

  return (
    <>
      <div className={`nz-banner ${banner.kind}`}>
        <svg viewBox="0 0 24 24">
          {banner.kind === "ok" ? (
            <path d="M20 6L9 17l-5-5" />
          ) : (
            <>
              <path d="M12 9v4" />
              <path d="M12 17h.01" />
              <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
            </>
          )}
        </svg>
        <div>{banner.text}</div>
      </div>

      <div className="nz-kv"><span className="k">Account owner</span><span className="v">{c.owner}</span></div>
      <div className="nz-kv"><span className="k">Status</span><span className="v">{meta.label}</span></div>
      <div className="nz-kv"><span className="k">Member since</span><span className="v">{c.memberSince}</span></div>
      <div className="nz-kv"><span className="k">Latest footprint</span><span className="v">{c.latestFootprint ?? "—"}</span></div>
      <div className="nz-kv"><span className="k">Change vs prior year</span><span className="v">{c.yoy ?? "—"}</span></div>
      <div className="nz-kv"><span className="k">Data completeness</span><span className="v">{c.completeness}%</span></div>
      <div className="nz-kv"><span className="k">Open jobs</span><span className="v">{c.openJobs}</span></div>
      <div className="nz-kv"><span className="k">Next report due</span><span className="v">{c.nextReportDue}</span></div>

      <div className="nz-sect">Active jobs</div>
      {c.jobs.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--t3)" }}>No open jobs.</div>
      ) : (
        c.jobs.map((j) => (
          <div key={j.number} className="nz-kv">
            <span className="k">{j.number} · {j.year}</span>
            <span className="v">{j.status}</span>
          </div>
        ))
      )}

      <div className="nz-sect">Primary contact</div>
      <div className="nz-kv"><span className="k">{c.contact.name}</span><span className="v">{c.contact.role}</span></div>
      <div className="nz-kv"><span className="k">Email</span><span className="v" style={{ color: "var(--emerald)" }}>{c.contact.email}</span></div>
    </>
  );
}

export function ClientsBoard({ clients }: { clients: Client[] }) {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<string>(clients[0]?.id ?? "");
  const [filter, setFilter] = useState<Filter>("all");
  const rows = useMemo(
    () => (filter === "all" ? clients : clients.filter((c) => c.status === filter)),
    [clients, filter],
  );

  if (clients.length === 0) return <AppShell rail={<WorkspaceRail sections={NAV} activeId="clients" user={USER} />}><TopBar searchPlaceholder="Search clients…" crumbs={crumbTrail(workspaceCrumbs("Clients", "/clients"))} /><div className="nz-head"><div className="nz-eyebrow">Client intelligence</div><h1>Client portfolio</h1><div className="sub">Relationships, delivery health and reporting readiness</div></div><div className="nz-body nz-client-zero"><section><i>0</i><div><h2>No client records yet</h2><p>Create the first tenant-scoped client before opening jobs, portal access, or reporting workflows.</p><Link className="nz-btn pri" href="/clients/new">Add first client</Link></div></section></div></AppShell>;

  const selected = clients.find((c) => c.id === selectedId) ?? clients[0]!;

  const activeJobs = clients.reduce((n, c) => n + c.openJobs, 0);
  const avgCompleteness = Math.round(clients.reduce((n, c) => n + c.completeness, 0) / clients.length);
  const dueSoon = clients.filter((c) => /202|Overdue/.test(c.nextReportDue)).length;
  const atRisk = clients.filter((client) => client.status === "at-risk").length;
  const deliveryClients = clients.filter((client) => client.status !== "prospect");
  const ownershipComplete = clients.every((client) => client.owner.trim() && client.owner !== "Unassigned");
  const deliveryLinked = deliveryClients.length > 0 && deliveryClients.every((client) => client.jobs.length > 0);
  const footprintsRecorded = clients.filter((client) => client.status === "active").every((client) => Boolean(client.latestFootprint));

  const filters: { id: Filter; label: string }[] = [
    { id: "all", label: `All ${clients.length}` },
    { id: "active", label: "Active" },
    { id: "onboarding", label: "Onboarding" },
    { id: "at-risk", label: "At risk" },
    { id: "prospect", label: "Prospect" },
  ];

  const rail = <WorkspaceRail sections={NAV} activeId="clients" user={USER} />;

  const drawer = (
    <EvidenceDrawer
      kicker={`Client · ${clientStatusMeta[selected.status].label.toLowerCase()}`}
      title={selected.name}
      subtitle={`${selected.sector} · ${selected.location}`}
      actions={
        <>
          <button type="button" className="nz-btn" onClick={() => router.push(`/jobs?client=${selected.id}`)}>New job</button>
          <button type="button" className="nz-btn pri" onClick={() => router.push(`/clients/${selected.id}`)}>Open client</button>
        </>
      }
    >
      <ClientDrawer c={selected} />
    </EvidenceDrawer>
  );

  return (
    <AppShell rail={rail} drawer={drawer}>
      <TopBar
        searchPlaceholder="Search clients…"
        crumbs={crumbTrail(workspaceCrumbs("Clients", "/clients"))}
      />

      <div className="nz-head">
        <div className="nz-job-titleline">
          <div>
            <div className="nz-eyebrow">Client intelligence</div><h1>Client portfolio</h1>
            <div className="sub">Relationships, delivery health and reporting readiness across {clients.length} organisations</div>
          </div>
          <Link className="nz-btn pri" href="/clients/new">+ Add client</Link>
        </div>
      </div>

      <div className="nz-body" style={{ paddingTop: 16 }}>
        <section className="nz-ops-hero"><div><span className="nz-eyebrow light">Relationship command centre</span><h2>{atRisk?`${atRisk} relationship${atRisk===1?"":"s"} need focused attention.`:"No relationships are currently marked at risk."}</h2><p>Bring relationship context, reporting delivery and data readiness together before the next client conversation.</p></div><div className="nz-ops-trust"><span><i>{ownershipComplete?"✓":"·"}</i> Ownership assigned</span><span><i>{deliveryLinked?"✓":"·"}</i> Delivery records linked</span><span><i>{footprintsRecorded?"✓":"·"}</i> Active footprints recorded</span></div></section>
        <div className="nz-metrics">
          <div className="nz-metric"><div className="l">Clients</div><div className="v num">{clients.length}</div></div>
          <div className="nz-metric"><div className="l">Open jobs</div><div className="v num">{activeJobs}</div></div>
          <div className="nz-metric"><div className="l">Reports due / overdue</div><div className="v num">{dueSoon}</div></div>
          <div className="nz-metric"><div className="l">Avg data completeness</div><div className="v num">{avgCompleteness}%</div></div>
        </div>

        <div className="nz-toolbar" style={{ padding: "0 0 12px" }}>
          <div className="nz-filters">
            {filters.map((f) => (
              <button type="button" key={f.id} aria-pressed={filter===f.id} className={filter === f.id ? "on" : undefined} onClick={() => setFilter(f.id)}>
                {f.label}
              </button>
            ))}
          </div>
        </div>

        <div className="nz-panel nz-client-table">
          <table className="nz-tbl">
            <thead>
              <tr>
                <th>Client</th><th>Sector</th><th>Status</th><th className="num">Latest tCO₂e</th>
                <th>Data completeness</th><th className="num">Open jobs</th><th>Next report</th><th>Owner</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const meta = clientStatusMeta[c.status];
                return (
                  <tr
                    key={c.id}
                    className={`row${c.id === selectedId ? " sel" : ""}`}
                    onClick={() => setSelectedId(c.id)}
                    onDoubleClick={() => router.push(`/clients/${c.id}`)}
                    onKeyDown={(event)=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();setSelectedId(c.id)}}}
                    tabIndex={0}
                    aria-selected={c.id===selectedId}
                  >
                    <td style={{ fontWeight: 500 }}>{c.name}</td>
                    <td>{c.sector}</td>
                    <td><span className={`nz-st ${meta.cls}`}>{meta.label}</span></td>
                    <td className="num">{c.latestFootprint ? c.latestFootprint.replace(" tCO₂e", "") : <span className="muted">—</span>}</td>
                    <td>{c.completeness > 0 ? <Completeness pct={c.completeness} /> : <span className="muted">—</span>}</td>
                    <td className="num">{c.openJobs}</td>
                    <td>{c.nextReportDue}</td>
                    <td>{c.owner}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length===0?<div className="nz-engagement-empty"><b>No clients match this relationship stage</b><span>Choose another filter to return to the recorded portfolio.</span></div>:null}
        </div>
      </div>
    </AppShell>
  );
}
