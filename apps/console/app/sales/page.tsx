import { prospectingRuns, salesOpportunities, salesProspects } from "@nzi/mock-data";
import { SalesBoard } from "./SalesBoard";

export default function SalesPage() { return <SalesBoard opportunities={salesOpportunities} prospects={salesProspects} runs={prospectingRuns} />; }
