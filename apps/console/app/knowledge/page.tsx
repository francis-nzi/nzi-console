import { AppShell, WorkspaceRail, TopBar } from "@nzi/ui";
import { NAV, USER } from "../lib/nav";
import { crumbTrail, workspaceCrumbs } from "../lib/crumbTrail";
import { KnowledgeWorkspace } from "./KnowledgeViews";

// The knowledge library (NZC-081) — NZI's own shared knowledge, browsable by everyone here
// and reviewed by capability-holders. 0b re-hosts these same views as help-drawer tabs; this
// page is what makes the pipeline usable and testable before the drawer exists.
export const dynamic = "force-dynamic";

export default function KnowledgePage() {
  const writeEnabled = process.env.NZI_DATA_MODE === "isolated-api";
  return (
    <AppShell rail={<WorkspaceRail sections={NAV} activeId="knowledge" user={USER} />}>
      <TopBar
        searchPlaceholder="Search the knowledge library…"
        crumbs={crumbTrail(workspaceCrumbs("Knowledge", "/knowledge"))}
      />
      <KnowledgeWorkspace writeEnabled={writeEnabled} />
    </AppShell>
  );
}
