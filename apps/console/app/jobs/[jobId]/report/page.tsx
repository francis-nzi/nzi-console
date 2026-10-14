import { redirect } from "next/navigation";

/** B2-1: the job's Report area opens on Report Printing, the studio's own page (Preparation and Client Review are its tabs). */
export default async function JobReportPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  redirect(`/jobs/${encodeURIComponent(jobId)}/report/printing`);
}
