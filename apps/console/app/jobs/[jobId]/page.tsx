import type { JobScreenReadModel } from "@nzi/isolated-backend";
import type { DatasetOption,EmissionsTargetReadModel,FactorOption,IntensityTargetReadModel,LcaAssessment,LcaComponentOption,PurchasedGoodsCategoryOption,SiteOption,ScopeQaReadiness,ScopeRowReadModel } from "@nzi/contracts";
import type { InputSpecCategory } from "@nzi/contracts";
import { todayInLondon } from "@nzi/contracts";
import { notFound } from "next/navigation";
import { loadScreen } from "../../lib/loadScreen";
import { ScreenState } from "../../lib/ScreenState";
import { FamilyWorkspace } from "../FamilyWorkspace";
import { CrpScopeWorkspace } from "../CrpScopeWorkspace";
import { LcaWorkspace } from "../lca/LcaWorkspace";
import { TrainingWorkspace } from "../training/TrainingWorkspace";
import { jobModuleEnabled } from "../../lib/jobModuleFlags";
import type { TrainingRunRecord, JobEmissions } from "@nzi/isolated-backend";

export const dynamic = "force-dynamic";

/**
 * The fallback shape for a degraded emissions read (NZC-144).
 *
 * Zeros and empty breakdowns, deliberately: the strip then renders an honest nought with its own
 * refreshing state rather than a figure assembled from the rows the page happens to hold, which is the
 * second implementation this read exists to remove.
 */
const EMPTY_EMISSIONS = (jobId: string): JobEmissions => ({
  jobId, siteId: null,
  headline: { tco2e: 0, marketTco2e: 0, entries: 0, marketEntries: 0 },
  byScope: [], byCategory: [], bySite: [],
});

export default async function JobPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const [result, inputSpec, scopeRows, factors,target,intensity,sites,categories,lca,lcaComponents,training,emissions] = await Promise.all([
    loadScreen<{ jobs: JobScreenReadModel[] }>("jobs", { jobs: [] }),
    loadScreen<{ spec: InputSpecCategory[] }>("inputSpec", { spec: [] }, "input-spec"),
    loadScreen<{ rows: ScopeRowReadModel[];qa:ScopeQaReadiness }>("scopeRows", { rows: [],qa:{total:0,enabled:0,approved:0,pending:0,rejected:0,calculationMissing:0,qualityMissing:0,independentReviewPending:0,readyForReporting:false} }, `jobs/${jobId}/scope-rows`),
    loadScreen<{ factors: FactorOption[];datasets:DatasetOption[] }>("factorOptions", { factors: [],datasets:[] }, `jobs/${jobId}/factors`),
    loadScreen<{target:EmissionsTargetReadModel|null}>("emissionsTarget",{target:null},`jobs/${jobId}/emissions-target`),
    loadScreen<{target:IntensityTargetReadModel|null}>("intensityTarget",{target:null},`jobs/${jobId}/intensity-target`),
    loadScreen<{sites:SiteOption[]}>("sites",{sites:[]},`jobs/${jobId}/sites`),
    loadScreen<{categories:PurchasedGoodsCategoryOption[]}>("purchasedGoodsCategories",{categories:[]},`jobs/${jobId}/purchased-goods-categories`),
    loadScreen<{assessments:LcaAssessment[]}>("lca",{assessments:[]},`jobs/${jobId}/lca-assessments`),
    loadScreen<{components:LcaComponentOption[];categories:{id:string;name:string}[]}>("lcaComponents",{components:[],categories:[]},`jobs/${jobId}/lca-components`),
    loadScreen<{runs:TrainingRunRecord[]}>("training",{runs:[]},`jobs/${jobId}/training-runs`),
    loadScreen<JobEmissions>("emissions", EMPTY_EMISSIONS(jobId), `jobs/${jobId}/emissions`),
  ]);
  // The governed spec, keyed by category code for the surfaces that render against it (NZC-102).
  // A degraded spec read yields an empty map: the accordion then renders its category with no
  // fields, which is visibly wrong rather than quietly falling back to a second definition.
  const specs: Record<string, InputSpecCategory> = Object.fromEntries(
    (inputSpec.state === "success" || inputSpec.state === "degraded" ? inputSpec.data.spec : [])
      .map((category) => [category.categoryCode, category]));

  return <ScreenState result={result}>{(data) => {
    const job = data.jobs.find((candidate) => candidate.header.id === jobId || candidate.header.number === jobId.toUpperCase());
    if (!job) notFound();
    if (job.header.family === "crp") return <ScreenState result={emissions}>{(emissionsData) => <ScreenState result={scopeRows}>{(scopeData) => <ScreenState result={factors}>{(factorData) => <ScreenState result={target}>{targetData=><ScreenState result={intensity}>{intensityData=><ScreenState result={sites}>{siteData=><ScreenState result={categories}>{categoryData=><CrpScopeWorkspace specs={specs} job={job} rows={scopeData.rows} qa={scopeData.qa} factors={factorData.factors} datasets={factorData.datasets} target={targetData.target} intensityTarget={intensityData.target} sites={siteData.sites} purchasedGoodsCategories={categoryData.categories} emissions={emissionsData} writeEnabled={process.env.NZI_WRITE_API_ENABLED === "true"}/>}</ScreenState>}</ScreenState>}</ScreenState>}</ScreenState>}</ScreenState>}</ScreenState>}</ScreenState>;
    if ((job.header.family === "lca" || job.header.family === "pcf") && jobModuleEnabled("job-module-lca")) return <ScreenState result={lca}>{(lcaData) => <ScreenState result={factors}>{(factorData) => <ScreenState result={lcaComponents}>{(componentData) => <LcaWorkspace job={job} assessments={lcaData.assessments} factors={factorData.factors} components={componentData.components} categories={componentData.categories}/>}</ScreenState>}</ScreenState>}</ScreenState>;
    // Track C — the training module, behind `job-module-training`; FamilyWorkspace still
    // serves training jobs while the flag is off. `today` is resolved here, on the server,
    // so every place's expiry is judged against one date rather than the viewer's clock.
    if (job.header.family === "training" && jobModuleEnabled("job-module-training")) return <ScreenState result={training}>{(trainingData) => <TrainingWorkspace job={job} runs={trainingData.runs} today={todayInLondon()} writeEnabled={process.env.NZI_WRITE_API_ENABLED === "true"}/>}</ScreenState>;
    return <FamilyWorkspace job={job} />;
  }}</ScreenState>;
}
