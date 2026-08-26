import type { ReactNode } from "react";
import type { ScreenResult } from "@nzi/contracts";

type StateKind = "loading" | "empty" | "failed";

export function ScreenState<T>({ result, children }: { result: ScreenResult<T>; children: (data: T, warning?: string) => ReactNode }) {
  if (result.state === "loading") return <State kind="loading" title="Loading workspace" detail="The requested screen data is being retrieved." />;
  if (result.state === "empty") return <State kind="empty" title="Nothing here yet" detail={result.message} />;
  if (result.state === "failed") return <State kind="failed" title="Workspace unavailable" detail={result.error.message} reference={result.error.correlationId ?? result.meta.requestId} />;
  return <>{result.state === "degraded" ? <aside className="nz-degraded-state" role="status"><span className="nz-state-icon">!</span><div><b>Some data may be incomplete</b><p>{result.warning.message}</p><small>Reference {result.warning.correlationId ?? result.meta.requestId}</small></div></aside> : null}{children(result.data, result.state === "degraded" ? result.warning.message : undefined)}</>;
}

function State({ kind, title, detail, reference }: { kind: StateKind; title: string; detail: string; reference?: string }) {
  const icon = kind === "loading" ? "↻" : kind === "empty" ? "＋" : "!";
  return <main className={`nz-screen-state ${kind}`} role={kind === "failed" ? "alert" : "status"} aria-live="polite"><section><span className="nz-state-icon" aria-hidden="true">{icon}</span><div><span className="nz-eyebrow">{kind === "loading" ? "Retrieving data" : kind === "empty" ? "Ready for first record" : "Data unavailable"}</span><h1>{title}</h1><p>{detail}</p>{reference ? <small>Reference {reference}</small> : null}</div></section></main>;
}
