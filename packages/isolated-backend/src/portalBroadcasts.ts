import { randomUUID } from "node:crypto";
import {
  PORTAL_BROADCAST_LIVE_CAP, portalBroadcastListSpec,
  type CommandContext, type CommandInputMap, type ListPage, type PortalBroadcastListFilterKey, type PortalBroadcastListQuery, type PortalBroadcastListSortKey,
  type PortalBroadcastPhase, type PortalBroadcastStyle, type PortalLiveBroadcast,
} from "@nzi/contracts";
import { VersionConflictError } from "./errors";
import { defineListSql, readListPage } from "./listPage";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";
import type { PoolLike, Queryable } from "./postgres";

/**
 * Portal broadcasts (admin Phase F4; ruled `F4-RULINGS.md` R1–R7): 0152's `portal_broadcasts` — written, edited, taken
 * down and put back through the command runner under admin.settings, never deleted — and the portal's read of what is
 * live for a client.
 *
 * - **Live** = active and `starts_at <= now < ends_at` (a null end is open-ended), decided in SQL against the database's
 *   clock, so a broadcast goes live and ends on the instant its window says, wherever the reader is (R4).
 * - **The portal read** (R5) returns every live broadcast for the client — to everyone, and to that client — warnings
 *   first, then newest, five at most; content only, never the author or the target.
 * - **A target client** must be one of the organisation's clients; none is every portal client.
 */

const iso = (date: unknown) => date instanceof Date ? date.toISOString() : String(date);
const tidy = (value: string) => value.trim().replace(/[ \t]+/g, " ");
const blank = (value: string | null | undefined) => { const trimmed = value?.trim(); return trimmed ? trimmed : null; };

export type PortalBroadcastRow = {
  broadcastId: string; title: string; body: string; style: PortalBroadcastStyle; linkUrl: string | null; linkLabel: string | null;
  startsAt: string; endsAt: string | null; targetClientId: string | null; targetClientName: string | null;
  active: boolean; phase: PortalBroadcastPhase; version: number; updatedAt: string;
};
export type PortalBroadcastPage = ListPage<PortalBroadcastRow, PortalBroadcastListFilterKey, Record<string, never>>;

const broadcastSql = defineListSql<PortalBroadcastListSortKey, PortalBroadcastListFilterKey>({
  base: `SELECT b.organisation_id, b.broadcast_id, b.title, b.body, b.style, b.link_url, b.link_label, b.starts_at, b.ends_at, b.target_client_id,
      c.name AS target_client_name, b.active, b.version, b.updated_at,
      CASE WHEN NOT b.active THEN 'inactive' WHEN now() < b.starts_at THEN 'scheduled' WHEN b.ends_at IS NOT NULL AND now() >= b.ends_at THEN 'ended' ELSE 'live' END AS phase
    FROM nzi_console.portal_broadcasts b
    LEFT JOIN nzi_console.clients c ON (c.organisation_id, c.client_id) = (b.organisation_id, b.target_client_id)`,
  search: ["title"],
  filters: {
    phase: { kind: "equals", column: "phase", facet: { noneLabel: "—", values: ["live", "scheduled", "ended", "inactive"] } },
    style: { kind: "equals", column: "style", facet: { noneLabel: "—", values: ["info", "warning", "success", "promo"] } },
  },
  sort: { startsAt: { column: "starts_at" }, title: { column: "title", text: true }, style: { column: "style", text: true }, phase: { column: "phase", text: true } },
  tiebreak: "broadcast_id",
});

export async function listPortalBroadcastsPage(db: Queryable, query: PortalBroadcastListQuery): Promise<PortalBroadcastPage> {
  return readListPage(db, broadcastSql, portalBroadcastListSpec, query, {
    mapRow: (row) => ({
      broadcastId: String(row.broadcast_id), title: String(row.title), body: String(row.body), style: row.style as PortalBroadcastStyle,
      linkUrl: row.link_url === null ? null : String(row.link_url), linkLabel: row.link_label === null ? null : String(row.link_label),
      startsAt: iso(row.starts_at), endsAt: row.ends_at === null ? null : iso(row.ends_at),
      targetClientId: row.target_client_id === null ? null : String(row.target_client_id), targetClientName: row.target_client_name === null ? null : String(row.target_client_name),
      active: row.active === true, phase: row.phase as PortalBroadcastPhase, version: Number(row.version), updatedAt: iso(row.updated_at),
    }),
    mapSummary: () => ({}),
  });
}

/** The clients a broadcast may target, for the authoring screen's picker. */
export async function listBroadcastTargets(db: Queryable): Promise<Array<{ clientId: string; name: string }>> {
  const { rows } = await db.query<{ client_id: string; name: string }>(`SELECT client_id, name FROM nzi_console.clients ORDER BY lower(name), client_id`);
  return rows.map((row) => ({ clientId: row.client_id, name: row.name }));
}

/**
 * What is live for one portal client now (R5): active, inside its window (end exclusive), and to everyone or to this
 * client — warnings first, then the newest start, then the newest written; five at most.
 */
export async function listLivePortalBroadcasts(db: Queryable, clientId: string): Promise<PortalLiveBroadcast[]> {
  const { rows } = await db.query<{ broadcast_id: string; title: string; body: string; style: PortalBroadcastStyle; link_url: string | null; link_label: string | null; starts_at: unknown; ends_at: unknown }>(
    `SELECT broadcast_id, title, body, style, link_url, link_label, starts_at, ends_at
       FROM nzi_console.portal_broadcasts
      WHERE active AND starts_at <= now() AND (ends_at IS NULL OR now() < ends_at)
        AND (target_client_id IS NULL OR target_client_id = $1)
      ORDER BY (style = 'warning') DESC, starts_at DESC, created_at DESC, broadcast_id
      LIMIT ${PORTAL_BROADCAST_LIVE_CAP}`, [clientId]);
  return rows.map((row) => ({
    broadcastId: row.broadcast_id, title: row.title, body: row.body, style: row.style,
    link: row.link_url !== null && row.link_label !== null ? { url: row.link_url, label: row.link_label } : null,
    startsAt: iso(row.starts_at), endsAt: row.ends_at === null ? null : iso(row.ends_at),
  }));
}

// ── Commands (admin.settings) ────────────────────────────────────────────────────────────────────────────────────

type Stored = { title: string; body: string; style: PortalBroadcastStyle; link_url: string | null; link_label: string | null; starts_at: unknown; ends_at: unknown;
  target_client_id: string | null; active: boolean; version: number };
type Snapshot = { title: string; body: string; style: PortalBroadcastStyle; linkUrl: string | null; linkLabel: string | null; startsAt: string; endsAt: string | null;
  targetClientId: string | null; active: boolean };
const snapshot = (row: Stored): Snapshot => ({ title: row.title, body: row.body, style: row.style, linkUrl: row.link_url, linkLabel: row.link_label,
  startsAt: iso(row.starts_at), endsAt: row.ends_at === null ? null : iso(row.ends_at), targetClientId: row.target_client_id, active: row.active });
export type PortalBroadcastResult = Snapshot & { broadcastId: string; version: number };
const COLUMNS = "title, body, style, link_url, link_label, starts_at, ends_at, target_client_id, active, version";

const fieldsOf = (input: CommandInputMap["portal_broadcast.create"]) => ({
  title: tidy(input.title), body: input.body.trim(), style: input.style, linkUrl: blank(input.linkUrl), linkLabel: blank(input.linkLabel) === null ? null : tidy(input.linkLabel!),
  startsAt: new Date(input.startsAt).toISOString(), endsAt: input.endsAt === null ? null : new Date(input.endsAt).toISOString(), targetClientId: blank(input.targetClientId),
});

async function assertTarget(db: Queryable, context: CommandContext, targetClientId: string | null) {
  if (targetClientId === null) return;
  const { rows: [row] } = await db.query<{ ok: boolean }>(`SELECT EXISTS (SELECT 1 FROM nzi_console.clients WHERE organisation_id = $1 AND client_id = $2) AS ok`, [context.organisationId, targetClientId]);
  if (!row?.ok) throw new CommandValidationError([{ field: "targetClientId", code: "NOT_FOUND", message: "That client is not one of this organisation's." }]);
}

async function lock(db: Queryable, context: CommandContext, broadcastId: string, expectedVersion: number): Promise<Stored> {
  const { rows: [row] } = await db.query<Stored>(
    `SELECT ${COLUMNS} FROM nzi_console.portal_broadcasts WHERE organisation_id = $1 AND broadcast_id = $2 FOR UPDATE`, [context.organisationId, broadcastId]);
  if (!row) throw new CommandValidationError([{ field: "broadcastId", code: "NOT_FOUND", message: "That broadcast is not here." }]);
  if (row.version !== expectedVersion) throw new VersionConflictError(expectedVersion, row.version);
  return row;
}

export function createPortalBroadcast(pool: PoolLike, input: CommandInputMap["portal_broadcast.create"], context: CommandContext): Promise<StoredOutcome<PortalBroadcastResult>> {
  return runPostgresCommand(pool, "portal_broadcast.create", input, context, async (db) => {
    const fields = fieldsOf(input);
    await assertTarget(db, context, fields.targetClientId);
    const broadcastId = `portal-broadcast:${randomUUID()}`;
    const { rows: [saved] } = await db.query<Stored>(
      `INSERT INTO nzi_console.portal_broadcasts (organisation_id, broadcast_id, title, body, style, link_url, link_label, starts_at, ends_at, target_client_id, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11) RETURNING ${COLUMNS}`,
      [context.organisationId, broadcastId, fields.title, fields.body, fields.style, fields.linkUrl, fields.linkLabel, fields.startsAt, fields.endsAt, fields.targetClientId, context.actorId]);
    return { data: { broadcastId, version: saved!.version, ...snapshot(saved!) }, entityType: "portal_broadcast", entityId: broadcastId, topic: "portal_broadcast.created" };
  });
}

export function updatePortalBroadcast(pool: PoolLike, input: CommandInputMap["portal_broadcast.update"], context: CommandContext): Promise<StoredOutcome<PortalBroadcastResult>> {
  return runPostgresCommand(pool, "portal_broadcast.update", input, context, async (db) => {
    const current = await lock(db, context, input.broadcastId, input.expectedVersion);
    const fields = fieldsOf(input);
    const before = snapshot(current);
    if ((["title", "body", "style", "linkUrl", "linkLabel", "startsAt", "endsAt", "targetClientId"] as const).every((field) => fields[field] === before[field])) {
      throw new CommandValidationError([{ field: "title", code: "UNCHANGED", message: "That is what the broadcast already says." }]);
    }
    if (fields.targetClientId !== before.targetClientId) await assertTarget(db, context, fields.targetClientId);
    const { rows: [saved] } = await db.query<Stored>(
      `UPDATE nzi_console.portal_broadcasts SET title = $3, body = $4, style = $5, link_url = $6, link_label = $7, starts_at = $8, ends_at = $9, target_client_id = $10,
              version = version + 1, updated_at = now(), updated_by = $11
        WHERE organisation_id = $1 AND broadcast_id = $2 RETURNING ${COLUMNS}`,
      [context.organisationId, input.broadcastId, fields.title, fields.body, fields.style, fields.linkUrl, fields.linkLabel, fields.startsAt, fields.endsAt, fields.targetClientId, context.actorId]);
    return { data: { broadcastId: input.broadcastId, version: saved!.version, ...snapshot(saved!) }, entityType: "portal_broadcast", entityId: input.broadcastId,
      topic: "portal_broadcast.updated", before };
  });
}

function setActive(key: "portal_broadcast.deactivate" | "portal_broadcast.reinstate", active: boolean) {
  return (pool: PoolLike, input: CommandInputMap[typeof key], context: CommandContext): Promise<StoredOutcome<PortalBroadcastResult>> =>
    runPostgresCommand(pool, key, input, context, async (db) => {
      const current = await lock(db, context, input.broadcastId, input.expectedVersion);
      if (current.active === active) throw new CommandValidationError([{ field: "broadcastId", code: active ? "ALREADY_ACTIVE" : "ALREADY_INACTIVE", message: active ? "That broadcast is already up." : "That broadcast is already down." }]);
      const { rows: [saved] } = await db.query<Stored>(
        `UPDATE nzi_console.portal_broadcasts SET active = $3, version = version + 1, updated_at = now(), updated_by = $4
          WHERE organisation_id = $1 AND broadcast_id = $2 RETURNING ${COLUMNS}`, [context.organisationId, input.broadcastId, active, context.actorId]);
      return { data: { broadcastId: input.broadcastId, version: saved!.version, ...snapshot(saved!) }, entityType: "portal_broadcast", entityId: input.broadcastId,
        topic: active ? "portal_broadcast.reinstated" : "portal_broadcast.deactivated", before: snapshot(current) };
    });
}
/** Takes a broadcast off the portal at once, whatever its window says; it is kept, to put back. */
export const deactivatePortalBroadcast = setActive("portal_broadcast.deactivate", false);
export const reinstatePortalBroadcast = setActive("portal_broadcast.reinstate", true);
