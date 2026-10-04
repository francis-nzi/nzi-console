import { todayInLondon } from "@nzi/contracts";
import { AppShell, TopBar, WorkspaceRail } from "@nzi/ui";
import { crumbTrail, workspaceCrumbs } from "../lib/crumbTrail";
import { NAV, USER } from "../lib/nav";
import { TimeBoard } from "./TimeBoard";

export const dynamic = "force-dynamic";

/**
 * Time (TIME module; the approved mockup is the visual spec). Log time and My time (PR A); Oversight, Payroll and
 * Utilisation (PR B), each a read for the chosen period. `?job=` pre-fills the job — the per-job "+ Log time" lands here.
 * "Today" is the London day, resolved on the server, so every period is judged against one date.
 */
export default async function TimePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const job = typeof params.job === "string" ? params.job : null;
  return <AppShell rail={<WorkspaceRail sections={NAV} activeId="time" user={USER} />}>
    <TopBar crumbs={crumbTrail(workspaceCrumbs("Time", "/time"))} />
    <TimeBoard today={todayInLondon()} initialJobId={job} writeEnabled={process.env.NZI_WRITE_API_ENABLED === "true"} />
  </AppShell>;
}
