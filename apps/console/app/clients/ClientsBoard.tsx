"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AppShell, WorkspaceRail, TopBar, EvidenceDrawer } from "@nzi/ui";
import { type Client, type ClientStatus, clientStatusMeta } from "@nzi/mock-data";
import type { CommandInputMap } from "@nzi/contracts";
import { postBrowserCommand } from "@nzi/api-client";
import { NAV, USER } from "../lib/nav";

type Filter = "all" | ClientStatus;

function Completeness({ pct }: { pct: number }) {
  const color = pct >= 85 ? "var(--emerald)" : pct >= 50 ? "var(--amber)" : "var(--coral)";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span style={{ width: 74, height: 6, background: "#E7ECE9", borderRadius: 6, overflow: "hidden" }}>
        <span style={{ display: "block", height: "100%", width: `${pct}%`, background: color }} />
      </span>
      <span className="num" style={{ color: "var(--t2)", fontSize: 12 }}>{pct}%</span>
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
      : { kind: "ok" as const, text: "Active client — engagement on track." };

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
  const [selectedId, setSelectedId] = useState<string>(clients[0]!.id);
  const [filter, setFilter] = useState<Filter>("all");
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "warn"; text: string } | null>(null);
  const submissionKey = useRef<string | null>(null);
  const [draft, setDraft] = useState<CommandInputMap["client.create"]>({ name: "", status: "onboarding", sector: "", location: "", owner: "" });

  async function createClient(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setNotice(null);
    submissionKey.current ??= crypto.randomUUID();
    const result = await postBrowserCommand<{ clientId: string; name: string }>("/api/isolated/commands/clients", draft, submissionKey.current);
    setSaving(false);
    if (result.state === "success") {
      submissionKey.current = null; setSelectedId(result.data.clientId); setCreating(false);
      setDraft({ name: "", status: "onboarding", sector: "", location: "", owner: "" });
      setNotice({ kind: "ok", text: `${result.data.name} was created successfully.` }); router.refresh(); return;
    }
    if (result.state !== "failed" || !result.retryable) submissionKey.current = null;
    setNotice({ kind: "warn", text: result.state === "validation_failed" ? result.issues[0]?.message ?? result.message : result.message });
  }

  const rows = useMemo(
    () => (filter === "all" ? clients : clients.filter((c) => c.status === filter)),
    [clients, filter],
  );
  const selected = clients.find((c) => c.id === selectedId) ?? clients[0]!;

  const activeJobs = clients.reduce((n, c) => n + c.openJobs, 0);
  const avgCompleteness = Math.round(clients.reduce((n, c) => n + c.completeness, 0) / clients.length);
  const dueSoon = clients.filter((c) => /202|Overdue/.test(c.nextReportDue)).length;

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
          <button className="nz-btn">New job</button>
          <button className="nz-btn pri">Open client</button>
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
        crumbs={<><b>Clients</b> <span className="muted">/</span> All organisations</>}
      />

      <div className="nz-head">
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
          <div>
            <h1>Clients</h1>
            <div className="sub">{clients.length} organisations · {activeJobs} open jobs</div>
          </div>
          <button className="nz-btn pri" style={{ marginLeft: "auto" }} onClick={() => { setCreating((value) => !value); setNotice(null); }}>{creating ? "Close" : "Add client"}</button>
        </div>
      </div>

      <div className="nz-body" style={{ paddingTop: 16 }}>
        {notice && <div className={`nz-banner ${notice.kind}`}><div>{notice.text}</div></div>}
        {creating && <form className="nz-panel" style={{ padding: 18, marginBottom: 16 }} onSubmit={createClient}>
          <div><b>Add client</b><div className="sub" style={{ marginTop: 4 }}>Creates one tenant-scoped client record with an audit event. Contact details can be added in the client workspace later.</div></div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(180px, 1fr))", gap: 14, marginTop: 16 }}>
            <label className="nz-fl" style={{ margin: 0 }}>Client name<input className="nz-inp" required value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
            <label className="nz-fl" style={{ margin: 0 }}>Status<select className="nz-sel" value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value as ClientStatus })}><option value="onboarding">Onboarding</option><option value="active">Active</option><option value="at-risk">At risk</option><option value="prospect">Prospect</option></select></label>
            <label className="nz-fl" style={{ margin: 0 }}>Account owner<input className="nz-inp" required value={draft.owner} onChange={(e) => setDraft({ ...draft, owner: e.target.value })} /></label>
            <label className="nz-fl" style={{ margin: 0 }}>Sector<input className="nz-inp" required value={draft.sector} onChange={(e) => setDraft({ ...draft, sector: e.target.value })} /></label>
            <label className="nz-fl" style={{ margin: 0, gridColumn: "span 2" }}>Location<input className="nz-inp" required placeholder="City, country" value={draft.location} onChange={(e) => setDraft({ ...draft, location: e.target.value })} /></label>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}><button type="button" className="nz-btn" onClick={() => setCreating(false)} disabled={saving}>Cancel</button><button className="nz-btn pri" disabled={saving}>{saving ? "Creatingâ€¦" : "Create client"}</button></div>
        </form>}
        <div className="nz-metrics">
          <div className="nz-metric"><div className="l">Clients</div><div className="v num">{clients.length}</div></div>
          <div className="nz-metric"><div className="l">Open jobs</div><div className="v num">{activeJobs}</div></div>
          <div className="nz-metric"><div className="l">Reports due / overdue</div><div className="v num">{dueSoon}</div></div>
          <div className="nz-metric"><div className="l">Avg data completeness</div><div className="v num">{avgCompleteness}%</div></div>
        </div>

        <div className="nz-toolbar" style={{ padding: "0 0 12px" }}>
          <div className="nz-filters">
            {filters.map((f) => (
              <button key={f.id} className={filter === f.id ? "on" : undefined} onClick={() => setFilter(f.id)}>
                {f.label}
              </button>
            ))}
          </div>
        </div>

        <div className="nz-panel">
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
        </div>
      </div>
    </AppShell>
  );
}
