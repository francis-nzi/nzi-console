import { clients } from "@nzi/mock-data";
import { ClientsBoard } from "./ClientsBoard";

export default function ClientsPage() {
  return <ClientsBoard clients={clients} />;
}
