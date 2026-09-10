import { resolveSiteBoundary, type ClientSiteReadModel } from "@nzi/contracts";
import type { Queryable } from "./postgres";

export async function resolveClientSiteBoundary(db: Queryable, clientId: string, reportingYear: number): Promise<ClientSiteReadModel[]> {
  const result = await db.query<{ site_id: string; name: string; is_registered_office: boolean; in_service_from: Date | string; vacated_effective: Date | string | null; version: number }>(`SELECT site_id,name,is_registered_office,in_service_from,vacated_effective,version FROM nzi_console.client_sites WHERE client_id=$1 AND archived=false ORDER BY lower(name),site_id`, [clientId]);
  const dateOnly = (value: Date | string) => value instanceof Date ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}` : String(value).slice(0, 10);
  const sites = result.rows.map((row) => ({ id: row.site_id, name: row.name, isRegisteredOffice: row.is_registered_office, inServiceFrom: dateOnly(row.in_service_from), vacatedEffective: row.vacated_effective === null ? null : dateOnly(row.vacated_effective), status: row.vacated_effective === null ? "in-service" as const : "vacated" as const, version: row.version }));
  return resolveSiteBoundary(sites, reportingYear);
}