import { clients, jobs } from "@nzi/mock-data";
import { loadScreen } from "../lib/loadScreen";
import { ScreenState } from "../lib/ScreenState";
import { JobsIndex } from "./JobsIndex";

export const dynamic = "force-dynamic";

export default async function JobsPage() {
  const [jobsResult, clientsResult] = await Promise.all([
    loadScreen<{ jobs: typeof jobs }>("jobs", { jobs }),
    loadScreen<{ clients: typeof clients }>("clients", { clients }),
  ]);
  return <ScreenState result={jobsResult}>{(data) => <JobsIndex jobs={data.jobs} clients={clientsResult.state === "success" || clientsResult.state === "degraded" ? clientsResult.data.clients : clients} />}</ScreenState>;
}
