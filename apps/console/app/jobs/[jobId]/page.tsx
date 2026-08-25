import { findJob, job712, jobs } from "@nzi/mock-data";
import { loadFixtureScreen } from "@nzi/api-client";
import { notFound } from "next/navigation";
import { ScreenState } from "../../lib/ScreenState";
import { FamilyWorkspace } from "../FamilyWorkspace";
import { JobBoard } from "../JobBoard";

export function generateStaticParams() { return jobs.map((job) => ({ jobId: job.header.id })); }
export default async function JobPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const job = findJob(jobId);
  if (!job) notFound();
  const result = loadFixtureScreen<{ job: typeof job }>("job", { job });
  return <ScreenState result={result}>{(data) => data.job.header.family === "crp" ? <JobBoard job={job712} /> : <FamilyWorkspace job={data.job} />}</ScreenState>;
}
