"use client";
import {type FormEvent,useCallback,useEffect,useMemo,useState} from "react";
import type {PortalDataEntryRecord} from "@nzi/isolated-backend";
import {formatDate} from "../lib/formatDate";
import {parseSpendLedger,suggestCategory} from "../jobs/spendLedger";
import {redirectIfPortalSessionEnded} from "./portalSessionClient";

// B5 — client-portal spend mirror (NZC-016 / NZC-036, flag `portal-spend`). A
// constrained mirror of the consultant B2 SpendLedgerAdapter: paste or key a
// spend ledger into an NZI-authorised Scope 3.1 bucket, confirm a category and
// factor from the authorised sets, then submit drafts through the unchanged
// portal review spine. Factor mapping and sync-to-scope stay staff-side.
type Category={id:string;name:string};
type Factor={id:string;label:string;unit:string};
type SpendBucket={bucketGrantId:string;sourceLabel:string;units:string[];factors:Factor[];pgsCategories:Category[]};
type Draft={key:string;description:string;netValue:number|null;vatPercent:number|null;glCode:string|null;invoiceDate:string|null;categoryId:string;factorId:string;months:Record<string,number|null>;split:boolean;state:""|"saving"|"saved"|"failed";detail:string};

const SAMPLE="Description\tNet\tVAT %\tGL code\tDate\nOffice paper and stationery\t1240.00\t20\t7504\t14/03/2025\nCourier and postage\t880.50\t20\t7501\t02/04/2025";
const monthLabel=(key:string)=>new Date(`${key}-01T00:00:00Z`).toLocaleDateString("en-GB",{month:"short",year:"numeric",timeZone:"UTC"});
const blankDraft=(categories:Category[],line?:Partial<Draft>):Draft=>({key:crypto.randomUUID(),description:line?.description??"",netValue:line?.netValue??null,vatPercent:line?.vatPercent??null,glCode:line?.glCode??null,invoiceDate:line?.invoiceDate??null,categoryId:categories.find(category=>category.name===suggestCategory(line?.description??"",categories))?.id??"",factorId:"",months:{},split:false,state:"",detail:""});

export function PortalSpendEntry({jobId,buckets,reportingMonths}:{jobId:string;buckets:SpendBucket[];reportingMonths:string[]}){
  const [selected,setSelected]=useState(buckets[0]?.bucketGrantId??"");
  const bucket=useMemo(()=>buckets.find(item=>item.bucketGrantId===selected)??buckets[0]!,[buckets,selected]);
  const [raw,setRaw]=useState("");
  const [drafts,setDrafts]=useState<Draft[]>([]);
  const [records,setRecords]=useState<PortalDataEntryRecord[]|null>(null);
  const [busy,setBusy]=useState(false);
  const [pending,setPending]=useState("");
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const currency=bucket.units[0]??"GBP";

  const load=useCallback(async()=>{try{const response=await fetch(`/api/portal/jobs/${jobId}/data-entry-records`,{cache:"no-store"});if(await redirectIfPortalSessionEnded(response))return;const body=await response.json();if(!response.ok||!Array.isArray(body.records))throw new Error(body.message??"Submitted spend entries are unavailable.");setRecords(body.records.filter((record:PortalDataEntryRecord)=>record.entryKind==="spend"))}catch(cause){setError(cause instanceof Error?cause.message:"Submitted spend entries are unavailable.");setRecords(null)}},[jobId]);
  useEffect(()=>{void load()},[load]);

  const update=(key:string,patch:Partial<Draft>)=>setDrafts(current=>current.map(draft=>draft.key===key?{...draft,...patch}:draft));
  const remove=(key:string)=>setDrafts(current=>current.filter(draft=>draft.key!==key));

  function parse(){
    const parsed=parseSpendLedger(raw).map(line=>blankDraft(bucket.pgsCategories,line));
    setDrafts(current=>[...current,...parsed]);
    setRaw("");
    setNotice(parsed.length?`${parsed.length} line${parsed.length===1?"":"s"} added below. Confirm a category and factor for each, then submit.`:"No spend lines were recognised. Expected a description, net value, VAT %, GL code and date.");
  }

  const ready=(draft:Draft)=>draft.description.trim()!==""&&draft.netValue!==null&&draft.netValue>0&&Boolean(draft.categoryId)&&Boolean(draft.factorId);

  async function saveDrafts(){
    if(busy)return;
    const toSave=drafts.filter(draft=>draft.state!=="saved"&&ready(draft));
    if(toSave.length===0){setError("Add at least one line with a description, net value, category and factor.");return}
    setBusy(true);setError("");setNotice("");
    let ok=0;
    for(const draft of toSave){
      update(draft.key,{state:"saving",detail:""});
      const monthly=draft.split?reportingMonths.map(month=>({month,quantity:draft.months[month]??null})):[];
      const factor=bucket.factors.find(item=>item.id===draft.factorId);
      const payload={bucketGrantId:bucket.bucketGrantId,quantity:0,unit:factor?.unit??currency,factorId:draft.factorId,siteId:null,note:draft.description.trim(),detail:{netValue:draft.netValue,vatPercent:draft.vatPercent,glCode:draft.glCode,pgsCategoryId:draft.categoryId,invoiceDate:draft.invoiceDate,monthlyActivity:monthly}};
      try{
        const response=await fetch(`/api/portal/jobs/${jobId}/data-entry-records`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
        if(await redirectIfPortalSessionEnded(response))return;
        const body=await response.json();
        if(!response.ok)throw new Error(body.message??"The draft could not be saved.");
        update(draft.key,{state:"saved",detail:"Saved as a draft. Submit it below when you are ready."});ok+=1;
      }catch(cause){update(draft.key,{state:"failed",detail:cause instanceof Error?cause.message:"The draft outcome could not be verified."})}
    }
    setBusy(false);
    if(ok)await load();
    setNotice(ok?`${ok} spend line${ok===1?"":"s"} saved as drafts. Nothing is submitted until you choose Submit for review.`:"");
  }

  async function act(record:PortalDataEntryRecord,action:"delete"|"submit"){
    if(action==="delete"&&!window.confirm("Delete this spend draft?"))return;
    setPending(`${action}:${record.recordId}`);setError("");setNotice("");
    try{
      const response=await fetch(`/api/portal/jobs/${jobId}/data-entry-records`,{method:action==="delete"?"DELETE":"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action,recordId:record.recordId,expectedVersion:record.version})});
      if(await redirectIfPortalSessionEnded(response))return;
      const body=await response.json();
      if(response.status===409){await load();throw new Error("This draft changed elsewhere. The latest version has been loaded.")}
      if(!response.ok)throw new Error(body.message??`The draft could not be ${action}ed.`);
      setNotice(action==="submit"?"Spend entry submitted to NZI for review. It does not count as reviewed carbon emissions until an NZI reviewer accepts it.":"Draft deleted.");
      await load();
    }catch(cause){setError(cause instanceof Error?cause.message:"The entry outcome could not be verified.")}finally{setPending("")}
  }

  function addManual(event:FormEvent<HTMLFormElement>){event.preventDefault();setDrafts(current=>[...current,blankDraft(bucket.pgsCategories)]);}

  return (
    <section className="nz-panel" id="portal-spend-entry" style={{padding:16,marginTop:16}}>
      <span className="nz-eyebrow">Data entry · purchased goods &amp; services spend</span>
      <h3 style={{margin:"6px 0"}}>Enter spend for {bucket.sourceLabel}</h3>
      <p className="sub">Paste your purchase ledger or add lines one at a time. For each line, confirm a purchased-goods category and an emission factor from the sets your NZI adviser has authorised. NZI checks and calculates every line before it becomes part of your carbon emissions.</p>
      {error?<div className="nz-banner warn" role="alert">{error}</div>:null}
      {notice?<div className="nz-banner ok" role="status">{notice}</div>:null}

      {buckets.length>1?(
        <label className="nz-fl" style={{maxWidth:360}}>Authorised spend bucket
          <select className="nz-inp" value={bucket.bucketGrantId} onChange={event=>{setSelected(event.target.value);setDrafts([])}}>
            {buckets.map(item=><option key={item.bucketGrantId} value={item.bucketGrantId}>{item.sourceLabel}</option>)}
          </select>
        </label>
      ):null}

      {bucket.pgsCategories.length===0?<div className="nz-banner warn" role="alert">No purchased-goods categories have been authorised for this bucket yet. Ask your NZI adviser to add them before entering spend.</div>:(
        <>
          <label className="nz-fl" style={{marginTop:12}}>Paste ledger lines <span className="muted">(description, net value, VAT %, GL code, date — dd/mm/yyyy)</span>
            <textarea className="nz-notes" rows={5} value={raw} placeholder={SAMPLE} onChange={event=>setRaw(event.target.value)}/>
          </label>
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            <button type="button" className="nz-btn" onClick={()=>setRaw(SAMPLE)}>Use sample</button>
            <button type="button" className="nz-btn pri" disabled={!raw.trim()} onClick={parse}>Add pasted lines</button>
            <form onSubmit={addManual}><button type="submit" className="nz-btn">Add a blank line</button></form>
          </div>

          {drafts.length>0?(
            <div style={{overflowX:"auto",marginTop:14}}>
              <table className="nz-tbl">
                <thead><tr><th>Description</th><th className="num">Net ({currency})</th><th className="num">VAT %</th><th>GL code</th><th>Invoice date</th><th>Category</th><th>Factor</th><th>Reporting months</th><th>Status</th><th/></tr></thead>
                <tbody>
                  {drafts.map(draft=>{
                    const suggestion=bucket.pgsCategories.find(category=>category.name===suggestCategory(draft.description,bucket.pgsCategories));
                    return (
                      <tr key={draft.key}>
                        <td><input className="nz-inp" aria-label={`Description for ${draft.description||"line"}`} value={draft.description} onChange={event=>update(draft.key,{description:event.target.value})}/></td>
                        <td className="num"><input className="nz-inp" type="number" min="0" step="any" aria-label={`Net value for ${draft.description||"line"}`} value={draft.netValue??""} onChange={event=>update(draft.key,{netValue:event.target.value===""?null:Number(event.target.value)})}/></td>
                        <td className="num"><input className="nz-inp" type="number" min="0" max="100" step="any" aria-label={`VAT percent for ${draft.description||"line"}`} value={draft.vatPercent??""} onChange={event=>update(draft.key,{vatPercent:event.target.value===""?null:Number(event.target.value)})}/></td>
                        <td><input className="nz-inp" aria-label={`GL code for ${draft.description||"line"}`} value={draft.glCode??""} onChange={event=>update(draft.key,{glCode:event.target.value||null})}/></td>
                        <td><input className="nz-inp" type="date" aria-label={`Invoice date for ${draft.description||"line"}`} value={draft.invoiceDate??""} onChange={event=>update(draft.key,{invoiceDate:event.target.value||null})}/><span className="muted">{formatDate(draft.invoiceDate)||"—"}</span></td>
                        <td>
                          <select className="nz-sel" aria-label={`Purchased-goods category for ${draft.description||"line"}`} value={draft.categoryId} onChange={event=>update(draft.key,{categoryId:event.target.value})}>
                            <option value="">Select a category</option>
                            {bucket.pgsCategories.map(category=><option key={category.id} value={category.id}>{category.name}</option>)}
                          </select>
                          {suggestion&&suggestion.id!==draft.categoryId?<button type="button" className="nz-btn" style={{marginTop:3}} onClick={()=>update(draft.key,{categoryId:suggestion.id})}>Suggest: {suggestion.name}</button>:null}
                        </td>
                        <td>
                          <select className="nz-sel" aria-label={`Emission factor for ${draft.description||"line"}`} value={draft.factorId} onChange={event=>update(draft.key,{factorId:event.target.value})}>
                            <option value="">Select a factor</option>
                            {bucket.factors.map(factor=><option key={factor.id} value={factor.id}>{factor.label} · {factor.unit}</option>)}
                          </select>
                        </td>
                        <td>
                          {reportingMonths.length>0?(
                            <details open={draft.split} onToggle={event=>update(draft.key,{split:(event.target as HTMLDetailsElement).open})}>
                              <summary>{draft.split?"Split by month":"Whole value in one year"}</summary>
                              <div style={{display:"grid",gap:4,marginTop:6}}>
                                {reportingMonths.map(month=>(
                                  <label key={month} style={{display:"flex",gap:6,alignItems:"center",fontSize:12}}>
                                    <span style={{minWidth:72}}>{monthLabel(month)}</span>
                                    <input className="nz-inp" type="number" min="0" step="any" aria-label={`${monthLabel(month)} value for ${draft.description||"line"}`} value={draft.months[month]??""} onChange={event=>update(draft.key,{months:{...draft.months,[month]:event.target.value===""?null:Number(event.target.value)}})}/>
                                  </label>
                                ))}
                              </div>
                            </details>
                          ):<span className="muted">Annual</span>}
                        </td>
                        <td><span className={`nz-st ${draft.state==="saved"?"done":draft.state==="failed"?"nof":"need"}`}>{draft.state==="saving"?"Saving…":draft.state==="saved"?"Saved":draft.state==="failed"?"Failed":ready(draft)?"Ready":"Incomplete"}</span>{draft.detail?<div className="muted">{draft.detail}</div>:null}</td>
                        <td>{draft.state!=="saved"?<button type="button" className="nz-btn" onClick={()=>remove(draft.key)}>Remove</button>:null}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ):null}

          {drafts.some(draft=>draft.state!=="saved")?<div style={{marginTop:12}}><button type="button" className="nz-btn pri" disabled={busy} onClick={()=>void saveDrafts()}>{busy?"Saving…":`Save ${drafts.filter(draft=>draft.state!=="saved"&&ready(draft)).length} line${drafts.filter(draft=>draft.state!=="saved"&&ready(draft)).length===1?"":"s"} as drafts`}</button></div>:null}
        </>
      )}

      <h4 style={{margin:"18px 0 6px"}}>Your spend entries</h4>
      <div className="nz-panel" style={{padding:0}}>
        <table className="nz-tbl">
          <thead><tr><th>Description</th><th className="num">Net</th><th>Status</th><th/></tr></thead>
          <tbody>
            {records?.map(record=>(
              <tr key={record.recordId}>
                <td><b>{record.note||"Spend line"}</b>{record.detail?.pgsCategoryId?<div className="muted">Category set · {record.detail.monthlyActivity.length>0?"monthly split":"annual"}</div>:null}</td>
                <td className="num">{record.detail?.netValue??record.quantity} {record.unit}</td>
                <td><span className={`nz-st ${record.status==="submitted"?"est":"need"}`}>{record.status==="submitted"?"With NZI for review":"Draft"}</span></td>
                <td style={{textAlign:"right"}}>{record.status==="draft"?<>
                  <button className="nz-btn" disabled={pending!==""} onClick={()=>void act(record,"delete")}>{pending===`delete:${record.recordId}`?"Deleting…":"Delete"}</button>{" "}
                  <button className="nz-btn pri" disabled={pending!==""} onClick={()=>void act(record,"submit")}>{pending===`submit:${record.recordId}`?"Submitting…":"Submit for review"}</button>
                </>:<span className="muted">Awaiting NZI review</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {records===null?<div className="nz-table-empty">Submitted spend entries are unavailable.</div>:records.length===0?<div className="nz-table-empty">No spend entries yet.</div>:null}
      </div>
    </section>
  );
}
