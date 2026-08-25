import { lcaAssessments } from "@nzi/mock-data";
import { loadFixtureScreen } from "@nzi/api-client";
import { ScreenState } from "../lib/ScreenState";
import { LcaBoard } from "./LcaBoard";

export default function LcaPage() {
  const result = loadFixtureScreen<{ assessments: typeof lcaAssessments }>("lca", { assessments: lcaAssessments });
  return <ScreenState result={result}>{(data) => <LcaBoard assessments={data.assessments} />}</ScreenState>;
}
