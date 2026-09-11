// Client contacts with roles (contact.manage). Versioned; deactivated, never deleted.
// Each role feeds a downstream picker — see `contactsWithRole`.
import type { CommandContext, CommandInputMap } from "@nzi/contracts";
import { CLIENT_CONTACT_COLUMNS, demoteOtherPrimary, insertClientContact, normaliseContactRoles, recordContactVersion, type ClientContactRow } from "./clientContactRecords";
export { contactsWithRole, listClientContacts, listJobReportSignees } from "./clientContactRecords";
import { VersionConflictError } from "./errors";
import type { PoolLike, Queryable } from "./postgres";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";

export type ClientContactResult = { contactId: string; clientId: string; version: number; status: "active" | "inactive" };

const result = (row: ClientContactRow, topic: string) => ({
  data: { contactId: row.contact_id, clientId: row.client_id, version: row.version, status: row.status },
  entityType: "client_contact", entityId: row.contact_id, topic,
});

export function createClientContact(pool: PoolLike, input: CommandInputMap["client.contact.create"], context: CommandContext): Promise<StoredOutcome<ClientContactResult>> {
  return runPostgresCommand(pool, "client.contact.create", input, context, async (db) => {
    const row = await insertClientContact(db, context, input.clientId, input);
    return result(row, "client.contact.created");
  });
}

async function lockContact(db: Queryable, context: CommandContext, contactId: string, expectedVersion: number): Promise<ClientContactRow> {
  const found = await db.query<ClientContactRow>(
    `SELECT ${CLIENT_CONTACT_COLUMNS} FROM nzi_console.client_contacts WHERE organisation_id=$1 AND contact_id=$2 FOR UPDATE`,
    [context.organisationId, contactId],
  );
  const row = found.rows[0];
  if (!row) throw new CommandValidationError([{ field: "contactId", code: "NOT_FOUND", message: "Contact was not found." }]);
  if (row.version !== expectedVersion) throw new VersionConflictError(expectedVersion, row.version);
  if (row.status !== "active") throw new CommandValidationError([{ field: "contactId", code: "INACTIVE", message: "This contact has been removed." }]);
  return row;
}

export function updateClientContact(pool: PoolLike, input: CommandInputMap["client.contact.update"], context: CommandContext): Promise<StoredOutcome<ClientContactResult>> {
  return runPostgresCommand(pool, "client.contact.update", input, context, async (db) => {
    const current = await lockContact(db, context, input.contactId, input.expectedVersion);
    if (input.isPrimary) await demoteOtherPrimary(db, context, current.client_id, current.contact_id);
    const updated = await db.query<ClientContactRow>(
      `UPDATE nzi_console.client_contacts SET full_name=$4,job_title=$5,email=$6,phone=$7,is_primary=$8,roles=$9::text[],version=version+1,updated_by=$10,updated_at=now()
       WHERE organisation_id=$1 AND contact_id=$2 AND version=$3 RETURNING ${CLIENT_CONTACT_COLUMNS}`,
      [context.organisationId, input.contactId, input.expectedVersion, input.fullName.trim(), input.jobTitle?.trim() || null, input.email?.trim() || null,
        input.phone?.trim() || null, input.isPrimary, normaliseContactRoles(input.roles), context.actorId],
    );
    const row = updated.rows[0];
    if (!row) throw new VersionConflictError();
    await recordContactVersion(db, context, row);
    return { ...result(row, "client.contact.updated"), before: { fullName: current.full_name, isPrimary: current.is_primary, roles: normaliseContactRoles(current.roles ?? []) } };
  });
}

export function deactivateClientContact(pool: PoolLike, input: CommandInputMap["client.contact.deactivate"], context: CommandContext): Promise<StoredOutcome<ClientContactResult>> {
  return runPostgresCommand(pool, "client.contact.deactivate", input, context, async (db) => {
    await lockContact(db, context, input.contactId, input.expectedVersion);
    const updated = await db.query<ClientContactRow>(
      `UPDATE nzi_console.client_contacts SET status='inactive',is_primary=false,deactivated_by=$4,deactivated_at=now(),version=version+1,updated_by=$4,updated_at=now()
       WHERE organisation_id=$1 AND contact_id=$2 AND version=$3 RETURNING ${CLIENT_CONTACT_COLUMNS}`,
      [context.organisationId, input.contactId, input.expectedVersion, context.actorId],
    );
    const row = updated.rows[0];
    if (!row) throw new VersionConflictError();
    await recordContactVersion(db, context, row);
    return result(row, "client.contact.deactivated");
  });
}
