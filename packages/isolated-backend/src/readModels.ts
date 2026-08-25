import type { Queryable } from "./postgres";

export type IsolatedClientReadModel = {
  id: string;
  organisationId: string;
  name: string;
  status: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type IsolatedJobReadModel = {
  id: string;
  organisationId: string;
  clientId: string;
  clientName: string;
  sequence: number;
  number: string;
  family: "crp" | "consultancy" | "lca" | "pcf" | "training";
  title: string;
  status: "draft" | "open" | "on-hold" | "complete" | "cancelled";
  workflowStage: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

type ClientRow = { client_id: string; organisation_id: string; name: string; status: string; version: number; created_at: Date | string; updated_at: Date | string };
type JobRow = { job_id: string; organisation_id: string; client_id: string; client_name: string; sequence: number; job_number: string; job_family: IsolatedJobReadModel["family"]; title: string; status: IsolatedJobReadModel["status"]; workflow_stage: string; version: number; created_at: Date | string; updated_at: Date | string };
const iso = (value: Date | string) => value instanceof Date ? value.toISOString() : new Date(value).toISOString();

export async function listClients(db: Queryable): Promise<IsolatedClientReadModel[]> {
  const { rows } = await db.query<ClientRow>(`SELECT organisation_id, client_id, name, status, version, created_at, updated_at
    FROM nzi_console.clients ORDER BY lower(name), client_id`);
  return rows.map((row) => ({ id: row.client_id, organisationId: row.organisation_id, name: row.name, status: row.status, version: row.version, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }));
}

export async function listJobs(db: Queryable): Promise<IsolatedJobReadModel[]> {
  const { rows } = await db.query<JobRow>(`SELECT j.organisation_id, j.job_id, j.client_id, c.name AS client_name,
      j.sequence, j.job_number, j.job_family, j.title, j.status, j.workflow_stage, j.version, j.created_at, j.updated_at
    FROM nzi_console.jobs j
    JOIN nzi_console.clients c ON (c.organisation_id, c.client_id) = (j.organisation_id, j.client_id)
    ORDER BY j.sequence DESC`);
  return rows.map((row) => ({ id: row.job_id, organisationId: row.organisation_id, clientId: row.client_id, clientName: row.client_name, sequence: row.sequence, number: row.job_number, family: row.job_family, title: row.title, status: row.status, workflowStage: row.workflow_stage, version: row.version, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }));
}
