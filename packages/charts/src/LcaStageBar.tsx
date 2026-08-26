import type { CSSProperties } from "react";
import type { LcaStageBarData } from "./types";
import { comma, niceTicks, scaleLinear } from "./geometry";
import { formatDate } from "./EmissionsScopeDonut";
import { tokens } from "./tokens";

const W=760,H=330,M={top:24,right:24,bottom:62,left:68};
export function LcaStageBar({data,width,showChrome=true}:{data:LcaStageBarData;width?:number;showChrome?:boolean}){
  const max=Math.max(0,...data.stages.map(stage=>stage.value)),ticks=niceTicks(max,4),yMax=ticks.at(-1)??1;
  const y=scaleLinear(0,yMax,H-M.bottom,M.top),plotWidth=W-M.left-M.right,slot=plotWidth/Math.max(1,data.stages.length),barWidth=Math.min(66,slot*.58);
  const svg=<svg viewBox={`0 0 ${W} ${H}`} width={width??"100%"} height={width?width*H/W:undefined} role="img" aria-label={data.spec.title} style={{display:"block",fontFamily:tokens.font}}>
    {ticks.map(tick=><g key={tick}><line x1={M.left} x2={W-M.right} y1={y(tick)} y2={y(tick)} stroke={tokens.line}/><text x={M.left-10} y={y(tick)+4} textAnchor="end" fontSize={10} fill={tokens.ink.muted}>{comma(tick)}</text></g>)}
    {data.stages.map((stage,index)=>{const x=M.left+slot*index+(slot-barWidth)/2,top=y(stage.value),fill=stage.status==="provisional"?tokens.brand.amber:tokens.brand.emerald;return <g key={stage.id}><rect x={x} y={top} width={barWidth} height={Math.max(0,H-M.bottom-top)} rx={5} fill={fill}><title>{`${stage.label}: ${comma(stage.value)} ${data.unit}`}</title></rect><text x={x+barWidth/2} y={top-8} textAnchor="middle" fontSize={11} fontWeight={650} fill={tokens.ink.primary}>{comma(stage.value)}</text><text x={x+barWidth/2} y={H-M.bottom+18} textAnchor="middle" fontSize={10.5} fill={tokens.ink.secondary}>{stage.label}</text>{stage.status==="provisional"&&<text x={x+barWidth/2} y={H-M.bottom+34} textAnchor="middle" fontSize={8.5} fill={tokens.ink.muted}>PROVISIONAL</text>}</g>})}
  </svg>;
  return showChrome?<figure style={frame}><figcaption><span style={kick}>{data.spec.subtitle??data.functionalUnit}</span><h3 style={title}>{data.spec.title}</h3></figcaption>{svg}<p style={footer}><b>Source</b>{"  "}{data.provenance.factorSets.join(" · ")} · as at {formatDate(data.provenance.generatedAt)}</p></figure>:svg;
}
const frame:CSSProperties={background:tokens.surface,border:`1px solid ${tokens.line}`,borderRadius:12,padding:"16px 18px 12px",margin:0};
const kick:CSSProperties={fontSize:10.5,letterSpacing:".12em",textTransform:"uppercase",color:tokens.brand.emerald,fontWeight:600};
const title:CSSProperties={fontSize:16,fontWeight:600,margin:"3px 0 2px",color:tokens.ink.primary};
const footer:CSSProperties={fontSize:11,color:tokens.ink.muted,margin:"8px 0 2px"};
