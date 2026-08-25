import { clients } from "@nzi/mock-data";
import { loadScreen } from "../lib/loadScreen";
import { ScreenState } from "../lib/ScreenState";
import { ClientsBoard } from "./ClientsBoard";

export const dynamic = "force-dynamic";

export default async function ClientsPage() {
  const result = await loadScreen<{ clients: typeof clients }>("clients", { clients });
  return <ScreenState result={result}>{(data) => <ClientsBoard clients={data.clients} />}</ScreenState>;
}
