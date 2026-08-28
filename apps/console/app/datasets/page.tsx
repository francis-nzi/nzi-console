import type {DatasetRegistryIssue,DatasetRegistryItem} from "@nzi/isolated-backend";
import {loadScreen} from "../lib/loadScreen";
import { ScreenState } from "../lib/ScreenState";
import { DatasetBoard } from "./DatasetBoard";
export const dynamic="force-dynamic";
export default async function DatasetsPage() {
  const result = await loadScreen<{datasets:DatasetRegistryItem[];issues:DatasetRegistryIssue[]}>("datasets",{datasets:[],issues:[]},"datasets");
  return <ScreenState result={result}>{(data) => <DatasetBoard datasets={data.datasets} issues={data.issues} />}</ScreenState>;
}
