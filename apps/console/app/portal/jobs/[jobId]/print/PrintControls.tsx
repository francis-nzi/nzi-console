"use client";
export function PrintControls(){return <div className="print-controls" style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 18px",background:"#0B1B2B",color:"white"}}><a href="../" style={{color:"white"}}>← Back to portal report</a><button className="nz-btn pri" onClick={()=>window.print()}>Print or save as PDF</button></div>}
