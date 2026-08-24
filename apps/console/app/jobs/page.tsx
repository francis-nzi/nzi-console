import { jobs } from "@nzi/mock-data";
import { JobsIndex } from "./JobsIndex";

export default function JobsPage() {
  return <JobsIndex jobs={jobs} />;
}
