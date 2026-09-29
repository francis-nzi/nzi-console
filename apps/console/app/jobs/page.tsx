import { DEFAULT_PAGE_SIZE, jobListSpec, listQueryToSearchParams, parseListQuery } from "@nzi/contracts";
import type { ClientScreenReadModel, JobListPage } from "@nzi/isolated-backend";
import { loadScreen } from "../lib/loadScreen";
import { ScreenState } from "../lib/ScreenState";
import { JobsIndex } from "./JobsIndex";

export const dynamic = "force-dynamic";

/** Fixture mode has no job records: an honest empty page, which the list shows as "no jobs yet". */
const NO_JOBS: JobListPage = {
  rows: [], total: 0, unfilteredTotal: 0, page: 1, pageSize: DEFAULT_PAGE_SIZE, pageCount: 1,
  filterOptions: { client: [], manager: [], family: [], status: [], risk: [], dueFrom: [], dueTo: [] },
  summary: { jobs: 0, carbonReporting: 0, averageProgress: null, dueWithin30Days: 0, overdue: 0 },
};

export default async function JobsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // A hand-edited or stale link renders on the defaults rather than failing; the API refuses anything else.
  const { query } = parseListQuery(await searchParams, jobListSpec);
  const search = listQueryToSearchParams(query, jobListSpec).toString();
  const [jobsResult, clientsResult] = await Promise.all([
    loadScreen<JobListPage>("jobList", NO_JOBS, search ? `job-list?${search}` : "job-list"),
    // The create form's client picker needs every client, not a page of them.
    loadScreen<{ clients: ClientScreenReadModel[] }>("clients", { clients: [] }),
  ]);
  return <ScreenState result={jobsResult} chrome={{ activeId: "jobs", label: "Jobs", href: "/jobs" }}>{(data) => <JobsIndex page={data} query={query} clients={clientsResult.state === "success" || clientsResult.state === "degraded" ? clientsResult.data.clients : []} />}</ScreenState>;
}
