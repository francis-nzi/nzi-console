// Client contacts with roles (contact.manage). Versioned; deactivated, never deleted.
// Each role feeds a downstream picker — see `contactsWithRole`.
import { randomUUID } from "node:crypto";
import type { CommandContext, CommandInputMap, ContactConsentEvent } from "@nzi/contracts";
import { CLIENT_CONTACT_COLUMNS, demoteOtherPrimary, insertClientContact, normaliseContactRoles, recordContactVersion, sealContact, type ClientContactRow } from "./clientContactRecords";
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
    await sealContact(db, context, row);
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

/**
 * Production gate (a): recording whether a contact may be emailed.
 *
 * Two writes, one transaction. The column moves — that is what the worker reads at send
 * time — and an append-only event records who decided, when, and on what basis. Splitting
 * them would allow a state with no decision behind it, which is the hand-edited database
 * this control exists to replace.
 *
 * Enabling nothing by itself: staging still suppresses every send, and production sending
 * stays behind gate (b), the live worker standup. This slice only records state.
 */
export function recordContactConsent(pool: PoolLike, input: CommandInputMap["client.contact.consent.record"], context: CommandContext): Promise<StoredOutcome<ClientContactResult>> {
  return runPostgresCommand(pool, "client.contact.consent.record", input, context, async (db) => {
    const current = await lockContact(db, context, input.contactId, input.expectedVersion);

    // Recording what is already recorded would add a second decision saying nothing new, and
    // leave the history implying someone reconsidered when nobody did.
    if (current.email_consent === input.state) {
      throw new CommandValidationError([{
        field: "state", code: "UNCHANGED",
        message: input.state === "granted"
          ? "This contact is already recorded as having consented."
          : "This contact is already recorded as having declined.",
      }]);
    }

    const updated = await db.query<ClientContactRow>(
      `UPDATE nzi_console.client_contacts SET email_consent=$4,version=version+1,updated_by=$5,updated_at=now()
       WHERE organisation_id=$1 AND contact_id=$2 AND version=$3 RETURNING ${CLIENT_CONTACT_COLUMNS}`,
      [context.organisationId, input.contactId, input.expectedVersion, input.state, context.actorId],
    );
    const row = updated.rows[0];
    if (!row) throw new VersionConflictError();

    // The per-contact sequence, allocated under the row lock taken above. The unique index
    // on (contact_id, version) is the backstop: two racing recordings cannot both be latest.
    const next = await db.query<{ version: number }>(
      `SELECT coalesce(max(version), 0) + 1 AS version FROM nzi_console.client_contact_consent_events
       WHERE organisation_id=$1 AND contact_id=$2`,
      [context.organisationId, input.contactId],
    );
    await db.query(
      `INSERT INTO nzi_console.client_contact_consent_events
         (organisation_id, consent_event_id, contact_id, client_id, version, state, previous_state, basis, note, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [context.organisationId, `consent-${randomUUID()}`, input.contactId, row.client_id,
        next.rows[0]!.version, input.state, current.email_consent, input.basis, input.note?.trim() ?? "", context.actorId],
    );
    await recordContactVersion(db, context, row);

    return {
      ...result(row, "client.contact.consent.recorded"),
      before: { emailConsent: current.email_consent },
      after: { emailConsent: input.state, basis: input.basis },
    };
  });
}

/** The decisions recorded for one contact, newest first. Never rewritten, never removed. */
export async function listContactConsentEvents(db: Queryable, contactId: string): Promise<ContactConsentEvent[]> {
  const result = await db.query<{
    consent_event_id: string; contact_id: string; version: number; state: string; previous_state: string;
    basis: string; note: string; recorded_by: string; recorded_at: Date | string;
  }>(
    `SELECT consent_event_id, contact_id, version, state, previous_state, basis, note, recorded_by, recorded_at
     FROM nzi_console.client_contact_consent_events
     WHERE contact_id = $1 ORDER BY version DESC`,
    [contactId],
  );
  return result.rows.map((row) => ({
    id: row.consent_event_id, contactId: row.contact_id, version: row.version,
    state: row.state as ContactConsentEvent["state"],
    previousState: row.previous_state as ContactConsentEvent["previousState"],
    basis: row.basis as ContactConsentEvent["basis"],
    note: row.note, recordedBy: row.recorded_by,
    recordedAt: row.recorded_at instanceof Date ? row.recorded_at.toISOString() : String(row.recorded_at),
  }));
}

/**
 * The newest decision per contact for one client — what the contacts list needs to show a
 * basis beside a state instead of a bare "granted".
 */
export async function latestConsentByContact(db: Queryable, clientId: string): Promise<Map<string, ContactConsentEvent>> {
  const result = await db.query<{
    consent_event_id: string; contact_id: string; version: number; state: string; previous_state: string;
    basis: string; note: string; recorded_by: string; recorded_at: Date | string;
  }>(
    `SELECT DISTINCT ON (contact_id)
            consent_event_id, contact_id, version, state, previous_state, basis, note, recorded_by, recorded_at
     FROM nzi_console.client_contact_consent_events
     WHERE client_id = $1 ORDER BY contact_id, version DESC`,
    [clientId],
  );
  return new Map(result.rows.map((row) => [row.contact_id, {
    id: row.consent_event_id, contactId: row.contact_id, version: row.version,
    state: row.state as ContactConsentEvent["state"],
    previousState: row.previous_state as ContactConsentEvent["previousState"],
    basis: row.basis as ContactConsentEvent["basis"],
    note: row.note, recordedBy: row.recorded_by,
    recordedAt: row.recorded_at instanceof Date ? row.recorded_at.toISOString() : String(row.recorded_at),
  }]));
}
