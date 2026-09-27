import { WorkspaceNotFound } from "../../lib/ScreenState";

export default function JobNotFound() {
  return <WorkspaceNotFound chrome={{ activeId: "jobs", label: "Jobs", href: "/jobs" }} what="job" />;
}
