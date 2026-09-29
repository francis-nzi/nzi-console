import { getAdminOverview, withTenantRead, type AdminOverview } from "@nzi/isolated-backend";
import { isolatedPool } from "../lib/isolatedDatabase";
import { adminAccess, holds } from "./adminAccess";
import { ADMIN_NAV } from "./adminNav";
import { AdminChangesFeed } from "./AdminChangesFeed";

export const dynamic = "force-dynamic";

const count = new Intl.NumberFormat("en-GB");
const percent = (part: number, whole: number) => whole === 0 ? "—" : `${Math.round((100 * part) / whole)}%`;

/**
 * The configuration overview (admin Phase A1): real figures only. Lookups by category, how many clients are linked to
 * the lookup values and team members their records name, and the recent administration changes from the audit log.
 */
export default async function AdminOverviewPage() {
  const access = await adminAccess();
  if (access.state !== "allowed") return null; // The layout states why; nothing is read.

  // The audit log is shown to a holder of audit.view at scope `all` — an own-clients holder would otherwise see
  // administration events about other people's clients.
  const includeChanges = holds(access.capabilities, "audit.view", "all");
  let overview: AdminOverview | null = null;
  try {
    overview = await withTenantRead(isolatedPool(), access.organisationId, (db) => getAdminOverview(db, { includeChanges }));
  } catch {
    overview = null;
  }

  return <>
    <div className="nz-a-page-head">
      <div>
        <div className="nz-a-eyebrow">Administration</div>
        <h1>Configuration overview</h1>
        <p>Everything the console is built from — the lookups, templates and settings behind clients, jobs, quotes and reports.</p>
      </div>
      <div className="nz-a-head-actions"><span className="nz-a-cap" title="Your role, from the capability matrix">{access.role.charAt(0).toUpperCase() + access.role.slice(1)} role</span></div>
    </div>

    {overview === null ? <section className="nz-a-state" role="alert"><h1>The overview could not be read</h1><p>The configuration figures are unavailable just now. Nothing is shown rather than a figure that might be wrong.</p></section> : <>
      <div className="nz-a-grid nz-a-metrics">
        <Metric label="Lookup categories" value={count.format(overview.lookups.categories)} note={`${count.format(overview.lookups.active)} active values`} />
        <Metric label="Lookup values" value={count.format(overview.lookups.values)} note={overview.lookups.added ? `${count.format(overview.lookups.added)} added here` : "none added here yet"} />
        <Metric label="Clients" value={count.format(overview.clients)} note="in this organisation" />
        <Metric label="Industry links" value={percent(overview.links[0]!.linked, overview.clients)} note={`${count.format(overview.links[0]!.unlinked)} named but not linked`} />
      </div>

      <div className="nz-a-grid nz-a-split">
        <div>
          <section className="nz-a-card" aria-labelledby="links-title">
            <div className="nz-a-panel-title"><h2 id="links-title">Client links to lookups</h2><span className="nz-a-hint">linked · named, not linked · none</span></div>
            {overview.links.map((link) => <div className="nz-a-link-row" key={link.key}>
              <div className="top"><b>{link.label}</b><span>{count.format(link.linked)} / {count.format(overview.clients)} linked</span></div>
              <div className="nz-a-bar" role="img" aria-label={`${link.label}: ${link.linked} linked, ${link.unlinked} named but not linked, ${link.none} with nothing to link`}>
                <i className="linked" style={{ width: `${overview.clients ? (100 * link.linked) / overview.clients : 0}%` }} />
                <i className="unlinked" style={{ width: `${overview.clients ? (100 * link.unlinked) / overview.clients : 0}%` }} />
              </div>
              <div className="legend"><span><b>{count.format(link.linked)}</b> linked</span><span><b>{count.format(link.unlinked)}</b> named, not linked</span><span><b>{count.format(link.none)}</b> nothing to link</span></div>
            </div>)}
          </section>

          <div className="nz-a-sec-cards">
            {ADMIN_NAV.filter((group) => group.group).map((group) => <a key={group.group} className="nz-a-sec-card" href={group.items[0]!.href}>
              <div className="nz-a-eyebrow">{group.group}</div>
              <b>{group.items.map((item) => item.label).join(" · ")}</b>
              <span className="foot">{group.items.every((item) => item.phase) ? `Roadmap · ${[...new Set(group.items.map((item) => item.phase))].join(", ")}` : "Live"}</span>
            </a>)}
          </div>
        </div>

        <section className="nz-a-card" aria-labelledby="changes-title">
          <div className="nz-a-panel-title"><h2 id="changes-title">Recent changes</h2><span className="nz-a-hint">from the audit log</span></div>
          {overview.recentChanges === null
            ? <p className="nz-a-empty">Your role does not include the organisation’s whole audit log, so recent changes are not shown here.</p>
            : <AdminChangesFeed changes={overview.recentChanges} />}
        </section>
      </div>
    </>}
  </>;
}

function Metric({ label, value, note }: { label: string; value: string; note: string }) {
  return <div className="nz-a-card nz-a-metric"><div className="l">{label}</div><div className="v">{value}</div><div className="s">{note}</div></div>;
}
