import { notFound } from "next/navigation";
import type { ClientScreenReadModel } from "@nzi/isolated-backend";
import { loadScreen } from "../../../lib/loadScreen";
import { ScreenState } from "../../../lib/ScreenState";
import { ClientEditTabs } from "./ClientEditTabs";

export const dynamic = "force-dynamic";

export default async function EditClientPage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  const result = await loadScreen<{ clients: ClientScreenReadModel[] }>("clients", { clients: [] });
  return <ScreenState result={result}>{(data) => {
    const client = data.clients.find((item) => item.id === clientId);
    if (!client) notFound();
    return <ClientEditTabs client={client} />;
  }}</ScreenState>;
}
