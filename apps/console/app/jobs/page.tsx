import type { ClientScreenReadModel, JobScreenReadModel } from "@nzi/isolated-backend";
import { loadScreen } from "../lib/loadScreen";
import { ScreenState } from "../lib/ScreenState";
import { JobsIndex } from "./JobsIndex";

export const dynamic = "force-dynamic";

export default async function JobsPage() {
  const [jobsResult, clientsResult] = await Promise.all([
    loadScreen<{ jobs: JobScreenReadModel[] }>("jobs", { jobs: [] }),
    loadScreen<{ clients: ClientScreenReadModel[] }>("clients", { clients: [] }),
  ]);
  return <ScreenState result={jobsResult}>{(data) => <JobsIndex jobs={data.jobs} clients={clientsResult.state === "success" || clientsResult.state === "degraded" ? clientsResult.data.clients : []} />}</ScreenState>;
}
