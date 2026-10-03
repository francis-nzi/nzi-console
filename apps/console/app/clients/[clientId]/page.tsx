import { notFound } from "next/navigation";
import type { ClientHistoryEntry, ClientWorkspaceReadModel, JobScreenReadModel } from "@nzi/isolated-backend";
import { loadScreen } from "../../lib/loadScreen";
import { ScreenState } from "../../lib/ScreenState";
import { dataEntryAdapterEnabled } from "../../lib/featureFlags";
import { ClientWorkspaceView } from "./ClientWorkspaceView";
import { WithCurrencyDirectory } from "../../lib/currencyDirectory";

export const dynamic = "force-dynamic";

/** Offline (fixture mode) there is no client data; the page says so rather than showing a stand-in client. */
const NO_CLIENT = { client: null, sites: [], evidence: null, reportingPeriods: [], contacts: [], targets: null, actuals: [], history: [], reports: [], messages: [], files: [] };
const londonToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());

export default async function ClientPage({ params, searchParams }: { params: Promise<{ clientId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { clientId } = await params;
  const area = (await searchParams).area;
  // CLIENT-12: the audit history is resolved here with the rest, under the caller's audit.view — a 403 reaches the
  // History area as a refusal, never as an empty history.
  const [workspaceResult, jobResult, historyResult] = await Promise.all([
    loadScreen<ClientWorkspaceReadModel>("clientWorkspace", NO_CLIENT, `clients/${encodeURIComponent(clientId)}/workspace`),
    loadScreen<{ jobs: JobScreenReadModel[] }>("jobs", { jobs: [] }),
    loadScreen<{ history: ClientHistoryEntry[]; limit: number }>("clientHistory", { history: [], limit: 100 }, `clients/${encodeURIComponent(clientId)}/history`),
  ]);
  if (workspaceResult.state === "failed" && workspaceResult.error.code === "HTTP_404") notFound();
  const today = londonToday();
  const render = (workspace: ClientWorkspaceReadModel, jobs: JobScreenReadModel[]) => <ClientWorkspaceView
    workspace={workspace}
    jobs={jobs.filter((job) => job.header.clientId === workspace.client.id)}
    today={today}
    writeEnabled={process.env.NZI_WRITE_API_ENABLED === "true"}
    factorsEnabled={dataEntryAdapterEnabled("client-factors")}
    initialArea={typeof area === "string" ? area : undefined}
    auditHistory={historyResult}
  />;
  // No jobs anywhere is a real, empty jobs list — not a reason to blank the client.
  // E1: intensity units read in the organisation's own currency symbols.
  return <WithCurrencyDirectory><ScreenState result={workspaceResult} chrome={{ activeId: "clients", label: "Clients", href: "/clients" }}>{(workspace) => jobResult.state === "empty"
    ? render(workspace, [])
    : <ScreenState result={jobResult} chrome={{ activeId: "clients", label: "Clients", href: "/clients" }}>{(jobData) => render(workspace, jobData.jobs)}</ScreenState>}
  </ScreenState></WithCurrencyDirectory>;
}
