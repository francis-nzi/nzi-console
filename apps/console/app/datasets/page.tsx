import { datasetAuditIssues, datasets } from "@nzi/mock-data";
import { loadFixtureScreen } from "@nzi/api-client";
import { ScreenState } from "../lib/ScreenState";
import { DatasetBoard } from "./DatasetBoard";
export default function DatasetsPage() {
  const result = loadFixtureScreen<{ datasets: typeof datasets; issues: typeof datasetAuditIssues }>("datasets", { datasets, issues: datasetAuditIssues });
  return <ScreenState result={result}>{(data) => <DatasetBoard datasets={data.datasets} issues={data.issues} />}</ScreenState>;
}
