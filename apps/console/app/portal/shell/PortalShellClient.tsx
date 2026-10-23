"use client";
// The portal shell for a signed-in client: the portfolio and the identity, read as the old home reads them (`/api/portal/jobs`,
// `/api/portal/auth/me`), then the view framed in the shell. A view that needs a job and is given none (the landing) opens on
// the default job. A failed read is said as failed, never as a client with no jobs.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { isPortalIdentity, isPortalJobList, type PortalIdentity, type PortalJob } from "../portalPortfolioValidation";
import { redirectIfPortalSessionEnded } from "../portalSessionClient";
import { PortalShell } from "./PortalShell";
import { defaultShellJob, type ShellView } from "./shellNav";

type Load = { state: "loading" } | { state: "failed"; message: string } | { state: "ready"; jobs: PortalJob[]; user: PortalIdentity };

/**
 * `children` is the view: a node when the page already knows what to draw (a server page passing `<PortalDataView jobId />`),
 * or a function of the job in context when it does not (the landing, which opens on the default job).
 */
export function PortalShellClient({ view, jobId, children }: { view: ShellView; jobId?: string; children: ReactNode | ((jobId: string | null) => ReactNode) }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [signingOut, setSigningOut] = useState(false);
  const read = useCallback(async () => {
    setLoad({ state: "loading" });
    try {
      const [jobsResponse, userResponse] = await Promise.all([fetch("/api/portal/jobs", { cache: "no-store" }), fetch("/api/portal/auth/me", { cache: "no-store" })]);
      if (await redirectIfPortalSessionEnded(jobsResponse) || await redirectIfPortalSessionEnded(userResponse)) return;
      if (!jobsResponse.ok || !userResponse.ok) throw new Error("Your secure workspace could not be loaded.");
      const jobsBody: unknown = await jobsResponse.json(), user: unknown = await userResponse.json();
      const jobs = jobsBody && typeof jobsBody === "object" ? (jobsBody as { jobs?: unknown }).jobs : undefined;
      if (!isPortalJobList(jobs) || !isPortalIdentity(user)) throw new Error("Your secure workspace returned an invalid response.");
      setLoad({ state: "ready", jobs, user });
    } catch (cause) { setLoad({ state: "failed", message: cause instanceof Error ? cause.message : "Your secure workspace could not be loaded." }); }
  }, []);
  useEffect(() => { void read(); }, [read]);

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    try { await fetch("/api/portal/auth/logout", { method: "POST" }); } finally { window.location.assign("/portal/login"); }
  }

  if (load.state === "loading") return <div className="nz-portal-state loading" role="status"><i>↻</i><div><b>Loading your secure workspace</b><span>Checking your account and job-level access grants…</span></div></div>;
  if (load.state === "failed") return <div className="nz-portal-state failed" role="alert"><i>!</i><div><b>Your workspace is temporarily unavailable</b><span>{load.message} No access or report totals have been inferred.</span><button className="nz-btn" onClick={() => void read()}>Try again</button></div></div>;

  const { jobs, user } = load;
  // The job the URL names (the view's own grant-checked read refuses one the user does not hold), else the default.
  const current = jobId ?? defaultShellJob(jobs)?.id ?? null;
  return (
    <PortalShell
      client={{ name: user.clientName?.trim() || "Your organisation", logoSrc: user.clientLogoAssetId ? `/api/portal/logo?v=${encodeURIComponent(user.clientLogoAssetId)}` : null }}
      jobs={jobs} jobId={current} view={view}
      person={{ kind: "client", name: user.displayName, detail: user.email, onSignOut: () => void signOut(), signingOut }}>
      {current || view !== "dashboard" ? (typeof children === "function" ? children(current) : children) : <div className="nz-portal-state empty"><i>✓</i><div><b>No reporting jobs yet</b><span>Your adviser will grant access when a reporting job is ready.</span></div></div>}
    </PortalShell>
  );
}
