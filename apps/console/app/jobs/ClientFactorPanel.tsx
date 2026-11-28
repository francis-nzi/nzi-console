"use client";
import {useRouter} from "next/navigation";
import {type FactorOption} from "@nzi/contracts";
import {dataEntryAdapterEnabled} from "../lib/featureFlags";
import {ClientFactorsManager} from "../clients/ClientFactorsManager";
import {ClientFactorCreateForm} from "../clients/ClientFactorCreateForm";

export function ClientFactorPanel({jobId,clientId,factors,notice}:{jobId:string;clientId?:string;factors:FactorOption[];notice:(n:{kind:"ok"|"warn";text:string})=>void}){const router=useRouter(),count=factors.filter(f=>f.factorSource==="client").length;const managed=dataEntryAdapterEnabled("client-factors")&&Boolean(clientId);return <>{managed&&clientId?<ClientFactorsManager clientId={clientId} jobId={jobId} compact/>:null}<section className="nz-panel nz-config-panel"><div className="nz-config-head"><div><span className="nz-eyebrow">Client methodology</span><b>{managed?"Add a client emission factor":"Client-specific emission factors"}</b><div className="sub">Reusable or job-pinned factors with evidence hashes carried into calculation provenance.</div></div><span className="nz-st done">{count} on this job</span></div><ClientFactorCreateForm endpoint={`/api/isolated/jobs/${jobId}/client-factors`} reusableChoice onCreated={()=>router.refresh()} notice={notice}/></section></>}
