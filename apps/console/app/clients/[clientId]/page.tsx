import { notFound } from "next/navigation";
import type { ClientWorkspaceReadModel, FinancialsReadModel, JobScreenReadModel } from "@nzi/isolated-backend";
import { loadScreen } from "../../lib/loadScreen";
import { ScreenState } from "../../lib/ScreenState";
import { dataEntryAdapterEnabled } from "../../lib/featureFlags";
import { ClientWorkspaceView } from "./ClientWorkspaceView";

export const dynamic = "force-dynamic";

/** Offline (fixture mode) there is no client data; the page says so rather than showing a stand-in client. */
const NO_CLIENT = { client: null, sites: [], evidence: null, reportingPeriods: [] };
/** Offline there is no ledger and no Xero connection. */
const NO_LEDGER = { quotes: [], invoices: [], creditNotes: [], xeroStatus: { state: "not_configured", label: "Not connected" } };
const londonToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());

export default async function ClientPage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  const [workspaceResult, jobResult, financialsResult] = await Promise.all([
    loadScreen<ClientWorkspaceReadModel>("clientWorkspace", NO_CLIENT, `clients/${encodeURIComponent(clientId)}/workspace`),
    loadScreen<{ jobs: JobScreenReadModel[] }>("jobs", { jobs: [] }),
    loadScreen<FinancialsReadModel>("financials", NO_LEDGER, `clients/${encodeURIComponent(clientId)}/financials`),
  ]);
  if (workspaceResult.state === "failed" && workspaceResult.error.code === "HTTP_404") notFound();
  const today = londonToday();
  const render = (workspace: ClientWorkspaceReadModel, jobs: JobScreenReadModel[]) => <ClientWorkspaceView
    workspace={workspace}
    jobs={jobs.filter((job) => job.header.clientId === workspace.client.id)}
    today={today}
    writeEnabled={process.env.NZI_WRITE_API_ENABLED === "true"}
    factorsEnabled={dataEntryAdapterEnabled("client-factors")}
    financials={financialsResult}
  />;
  // No jobs anywhere is a real, empty engagements list — not a reason to blank the client.
  return <ScreenState result={workspaceResult}>{(workspace) => jobResult.state === "empty"
    ? render(workspace, [])
    : <ScreenState result={jobResult}>{(jobData) => render(workspace, jobData.jobs)}</ScreenState>}
  </ScreenState>;
}
