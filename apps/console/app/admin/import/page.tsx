import { listV7ImportSessions, readV7ImportView, withTenantRead, type V7ImportSessionSummary, type V7ImportView } from "@nzi/isolated-backend";
import { CapabilityChip } from "@nzi/ui";
import { isolatedPool } from "../../lib/isolatedDatabase";
import { adminAccess, holds } from "../adminAccess";
import { ImportJobView, ImportSessionsList } from "./ImportReconciliation";

export const dynamic = "force-dynamic";

/**
 * Import reconciliation (import workbench, Phase 1; BRIEF-v7-import-workbench-phase1): each imported job's uploaded summary —
 * what the console holds of the previous system's records against what that system holds now. `import.manage` only
 * (provisional R-C: Admin; a CRM's view is Phase 2). View-only: nothing here writes, and no mapping or ingest is offered.
 */
export default async function ImportReconciliationPage({ searchParams }: { searchParams: Promise<{ job?: string }> }) {
  const access = await adminAccess();
  if (access.state !== "allowed") return null; // The layout states why; nothing is read.
  if (!holds(access.capabilities, "import.manage")) {
    return <section className="nz-a-state" role="status"><h1>Import reconciliation is not part of your role</h1><p>It needs import.manage, which is held by Admin.</p></section>;
  }

  const { job } = await searchParams;
  let data: { sessions: V7ImportSessionSummary[]; view: V7ImportView | null } | null = null;
  try {
    data = await withTenantRead(isolatedPool(), access.organisationId, async (db) => ({
      sessions: await listV7ImportSessions(db), view: job ? await readV7ImportView(db, job) : null }));
  } catch {
    data = null;
  }
  if (data === null) {
    return <section className="nz-a-state" role="alert"><h1>Import summaries could not be read</h1><p>They are unavailable just now. Nothing is shown rather than a reconciliation that might be incomplete.</p></section>;
  }
  return <>
    <div className="nz-a-page-head">
      <div>
        <div className="nz-a-eyebrow">Carbon data</div>
        <h1>Import reconciliation</h1>
        <p>Each imported job against the previous system&rsquo;s records now: which rows match, which moved, which are new or withdrawn, which need a mapping and which are blocked on a linked pair — with Σ per scope on each side. The summary is made on the operator&rsquo;s machine; only ids, codes, statuses and tCO2e reach the console. View-only.</p>
      </div>
      <div className="nz-a-head-actions"><CapabilityChip capability="import.manage" /></div>
    </div>
    <div className="nz-a-grid">
      {job && !data.view ? <div className="nz-a-hint-strip warn" role="status"><span>i</span><div>That job has no import summary yet.</div></div> : null}
      {data.view ? <ImportJobView view={data.view} /> : null}
      <ImportSessionsList sessions={data.sessions} selected={job ?? null} />
    </div>
  </>;
}
