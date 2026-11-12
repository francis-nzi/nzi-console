import {
  listV7ImportWorkbench, readV7ImportIngestState, readV7ImportWorkbench, v7ImportDecisionsSha256, withTenantRead,
  type V7ImportIngestState, type V7ImportWorkbenchSession, type V7ImportWorkbenchView,
} from "@nzi/isolated-backend";
import { CapabilityChip } from "@nzi/ui";
import { isolatedPool } from "../../lib/isolatedDatabase";
import { adminAccess, holds } from "../adminAccess";
import { ImportIngestPanel } from "./ImportIngestPanel";
import { ImportJobView, ImportSessionsList } from "./ImportReconciliation";

export const dynamic = "force-dynamic";

/**
 * Import reconciliation (import workbench, Phases 1–3; BRIEF-v7-import-workbench-phase1/-phase2/-phase3): each imported job's
 * uploaded summary — what the console holds of the previous system's records against what that system holds now — a person's
 * resolution of each row that needs one, and the ingest: its latest rehearsal and the ingested state. `import.manage` only (R-C
 * default: Admin). Nothing here changes a job's rows: the ingest runs on the operator's machine (R-A option 1), with no button.
 */
export default async function ImportReconciliationPage({ searchParams }: { searchParams: Promise<{ job?: string }> }) {
  const access = await adminAccess();
  if (access.state !== "allowed") return null; // The layout states why; nothing is read.
  if (!holds(access.capabilities, "import.manage")) {
    return <section className="nz-a-state" role="status"><h1>Import reconciliation is not part of your role</h1><p>It needs import.manage, which is held by Admin.</p></section>;
  }

  const { job } = await searchParams;
  let data: { sessions: V7ImportWorkbenchSession[]; view: V7ImportWorkbenchView | null; ingest: V7ImportIngestState | null } | null = null;
  try {
    data = await withTenantRead(isolatedPool(), access.organisationId, async (db) => {
      const view = job ? await readV7ImportWorkbench(db, access.organisationId, job) : null;
      return { sessions: await listV7ImportWorkbench(db, access.organisationId), view,
        ingest: view ? await readV7ImportIngestState(db, view.session.jobId, { sessionId: view.session.sessionId, decisionsSha256: v7ImportDecisionsSha256(view.decisions) }) : null };
    });
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
        <p>Each imported job against the previous system&rsquo;s records now: which rows match, which moved, which are new or withdrawn, which need a mapping and which are blocked on a linked pair — with Σ per scope on each side. Map each new or moved row to a category and factor, and confirm each withdrawn one; the job is ready to ingest once every row that differs is resolved. The summary is made on the operator&rsquo;s machine; only ids, codes, statuses and tCO2e reach the console.</p>
      </div>
      <div className="nz-a-head-actions"><CapabilityChip capability="import.manage" /></div>
    </div>
    <div className="nz-a-grid">
      {job && !data.view ? <div className="nz-a-hint-strip warn" role="status"><span>i</span><div>That job has no import summary yet.</div></div> : null}
      {data.view && data.ingest ? <ImportIngestPanel state={data.ingest} verdict={data.view.resolvedVerdict} /> : null}
      {data.view ? <ImportJobView view={data.view} /> : null}
      <ImportSessionsList sessions={data.sessions} selected={job ?? null} />
    </div>
  </>;
}
