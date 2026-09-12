import { notFound } from "next/navigation";
import type { ClientWorkspaceReadModel, JobScreenReadModel } from "@nzi/isolated-backend";
import { loadScreen } from "../../lib/loadScreen";
import { ScreenState } from "../../lib/ScreenState";
import { dataEntryAdapterEnabled } from "../../lib/featureFlags";
import { ClientWorkspaceView } from "./ClientWorkspaceView";

export const dynamic = "force-dynamic";

/** Offline (fixture mode) there is no client data; the page says so rather than showing a stand-in client. */
const NO_CLIENT = { client: null, sites: [], evidence: null, reportingPeriods: [], contacts: [], targets: null, actuals: [] };
const londonToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());

export default async function ClientPage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  const [workspaceResult, jobResult] = await Promise.all([
    loadScreen<ClientWorkspaceReadModel>("clientWorkspace", NO_CLIENT, `clients/${encodeURIComponent(clientId)}/workspace`),
    loadScreen<{ jobs: JobScreenReadModel[] }>("jobs", { jobs: [] }),
  ]);
  if (workspaceResult.state === "failed" && workspaceResult.error.code === "HTTP_404") notFound();
  const today = londonToday();
  const render = (workspace: ClientWorkspaceReadModel, jobs: JobScreenReadModel[]) => <ClientWorkspaceView
    workspace={workspace}
    jobs={jobs.filter((job) => job.header.clientId === workspace.client.id)}
    today={today}
    writeEnabled={process.env.NZI_WRITE_API_ENABLED === "true"}
    factorsEnabled={dataEntryAdapterEnabled("client-factors")}
  />;
  // No jobs anywhere is a real, empty engagements list — not a reason to blank the client.
  return <ScreenState result={workspaceResult}>{(workspace) => jobResult.state === "empty"
    ? render(workspace, [])
    : <ScreenState result={jobResult}>{(jobData) => render(workspace, jobData.jobs)}</ScreenState>}
  </ScreenState>;
}
