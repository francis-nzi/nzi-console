import { jobs, type FamilyJob } from "@nzi/mock-data";
import type { FactorOption,ScopeRowReadModel } from "@nzi/contracts";
import { notFound } from "next/navigation";
import { loadScreen } from "../../lib/loadScreen";
import { ScreenState } from "../../lib/ScreenState";
import { FamilyWorkspace } from "../FamilyWorkspace";
import { CrpScopeWorkspace } from "../CrpScopeWorkspace";

export const dynamic = "force-dynamic";

export default async function JobPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const [result, scopeRows, factors] = await Promise.all([
    loadScreen<{ jobs: FamilyJob[] }>("jobs", { jobs }),
    loadScreen<{ rows: ScopeRowReadModel[] }>("scopeRows", { rows: [] }, `jobs/${jobId}/scope-rows`),
    loadScreen<{ factors: FactorOption[] }>("factorOptions", { factors: [] }, `jobs/${jobId}/factors`),
  ]);
  return <ScreenState result={result}>{(data) => {
    const job = data.jobs.find((candidate) => candidate.header.id === jobId || candidate.header.number === jobId.toUpperCase());
    if (!job) notFound();
    return job.header.family === "crp" ? <ScreenState result={scopeRows}>{(scopeData) => <ScreenState result={factors}>{(factorData) => <CrpScopeWorkspace job={job} rows={scopeData.rows} factors={factorData.factors} />}</ScreenState>}</ScreenState> : <FamilyWorkspace job={job} />;
  }}</ScreenState>;
}
