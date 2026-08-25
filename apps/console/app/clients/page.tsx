import { clients } from "@nzi/mock-data";
import { loadFixtureScreen } from "@nzi/api-client";
import { ScreenState } from "../lib/ScreenState";
import { ClientsBoard } from "./ClientsBoard";

export default function ClientsPage() {
  const result = loadFixtureScreen<{ clients: typeof clients }>("clients", { clients });
  return <ScreenState result={result}>{(data) => <ClientsBoard clients={data.clients} />}</ScreenState>;
}
