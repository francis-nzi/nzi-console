"use client";
export function PrintButton() { return <button onClick={() => window.print()} style={{ border: 0, borderRadius: 7, background: "#0BA75E", color: "white", padding: "9px 14px", fontWeight: 600, cursor: "pointer" }}>Print / save PDF</button>; }
