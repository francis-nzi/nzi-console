import { AppShell, WorkspaceRail, TopBar } from "@nzi/ui";
import { NAV, USER } from "../lib/nav";
import { crumbTrail, workspaceCrumbs } from "../lib/crumbTrail";
import { KnowledgeWorkspace } from "./KnowledgeViews";

// The knowledge library (NZC-081) — NZI's own shared knowledge.
//
// KEPT alongside the help drawer, deliberately. The drawer answers the question you have
// while working; this is the management view — a review queue is real work, and doing it in
// a 420px panel beside the page you were reading is worse than doing it on a page of its own.
//
// They are not two copies: both hosts render the SAME KnowledgeLibrary and KnowledgeReview
// components, so there is one implementation and no way for the surfaces to drift. A test
// holds that.
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
