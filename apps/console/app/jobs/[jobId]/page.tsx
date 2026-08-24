import { findJob, job712, jobs } from "@nzi/mock-data";
import { notFound } from "next/navigation";
import { FamilyWorkspace } from "../FamilyWorkspace";
import { JobBoard } from "../JobBoard";

export function generateStaticParams() { return jobs.map((job) => ({ jobId: job.header.id })); }
export default async function JobPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const job = findJob(jobId);
  if (!job) notFound();
  return job.header.family === "crp" ? <JobBoard job={job712} /> : <FamilyWorkspace job={job} />;
}
