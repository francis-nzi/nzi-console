import { job712, jobs, type FamilyJob } from "@nzi/mock-data";
import { notFound } from "next/navigation";
import { loadScreen } from "../../lib/loadScreen";
import { ScreenState } from "../../lib/ScreenState";
import { FamilyWorkspace } from "../FamilyWorkspace";
import { JobBoard } from "../JobBoard";

export const dynamic = "force-dynamic";

export default async function JobPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const result = await loadScreen<{ jobs: FamilyJob[] }>("jobs", { jobs });
  return <ScreenState result={result}>{(data) => {
    const job = data.jobs.find((candidate) => candidate.header.id === jobId || candidate.header.number === jobId.toUpperCase());
    if (!job) notFound();
    return job.header.family === "crp" && job.header.sequence === 712 ? <JobBoard job={job712} workflowJob={job} /> : <FamilyWorkspace job={job} />;
  }}</ScreenState>;
}
