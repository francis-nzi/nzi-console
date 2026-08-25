import { prospectingRuns, salesOpportunities, salesProspects } from "@nzi/mock-data";
import { loadFixtureScreen } from "@nzi/api-client";
import { ScreenState } from "../lib/ScreenState";
import { SalesBoard } from "./SalesBoard";

type SalesPayload = { opportunities: typeof salesOpportunities; prospects: typeof salesProspects; runs: typeof prospectingRuns };
export default function SalesPage() {
  const result = loadFixtureScreen<SalesPayload>("sales", { opportunities: salesOpportunities, prospects: salesProspects, runs: prospectingRuns });
  return <ScreenState result={result}>{(data) => <SalesBoard opportunities={data.opportunities} prospects={data.prospects} runs={data.runs} />}</ScreenState>;
}
