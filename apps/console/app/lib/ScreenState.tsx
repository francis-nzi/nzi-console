import type { ReactNode } from "react";
import type { ScreenResult } from "@nzi/contracts";

export function ScreenState<T>({ result, children }: { result: ScreenResult<T>; children: (data: T, warning?: string) => ReactNode }) {
  if (result.state === "loading") return <State title="Loading workspace…" detail="The requested screen data is being retrieved." />;
  if (result.state === "empty") return <State title="Nothing here yet" detail={result.message} />;
  if (result.state === "failed") return <State title="Workspace unavailable" detail={`${result.error.message} · ${result.error.correlationId ?? result.meta.requestId}`} danger />;
  return <>{result.state === "degraded" ? <div className="nz-banner warn" style={{ margin: 18 }}><div><b>Some data may be incomplete.</b><div style={{ marginTop: 4 }}>{result.warning.message} · {result.warning.correlationId ?? result.meta.requestId}</div></div></div> : null}{children(result.data, result.state === "degraded" ? result.warning.message : undefined)}</>;
}
function State({ title, detail, danger = false }: { title: string; detail: string; danger?: boolean }) { return <div className="nz-body"><div className={`nz-banner ${danger ? "warn" : "ok"}`}><div><b>{title}</b><div style={{ marginTop: 4 }}>{detail}</div></div></div></div>; }
