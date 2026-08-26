import type { CSSProperties } from "react";
import type { TrainingAttendanceData } from "./types";
import { comma, niceTicks, scaleLinear } from "./geometry";
import { formatDate } from "./EmissionsScopeDonut";
import { tokens } from "./tokens";

const W=760,H=330,M={top:28,right:24,bottom:66,left:58};
const series=[{key:"invited" as const,label:"Invited",color:"#B8C6C1"},{key:"attended" as const,label:"Attended",color:tokens.brand.pine},{key:"completed" as const,label:"Completed",color:tokens.brand.emerald}];
export function TrainingAttendance({data,width,showChrome=true}:{data:TrainingAttendanceData;width?:number;showChrome?:boolean}){
  const max=Math.max(0,...data.cohorts.flatMap(cohort=>series.map(item=>cohort[item.key]))),ticks=niceTicks(max,4),yMax=ticks.at(-1)??1,y=scaleLinear(0,yMax,H-M.bottom,M.top),plotWidth=W-M.left-M.right,slot=plotWidth/Math.max(1,data.cohorts.length),barWidth=Math.min(28,slot/(series.length+1));
  const svg=<svg viewBox={`0 0 ${W} ${H}`} width={width??"100%"} height={width?width*H/W:undefined} role="img" aria-label={data.spec.title} style={{display:"block",fontFamily:tokens.font}}>
    {ticks.map(tick=><g key={tick}><line x1={M.left} x2={W-M.right} y1={y(tick)} y2={y(tick)} stroke={tokens.line}/><text x={M.left-9} y={y(tick)+4} textAnchor="end" fontSize={10} fill={tokens.ink.muted}>{comma(tick)}</text></g>)}
    {data.cohorts.map((cohort,index)=>{const groupX=M.left+index*slot+slot/2-(barWidth*series.length)/2;return <g key={cohort.id}>{series.map((item,seriesIndex)=>{const value=cohort[item.key],x=groupX+seriesIndex*barWidth,top=y(value);return <rect key={item.key} x={x} y={top} width={barWidth-3} height={Math.max(0,H-M.bottom-top)} rx={3} fill={item.color}><title>{`${cohort.label} · ${item.label}: ${value}`}</title></rect>})}<text x={M.left+index*slot+slot/2} y={H-M.bottom+20} textAnchor="middle" fontSize={10.5} fill={tokens.ink.secondary}>{cohort.label}</text></g>})}
    {series.map((item,index)=><g key={item.key} transform={`translate(${M.left+index*108},${H-18})`}><rect width="11" height="11" rx="2" fill={item.color}/><text x="16" y="9" fontSize="10" fill={tokens.ink.secondary}>{item.label}</text></g>)}
  </svg>;
  return showChrome?<figure style={frame}><figcaption><span style={kick}>{data.spec.subtitle??"Learning outcomes"}</span><h3 style={title}>{data.spec.title}</h3></figcaption>{svg}<p style={footer}><b>Source</b>{"  "}{data.provenance.factorSets.join(" · ")} · as at {formatDate(data.provenance.generatedAt)}</p></figure>:svg;
}
const frame:CSSProperties={background:tokens.surface,border:`1px solid ${tokens.line}`,borderRadius:12,padding:"16px 18px 12px",margin:0};
const kick:CSSProperties={fontSize:10.5,letterSpacing:".12em",textTransform:"uppercase",color:tokens.brand.emerald,fontWeight:600};
const title:CSSProperties={fontSize:16,fontWeight:600,margin:"3px 0 2px",color:tokens.ink.primary};
const footer:CSSProperties={fontSize:11,color:tokens.ink.muted,margin:"8px 0 2px"};
