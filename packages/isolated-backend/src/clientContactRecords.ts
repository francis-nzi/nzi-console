// Client contacts — the storage rules shared by client.create (its primary contact)
// and the contact commands. Every write bumps the version and appends a history row;
// nothing is ever deleted.
import { randomUUID } from "node:crypto";
import { clientContactRoles, type ClientContactReadModel, type ClientContactRole, type ClientContactWriteFields, type CommandContext } from "@nzi/contracts";
import type { Queryable } from "./postgres";

export type ClientContactRow = {
  contact_id: string; client_id: string; full_name: string; job_title: string | null; email: string | null; phone: string | null;
  is_primary: boolean; roles: string[]; status: "active" | "inactive"; version: number; updated_at: Date | string; updated_by: string;
};

const clean = (value: string | null | undefined) => value?.trim() || null;
/** Roles in their canonical order, without repeats. */
export const normaliseContactRoles = (roles: readonly string[]): ClientContactRole[] => clientContactRoles.filter((role) => roles.includes(role));

export function mapClientContact(row: ClientContactRow): ClientContactReadModel {
  return {
    id: row.contact_id, clientId: row.client_id, fullName: row.full_name, jobTitle: row.job_title, email: row.email, phone: row.phone,
    isPrimary: row.is_primary, roles: normaliseContactRoles(row.roles ?? []), status: row.status, version: row.version,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at), updatedBy: row.updated_by,
  };
}

export const CLIENT_CONTACT_COLUMNS = "contact_id,client_id,full_name,job_title,email,phone,is_primary,roles,status,version,updated_at,updated_by";

export async function recordContactVersion(db: Queryable, context: CommandContext, row: ClientContactRow): Promise<void> {
  await db.query(
    `INSERT INTO nzi_console.client_contact_versions (organisation_id,contact_id,version,snapshot_json,changed_by,correlation_id) VALUES ($1,$2,$3,$4::jsonb,$5,$6)`,
    [context.organisationId, row.contact_id, row.version, JSON.stringify({ fullName: row.full_name, jobTitle: row.job_title, email: row.email, phone: row.phone, isPrimary: row.is_primary, roles: normaliseContactRoles(row.roles ?? []), status: row.status }), context.actorId, context.correlationId],
  );
}

/** One primary contact per client: marking another primary demotes the current one (itself a versioned change). */
export async function demoteOtherPrimary(db: Queryable, context: CommandContext, clientId: string, keepContactId: string | null): Promise<void> {
  const demoted = await db.query<ClientContactRow>(
    `UPDATE nzi_console.client_contacts SET is_primary=false,version=version+1,updated_by=$4,updated_at=now()
     WHERE organisation_id=$1 AND client_id=$2 AND is_primary AND status='active' AND contact_id IS DISTINCT FROM $3
     RETURNING ${CLIENT_CONTACT_COLUMNS}`,
    [context.organisationId, clientId, keepContactId, context.actorId],
  );
  for (const row of demoted.rows) await recordContactVersion(db, context, row);
}

export async function insertClientContact(db: Queryable, context: CommandContext, clientId: string, fields: ClientContactWriteFields): Promise<ClientContactRow> {
  if (fields.isPrimary) await demoteOtherPrimary(db, context, clientId, null);
  const inserted = await db.query<ClientContactRow>(
    `INSERT INTO nzi_console.client_contacts (organisation_id,contact_id,client_id,full_name,job_title,email,phone,is_primary,roles,created_by,updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::text[],$10,$10) RETURNING ${CLIENT_CONTACT_COLUMNS}`,
    [context.organisationId, randomUUID(), clientId, fields.fullName.trim(), clean(fields.jobTitle), clean(fields.email), clean(fields.phone), fields.isPrimary, normaliseContactRoles(fields.roles), context.actorId],
  );
  const row = inserted.rows[0]!;
  await recordContactVersion(db, context, row);
  return row;
}

/** A client's contacts — active first (primary on top), then removed ones for the record. */
export async function listClientContacts(db: Queryable, clientId: string, options: { includeInactive?: boolean } = {}): Promise<ClientContactReadModel[]> {
  const { rows } = await db.query<ClientContactRow>(
    `SELECT ${CLIENT_CONTACT_COLUMNS} FROM nzi_console.client_contacts WHERE client_id=$1 ${options.includeInactive ? "" : "AND status='active'"}
     ORDER BY (status='active') DESC, is_primary DESC, lower(full_name), contact_id`,
    [clientId],
  );
  return rows.map(mapClientContact);
}

/**
 * The downstream pickers read contacts by role: report signees (report validation),
 * portal candidates (portal invitations), invoice recipients (commercial documents),
 * training attendees (training places). Active contacts only.
 */
export async function contactsWithRole(db: Queryable, clientId: string, role: ClientContactRole): Promise<ClientContactReadModel[]> {
  const { rows } = await db.query<ClientContactRow>(
    `SELECT ${CLIENT_CONTACT_COLUMNS} FROM nzi_console.client_contacts WHERE client_id=$1 AND status='active' AND $2=ANY(roles) ORDER BY is_primary DESC, lower(full_name), contact_id`,
    [clientId, role],
  );
  return rows.map(mapClientContact);
}

/** The job's client's report signees — the signee picker on report validation. */
export async function listJobReportSignees(db: Queryable, jobId: string): Promise<ClientContactReadModel[]> {
  const { rows } = await db.query<ClientContactRow>(
    `SELECT ${CLIENT_CONTACT_COLUMNS.split(",").map((column) => `k.${column}`).join(",")} FROM nzi_console.client_contacts k
     JOIN nzi_console.jobs j ON (j.organisation_id,j.client_id)=(k.organisation_id,k.client_id)
     WHERE j.job_id=$1 AND k.status='active' AND 'report_signee'=ANY(k.roles) ORDER BY k.is_primary DESC, lower(k.full_name), k.contact_id`,
    [jobId],
  );
  return rows.map(mapClientContact);
}
