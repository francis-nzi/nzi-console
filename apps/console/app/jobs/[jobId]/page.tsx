import { jobs, type FamilyJob } from "@nzi/mock-data";
import type { DatasetOption,EmissionsTargetReadModel,FactorOption,ScopeQaReadiness,ScopeRowReadModel } from "@nzi/contracts";
import { notFound } from "next/navigation";
import { loadScreen } from "../../lib/loadScreen";
import { ScreenState } from "../../lib/ScreenState";
import { FamilyWorkspace } from "../FamilyWorkspace";
import { CrpScopeWorkspace } from "../CrpScopeWorkspace";

export const dynamic = "force-dynamic";

export default async function JobPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const [result, scopeRows, factors,target] = await Promise.all([
    loadScreen<{ jobs: FamilyJob[] }>("jobs", { jobs }),
    loadScreen<{ rows: ScopeRowReadModel[];qa:ScopeQaReadiness }>("scopeRows", { rows: [],qa:{total:0,enabled:0,approved:0,pending:0,rejected:0,calculationMissing:0,qualityMissing:0,independentReviewPending:0,readyForReporting:false} }, `jobs/${jobId}/scope-rows`),
    loadScreen<{ factors: FactorOption[];datasets:DatasetOption[] }>("factorOptions", { factors: [],datasets:[] }, `jobs/${jobId}/factors`),
    loadScreen<{target:EmissionsTargetReadModel|null}>("emissionsTarget",{target:null},`jobs/${jobId}/emissions-target`),
  ]);
  return <ScreenState result={result}>{(data) => {
    const job = data.jobs.find((candidate) => candidate.header.id === jobId || candidate.header.number === jobId.toUpperCase());
    if (!job) notFound();
    return job.header.family === "crp" ? <ScreenState result={scopeRows}>{(scopeData) => <ScreenState result={factors}>{(factorData) => <ScreenState result={target}>{targetData=><CrpScopeWorkspace job={job} rows={scopeData.rows} qa={scopeData.qa} factors={factorData.factors} datasets={factorData.datasets} target={targetData.target}/>}</ScreenState>}</ScreenState>}</ScreenState> : <FamilyWorkspace job={job} />;
  }}</ScreenState>;
}
