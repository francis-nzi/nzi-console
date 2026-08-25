import { datasetAuditIssues, datasets } from "@nzi/mock-data";
import { DatasetBoard } from "./DatasetBoard";
export default function DatasetsPage() { return <DatasetBoard datasets={datasets} issues={datasetAuditIssues} />; }
