import Link from "next/link";
import { Breadcrumbs, type Crumb } from "@nzi/ui";

export { clientCrumbs, clientJobsHref, jobCrumbs, workspaceCrumbs } from "./crumbs";

/** The trail as the TopBar wants it, wired to the app router's link. */
export function crumbTrail(items: Crumb[]) {
  return <Breadcrumbs items={items} link={Link} />;
}
