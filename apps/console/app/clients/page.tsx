import { clientListSpec, DEFAULT_PAGE_SIZE, listQueryToSearchParams, parseListQuery } from "@nzi/contracts";
import type { ClientListPage } from "@nzi/isolated-backend";
import { loadScreen } from "../lib/loadScreen";
import { ScreenState } from "../lib/ScreenState";
import { ClientsBoard } from "./ClientsBoard";

export const dynamic = "force-dynamic";

/** Fixture mode has no client records: an honest empty page, which the board shows as "no clients yet". */
const NO_CLIENTS: ClientListPage = {
  rows: [], total: 0, unfilteredTotal: 0, page: 1, pageSize: DEFAULT_PAGE_SIZE, pageCount: 1,
  filterOptions: { industry: [], status: [], owner: [], portfolio: [], manager: [] },
  summary: { clients: 0, openJobs: 0, averageCompleteness: null, atRisk: 0, withoutOwner: 0, deliveryClients: 0, deliveryWithoutJobs: 0, activeWithoutEmissions: 0 },
};

export default async function ClientsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // A hand-edited or stale link renders on the defaults rather than failing; the API refuses anything else.
  const { query } = parseListQuery(await searchParams, clientListSpec);
  const search = listQueryToSearchParams(query, clientListSpec).toString();
  const result = await loadScreen<ClientListPage>("clientList", NO_CLIENTS, search ? `client-list?${search}` : "client-list");
  return <ScreenState result={result} chrome={{ activeId: "clients", label: "Clients", href: "/clients" }}>{(data) => <ClientsBoard page={data} query={query} />}</ScreenState>;
}
