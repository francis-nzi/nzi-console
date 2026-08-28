import type { ClientScreenReadModel } from "@nzi/isolated-backend";
import { loadScreen } from "../lib/loadScreen";
import { ScreenState } from "../lib/ScreenState";
import { ClientsBoard } from "./ClientsBoard";

export const dynamic = "force-dynamic";

export default async function ClientsPage() {
  const result = await loadScreen<{ clients: ClientScreenReadModel[] }>("clients", { clients: [] });
  return <ScreenState result={result}>{(data) => <ClientsBoard clients={data.clients} />}</ScreenState>;
}
