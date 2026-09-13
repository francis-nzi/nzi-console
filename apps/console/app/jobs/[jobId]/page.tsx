import type { JobScreenReadModel } from "@nzi/isolated-backend";
import type { DatasetOption,EmissionsTargetReadModel,FactorOption,IntensityTargetReadModel,LcaAssessment,LcaComponentOption,PurchasedGoodsCategoryOption,SiteOption,ScopeQaReadiness,ScopeRowReadModel } from "@nzi/contracts";
import { notFound } from "next/navigation";
import { loadScreen } from "../../lib/loadScreen";
import { ScreenState } from "../../lib/ScreenState";
import { FamilyWorkspace } from "../FamilyWorkspace";
import { CrpScopeWorkspace } from "../CrpScopeWorkspace";
import { LcaWorkspace } from "../lca/LcaWorkspace";
import { TrainingWorkspace } from "../training/TrainingWorkspace";
import { jobModuleEnabled } from "../../lib/jobModuleFlags";
import type { TrainingRunRecord } from "@nzi/isolated-backend";

export const dynamic = "force-dynamic";

export default async function JobPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const [result, scopeRows, factors,target,intensity,sites,categories,lca,lcaComponents,training] = await Promise.all([
    loadScreen<{ jobs: JobScreenReadModel[] }>("jobs", { jobs: [] }),
    loadScreen<{ rows: ScopeRowReadModel[];qa:ScopeQaReadiness }>("scopeRows", { rows: [],qa:{total:0,enabled:0,approved:0,pending:0,rejected:0,calculationMissing:0,qualityMissing:0,independentReviewPending:0,readyForReporting:false} }, `jobs/${jobId}/scope-rows`),
    loadScreen<{ factors: FactorOption[];datasets:DatasetOption[] }>("factorOptions", { factors: [],datasets:[] }, `jobs/${jobId}/factors`),
    loadScreen<{target:EmissionsTargetReadModel|null}>("emissionsTarget",{target:null},`jobs/${jobId}/emissions-target`),
    loadScreen<{target:IntensityTargetReadModel|null}>("intensityTarget",{target:null},`jobs/${jobId}/intensity-target`),
    loadScreen<{sites:SiteOption[]}>("sites",{sites:[]},`jobs/${jobId}/sites`),
    loadScreen<{categories:PurchasedGoodsCategoryOption[]}>("purchasedGoodsCategories",{categories:[]},`jobs/${jobId}/purchased-goods-categories`),
    loadScreen<{assessments:LcaAssessment[]}>("lca",{assessments:[]},`jobs/${jobId}/lca-assessments`),
    loadScreen<{components:LcaComponentOption[];categories:{id:string;name:string}[]}>("lcaComponents",{components:[],categories:[]},`jobs/${jobId}/lca-components`),
    loadScreen<{runs:TrainingRunRecord[]}>("training",{runs:[]},`jobs/${jobId}/training-runs`),
  ]);
  return <ScreenState result={result}>{(data) => {
    const job = data.jobs.find((candidate) => candidate.header.id === jobId || candidate.header.number === jobId.toUpperCase());
    if (!job) notFound();
    if (job.header.family === "crp") return <ScreenState result={scopeRows}>{(scopeData) => <ScreenState result={factors}>{(factorData) => <ScreenState result={target}>{targetData=><ScreenState result={intensity}>{intensityData=><ScreenState result={sites}>{siteData=><ScreenState result={categories}>{categoryData=><CrpScopeWorkspace job={job} rows={scopeData.rows} qa={scopeData.qa} factors={factorData.factors} datasets={factorData.datasets} target={targetData.target} intensityTarget={intensityData.target} sites={siteData.sites} purchasedGoodsCategories={categoryData.categories} writeEnabled={process.env.NZI_WRITE_API_ENABLED === "true"}/>}</ScreenState>}</ScreenState>}</ScreenState>}</ScreenState>}</ScreenState>}</ScreenState>;
    if ((job.header.family === "lca" || job.header.family === "pcf") && jobModuleEnabled("job-module-lca")) return <ScreenState result={lca}>{(lcaData) => <ScreenState result={factors}>{(factorData) => <ScreenState result={lcaComponents}>{(componentData) => <LcaWorkspace job={job} assessments={lcaData.assessments} factors={factorData.factors} components={componentData.components} categories={componentData.categories}/>}</ScreenState>}</ScreenState>}</ScreenState>;
    // Track C — the training module, behind `job-module-training`; FamilyWorkspace still
    // serves training jobs while the flag is off. `today` is resolved here, on the server,
    // so every place's expiry is judged against one date rather than the viewer's clock.
    if (job.header.family === "training" && jobModuleEnabled("job-module-training")) return <ScreenState result={training}>{(trainingData) => <TrainingWorkspace job={job} runs={trainingData.runs} today={new Date().toISOString().slice(0, 10)} writeEnabled={process.env.NZI_WRITE_API_ENABLED === "true"}/>}</ScreenState>;
    return <FamilyWorkspace job={job} />;
  }}</ScreenState>;
}
