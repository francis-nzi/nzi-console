import type { CommandContext, CommandInputMap } from "@nzi/contracts";
import type { PoolLike } from "./postgres";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";

/**
 * Portal Management → "Reset all to default" (RULING-portal-management-mapping Q3): one atomic command with **one audit event**, not
 * one withdrawal per decision. Withdrawing is what it always was — the decision row goes inactive and is kept (who withdrew it, when),
 * the key returns to the default — only the grain changes: the whole tab, together, recorded once, naming every key it returned.
 *
 *  - `client.portal.profile.reset` (portal.admin) — the portal settings this screen offers. **Datasets and Setup are not touched**: the
 *    screen no longer offers them, so a reset of what it shows must not reach what it doesn't (their stored decisions stay inert).
 *  - `client.portal.visibility.reset` (category.visibility, as the scope and category commands are) — every scope and category decision.
 *
 * A reset with nothing to reset is refused (`NOTHING_TO_RESET`) rather than recorded as a no-op decision.
 */
const HIDDEN_PROFILE_KEYS = ["setup", "datasets"];
const refuse = (field: string, code: string, message: string) => new CommandValidationError([{ field, code, message }]);

type ResetData = { clientId: string; reset: string[]; count: number; note: string | null };

export function resetClientPortalProfile(pool: PoolLike, input: CommandInputMap["client.portal.profile.reset"], context: CommandContext): Promise<StoredOutcome<ResetData>> {
  return runPostgresCommand<"client.portal.profile.reset", ResetData>(pool, "client.portal.profile.reset", input, context, async (db) => {
    const client = await db.query(`SELECT 1 FROM nzi_console.clients WHERE organisation_id = $1 AND client_id = $2`, [context.organisationId, input.clientId]);
    if (!client.rows[0]) throw refuse("clientId", "NOT_FOUND", "Client was not found.");
    const live = (await db.query<{ profile_key: string }>(
      `SELECT profile_key FROM nzi_console.client_portal_profile_decisions WHERE organisation_id = $1 AND client_id = $2 AND active AND profile_key <> ALL($3::text[]) ORDER BY profile_key FOR UPDATE`,
      [context.organisationId, input.clientId, HIDDEN_PROFILE_KEYS])).rows.map((row) => row.profile_key);
    if (live.length === 0) throw refuse("clientId", "NOTHING_TO_RESET", "Nothing to reset: every setting is already at its default.");
    await db.query(
      `UPDATE nzi_console.client_portal_profile_decisions SET active = false, decided_by = $4, decided_at = now() WHERE organisation_id = $1 AND client_id = $2 AND profile_key = ANY($3::text[])`,
      [context.organisationId, input.clientId, live, context.actorId]);
    const note = input.note?.trim() ? input.note.trim().slice(0, 500) : null;
    return { data: { clientId: input.clientId, reset: live, count: live.length, note }, entityType: "client_portal_profile_decisions", entityId: input.clientId, topic: "client.portal.profile.reset" };
  });
}

export function resetClientPortalVisibility(pool: PoolLike, input: CommandInputMap["client.portal.visibility.reset"], context: CommandContext): Promise<StoredOutcome<ResetData>> {
  return runPostgresCommand<"client.portal.visibility.reset", ResetData>(pool, "client.portal.visibility.reset", input, context, async (db) => {
    const client = await db.query(`SELECT 1 FROM nzi_console.clients WHERE organisation_id = $1 AND client_id = $2`, [context.organisationId, input.clientId]);
    if (!client.rows[0]) throw refuse("clientId", "NOT_FOUND", "Client was not found.");
    const scopes = (await db.query<{ scope: string }>(
      `SELECT scope FROM nzi_console.client_portal_scope_visibility WHERE organisation_id = $1 AND client_id = $2 AND active ORDER BY scope FOR UPDATE`, [context.organisationId, input.clientId])).rows.map((row) => `scope:${row.scope}`);
    const categories = (await db.query<{ category_code: string }>(
      `SELECT category_code FROM nzi_console.client_category_visibility WHERE organisation_id = $1 AND client_id = $2 AND active ORDER BY category_code FOR UPDATE`, [context.organisationId, input.clientId])).rows.map((row) => `category:${row.category_code}`);
    if (scopes.length + categories.length === 0) throw refuse("clientId", "NOTHING_TO_RESET", "Nothing to reset: every scope and category is already at its default.");
    await db.query(`UPDATE nzi_console.client_portal_scope_visibility SET active = false, decided_by = $3, decided_at = now() WHERE organisation_id = $1 AND client_id = $2 AND active`, [context.organisationId, input.clientId, context.actorId]);
    await db.query(`UPDATE nzi_console.client_category_visibility SET active = false, decided_by = $3, decided_at = now() WHERE organisation_id = $1 AND client_id = $2 AND active`, [context.organisationId, input.clientId, context.actorId]);
    const reset = [...scopes, ...categories];
    const note = input.note?.trim() ? input.note.trim().slice(0, 500) : null;
    return { data: { clientId: input.clientId, reset, count: reset.length, note }, entityType: "client_portal_visibility", entityId: input.clientId, topic: "client.portal.visibility.reset" };
  });
}
