import { lcaAssessments } from "@nzi/mock-data";
import { LcaBoard } from "./LcaBoard";

export default function LcaPage() { return <LcaBoard assessments={lcaAssessments} />; }
