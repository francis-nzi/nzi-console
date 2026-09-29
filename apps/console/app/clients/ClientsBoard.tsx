"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AppShell, DataList, EvidenceDrawer, RiskBadge, RiskLegend, TopBar, WorkspaceRail, type DataListColumn, type DataListFilter } from "@nzi/ui";
import { clientStatusMeta } from "@nzi/mock-data";
import { clientListSpec, hasActiveFilters, PAGE_SIZES, type ClientListFilterKey, type ClientListQuery } from "@nzi/contracts";
import type { ClientListPage, ClientListRow } from "@nzi/isolated-backend";
import { NAV, USER } from "../lib/nav";
import { crumbTrail, workspaceCrumbs } from "../lib/crumbTrail";
import { useListNavigation } from "../lib/useListNavigation";

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

function ClientDrawer({ c }: { c: ClientListRow }) {
  const meta = clientStatusMeta[c.status];
  const banner =
    c.status === "at-risk"
      ? { kind: "warn" as const, text: "At risk (relationship) — flagged by the account team. Milestone risk is the Risk column, shown separately." }
      : c.status === "prospect"
      ? { kind: "warn" as const, text: "Prospect — proposal sent, not yet onboarded. No live job." }
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

      <div className="nz-kv"><span className="k">Account owner</span><span className="v">{c.owner || "Unassigned"}</span></div>
      <div className="nz-kv"><span className="k">Client manager</span><span className="v">{c.clientManager ?? "Unassigned"}</span></div>
      <div className="nz-kv"><span className="k">Portfolio</span><span className="v">{c.portfolio ?? "Unassigned"}</span></div>
      <div className="nz-kv"><span className="k">Status</span><span className="v">{meta.label}</span></div>
      <div className="nz-kv"><span className="k">Risk</span><span className="v"><RiskBadge risk={c.risk} /></span></div>
      <div className="nz-kv"><span className="k">Member since</span><span className="v">{c.memberSince || "—"}</span></div>
      <div className="nz-kv"><span className="k">Latest emissions</span><span className="v">{c.latestFootprint ?? "—"}</span></div>
      <div className="nz-kv"><span className="k">Change vs prior year</span><span className="v">{c.yoy ?? "—"}</span></div>
      <div className="nz-kv"><span className="k">Data completeness</span><span className="v">{c.completeness}%</span></div>
      <div className="nz-kv"><span className="k">Open jobs</span><span className="v">{c.openJobs}</span></div>
      <div className="nz-kv"><span className="k">Next report due</span><span className="v">{c.nextReportDue || "—"}</span></div>

      <div className="nz-sect">Jobs</div>
      {c.jobs.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--t3)" }}>No jobs on record.</div>
      ) : (
        c.jobs.map((j) => (
          <div key={j.number} className="nz-kv">
            <span className="k">{j.number} · {j.year}</span>
            <span className="v">{j.status}</span>
          </div>
        ))
      )}

      <div className="nz-sect">Primary contact</div>
      <div className="nz-kv"><span className="k">{c.contact.name || "—"}</span><span className="v">{c.contact.role}</span></div>
      <div className="nz-kv"><span className="k">Email</span><span className="v" style={{ color: "var(--emerald)" }}>{c.contact.email || "—"}</span></div>
    </>
  );
}

const FILTERS: Array<{ key: ClientListFilterKey; label: string; allLabel: string }> = [
  { key: "industry", label: "Industry", allLabel: "All industries" },
  { key: "status", label: "Status", allLabel: "All statuses" },
  { key: "owner", label: "Owner", allLabel: "All owners" },
  { key: "portfolio", label: "Portfolio", allLabel: "All portfolios" },
  { key: "manager", label: "Client manager", allLabel: "All client managers" },
  { key: "risk", label: "Risk", allLabel: "All risk levels" },
];

const statusLabel = (value: string) => clientStatusMeta[value as keyof typeof clientStatusMeta]?.label ?? value;

export function ClientsBoard({ page, query }: { page: ClientListPage; query: ClientListQuery }) {
  const router = useRouter();
  const nav = useListNavigation(clientListSpec, query, "/clients");
  const [selectedId, setSelectedId] = useState<string>(page.rows[0]?.id ?? "");
  const rail = <WorkspaceRail sections={NAV} activeId="clients" user={USER} />;
  const topBar = <TopBar crumbs={crumbTrail(workspaceCrumbs("Clients", "/clients"))} />;

  // No clients at all is a different state from none matching the filters, and keeps its own call to action.
  if (page.unfilteredTotal === 0) return <AppShell rail={rail}>{topBar}<div className="nz-head"><div className="nz-eyebrow">Client intelligence</div><h1>Client portfolio</h1><div className="sub">Relationships, delivery health and reporting readiness</div></div><div className="nz-body nz-client-zero"><section><i>0</i><div><h2>No client records yet</h2><p>Create the first tenant-scoped client before opening jobs, portal access, or reporting workflows.</p><Link className="nz-btn pri" href="/clients/new">Add first client</Link></div></section></div></AppShell>;

  const selected = page.rows.find((c) => c.id === selectedId) ?? page.rows[0];
  const { summary } = page;
  const filtered = hasActiveFilters(query);
  const ownershipComplete = summary.withoutOwner === 0;
  const deliveryLinked = summary.deliveryClients > 0 && summary.deliveryWithoutJobs === 0;
  const footprintsRecorded = summary.activeWithoutEmissions === 0;

  const drawer = selected ? (
    <EvidenceDrawer
      kicker={`Client · ${clientStatusMeta[selected.status].label.toLowerCase()}`}
      title={selected.name}
      subtitle={[selected.sector, selected.location].filter(Boolean).join(" · ")}
      actions={
        <>
          <button type="button" className="nz-btn" onClick={() => router.push(`/jobs?client=${encodeURIComponent(selected.id)}`)}>New job</button>
          <button type="button" className="nz-btn pri" onClick={() => router.push(`/clients/${encodeURIComponent(selected.id)}`)}>Open client</button>
        </>
      }
    >
      <ClientDrawer c={selected} />
    </EvidenceDrawer>
  ) : undefined;

  const columns: DataListColumn<ClientListRow>[] = [
    { key: "name", header: "Client", sortKey: "name", cell: (c) => <Link href={`/clients/${encodeURIComponent(c.id)}`} className="nz-table-link" style={{ fontWeight: 500 }}>{c.name}</Link> },
    { key: "industry", header: "Industry", sortKey: "industry", cell: (c) => c.sector || <span className="muted">Unspecified</span> },
    { key: "status", header: "Status", sortKey: "status", cell: (c) => <span className={`nz-st ${clientStatusMeta[c.status].cls}`}>{clientStatusMeta[c.status].label}</span> },
    { key: "risk", header: "Risk", sortKey: "risk", cell: (c) => <RiskBadge risk={c.risk} /> },
    { key: "emissions", header: "Latest tCO₂e", sortKey: "emissions", numeric: true, cell: (c) => c.latestFootprint ? c.latestFootprint.replace(" tCO₂e", "") : <span className="muted">—</span> },
    { key: "completeness", header: "Data completeness", sortKey: "completeness", cell: (c) => c.completeness > 0 ? <Completeness pct={c.completeness} /> : <span className="muted">—</span> },
    { key: "openJobs", header: "Open jobs", sortKey: "openJobs", numeric: true, cell: (c) => c.openJobs },
    { key: "nextReport", header: "Next report", cell: (c) => c.nextReportDue || <span className="muted">—</span> },
    { key: "owner", header: "Owner", sortKey: "owner", cell: (c) => c.owner || <span className="muted">Unassigned</span> },
  ];

  const filters: DataListFilter[] = FILTERS.map(({ key, label, allLabel }) => ({
    key, label, allLabel, value: query.filters[key]?.[0] ?? "",
    options: page.filterOptions[key].map((option) => ({ ...option, label: key === "status" ? statusLabel(option.value) : option.label })),
  }));

  return (
    <AppShell rail={rail} drawer={drawer}>
      {topBar}

      <div className="nz-head">
        <div className="nz-job-titleline">
          <div>
            <div className="nz-eyebrow">Client intelligence</div><h1>Client portfolio</h1>
            <div className="sub">Relationships, delivery health and reporting readiness across {page.unfilteredTotal.toLocaleString("en-GB")} organisations</div>
          </div>
          <Link className="nz-btn pri" href="/clients/new">+ Add client</Link>
        </div>
      </div>

      <div className="nz-body" style={{ paddingTop: 16 }}>
        {/* Every figure here is over the filtered set, computed by the server — never over the page on screen. */}
        <section className="nz-ops-hero"><div><span className="nz-eyebrow light">Relationship command centre</span><h2>{summary.overdue?`${summary.overdue} client${summary.overdue===1?" has":"s have"} an overdue milestone.`:summary.atRisk?`${summary.atRisk} relationship${summary.atRisk===1?"":"s"} need focused attention.`:`No ${filtered ? "matching clients are" : "relationships are"} currently marked at risk.`}</h2><p>Bring relationship context, reporting delivery and data readiness together before the next client conversation.</p></div><div className="nz-ops-trust"><span><i>{ownershipComplete?"✓":"·"}</i> Ownership assigned</span><span><i>{deliveryLinked?"✓":"·"}</i> Delivery records linked</span><span><i>{footprintsRecorded?"✓":"·"}</i> Active footprints recorded</span></div></section>
        <div className="nz-metrics">
          <div className="nz-metric"><div className="l">{filtered ? "Matching clients" : "Clients"}</div><div className="v num">{summary.clients.toLocaleString("en-GB")}</div></div>
          <div className="nz-metric"><div className="l">Open jobs</div><div className="v num">{summary.openJobs.toLocaleString("en-GB")}</div></div>
          <div className="nz-metric"><div className="l">Without an owner</div><div className="v num">{summary.withoutOwner.toLocaleString("en-GB")}</div></div>
          <div className="nz-metric"><div className="l">Avg data completeness</div><div className="v num">{summary.averageCompleteness === null ? "—" : `${summary.averageCompleteness}%`}</div></div>
        </div>

        <RiskLegend />
        <DataList
          label="Clients"
          tableClassName="nz-client-table"
          rows={page.rows}
          rowKey={(c) => c.id}
          columns={columns}
          search={{ value: query.search, label: "Search clients", placeholder: "Client name or industry…", onChange: nav.search }}
          filters={filters}
          onFilter={(key, value) => nav.filter(key as ClientListFilterKey, value)}
          sort={query.sort}
          onSort={(key) => nav.sort(key as ClientListQuery["sort"]["key"])}
          paging={{ page: page.page, pageCount: page.pageCount, pageSize: page.pageSize, pageSizes: PAGE_SIZES, total: page.total }}
          onPage={nav.page}
          onPageSize={nav.pageSize}
          onClear={filtered ? () => nav.clear() : undefined}
          noMatches={<><b>No clients match these filters</b><span>Clear the search or a filter to return to the full portfolio.</span></>}
          selectedKey={selected?.id}
          onSelect={(c) => setSelectedId(c.id)}
          busy={nav.pending}
        />
      </div>
    </AppShell>
  );
}
