import { jobs } from "@nzi/mock-data";
import { loadFixtureScreen } from "@nzi/api-client";
import { ScreenState } from "../lib/ScreenState";
import { JobsIndex } from "./JobsIndex";

export default function JobsPage() {
  const result = loadFixtureScreen<{ jobs: typeof jobs }>("jobs", { jobs });
  return <ScreenState result={result}>{(data) => <JobsIndex jobs={data.jobs} />}</ScreenState>;
}
