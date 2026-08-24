import { AppShell, TopBar, WorkspaceRail } from "@nzi/ui";
import { ChartProof } from "../charts/ChartProof";
import { NAV, USER } from "../lib/nav";

export default function PortalPreviewPage() {
  return (
    <AppShell rail={<WorkspaceRail sections={NAV} activeId="emissions" user={USER} />}>
      <TopBar searchPlaceholder="Client portal preview…" crumbs={<>Client portal <span className="muted">/</span> <b>Impact</b></>} />
      <div className="nz-head"><h1>Your carbon impact</h1><div className="sub">Client-facing preview · same reviewed chart objects</div></div>
      <div className="nz-body"><div style={{ paddingTop: 16 }}><ChartProof target="portal" label="Client portal" /></div></div>
    </AppShell>
  );
}
