import { randomUUID } from "node:crypto";
import type { CommandContext, CommandInputMap } from "@nzi/contracts";
import { VersionConflictError } from "./errors";
import type { SealingKeys } from "./piiSealing";
import { resolveSealingKeys } from "./piiSealingKeys";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";
import type { PoolLike, Queryable } from "./postgres";
import { withTenantWrite } from "./postgres";
import { ContentKeyShreddedError, createContentKey, openForDocument, sealForDocument, unwrapContentKey, vehicleRegistrationIndex, type SealedValue } from "./subjectCrypto";
import { normaliseRegistration } from "./vehicleLookup";

/**
 * Data entry D4 (R1, R8) — a company vehicle's registration is held **only sealed**, under the client's own key (0196; ruled 28 Oct).
 *
 * - **Sealed on write, in the writer's transaction.** Every write that can put a plate on a vehicle row or source — the drawer, the
 *   register, the bulk grid, the import — writes as it always did, then calls {@link sealVehicleIdentifiers} before it commits: the
 *   plate is sealed into `asset_identifier_sealed` under the client's `vehicle-registration` key, a client-scoped digest goes into
 *   `asset_identifier_bidx` (the vehicle's year-on-year identity), and the plaintext column — and a source's
 *   `detail_json.vehicleRegistration` — is cleared. So no plate is ever committed in the clear (the write-through rule, NZC-119).
 * - **Not a subject key.** A registration names no person in our data, so it is sealed under a key per client for this purpose,
 *   in the document-key envelope, kept in `client_data_keys`. A person's erasure never reaches it; the client's opt-out shreds it.
 * - **The opt-out.** A client that opts out has no registration stored at all: the key is shredded, every plate already held is
 *   cleared, and from then on `asset_identifier` on their vehicles is a **name or fleet number** the client or staff give, which is
 *   not sealed (it is not a registration). The DVLA lookup still reads a plate transiently, and never stores it.
 * - **Audited by reference.** The opt-out's audit records the client and the counts; no write here puts a plate in a payload.
 * - **Only company vehicles.** `asset_identifier` also holds a commuter's name and an import's invoice date: those are left alone.
 *
 * Reads open the plate through {@link vehicleRegistrationReader}, for the staff and the client's own views; a shredded key or
 * missing keys read as "held, unreadable" (null), never as an error.
 */

export const VEHICLE_KEY_PURPOSE = "vehicle-registration";
export const VEHICLE_CATEGORY_CODE = "1.company-vehicles";

type Sealed = SealedValue & { k: string };
type Target = { table: "job_scope_rows" | "job_emission_sources"; ids: readonly string[] };

const TABLES = {
  job_scope_rows: { id: "scope_row_id", vehicle: `x.category_code='${VEHICLE_CATEGORY_CODE}'` },
  job_emission_sources: { id: "source_id", vehicle: "x.source_type='vehicle'" },
} as const;

const keysOrThrow = (keys?: SealingKeys) => keys ?? resolveSealingKeys();

/** The client's live vehicle key, minted on first need when `mint` (a write); null when there is none and none is minted. */
async function clientVehicleKey(db: Queryable, organisationId: string, clientId: string, keys: SealingKeys, mint: boolean): Promise<{ keyId: string; key: Buffer } | null> {
  const read = async () => (await db.query<{ key_id: string; wrapped_key: never }>(
    `SELECT key_id,wrapped_key FROM nzi_console.client_data_keys WHERE organisation_id=$1 AND client_id=$2 AND purpose=$3 AND shredded_at IS NULL`,
    [organisationId, clientId, VEHICLE_KEY_PURPOSE])).rows[0];
  const live = await read();
  if (live) return { keyId: live.key_id, key: unwrapContentKey(live.wrapped_key, keys.masterKey) };
  if (!mint) return null;
  const { key, wrapped } = createContentKey(keys.masterKey);
  const keyId = randomUUID();
  const claimed = await db.query(
    `INSERT INTO nzi_console.client_data_keys (organisation_id,key_id,client_id,purpose,wrapped_key) VALUES ($1,$2,$3,$4,$5::jsonb)
     ON CONFLICT (organisation_id,client_id,purpose) WHERE shredded_at IS NULL DO NOTHING RETURNING key_id`,
    [organisationId, keyId, clientId, VEHICLE_KEY_PURPOSE, JSON.stringify(wrapped)]);
  if (claimed.rows[0]) return { keyId, key };
  // A concurrent writer minted it first: use theirs, or half the client's plates would be under a key the other half's is not.
  const settled = await read();
  if (!settled) throw new Error("No live vehicle key after a refused insert: nothing is stored.");
  return { keyId: settled.key_id, key: unwrapContentKey(settled.wrapped_key, keys.masterKey) };
}

/**
 * Seal the plates on the given vehicle rows or sources, in the caller's transaction, immediately after the write that put them
 * there. Rows that are not company vehicles, carry no plate, or belong to an opted-out client are left as they are.
 */
export async function sealVehicleIdentifiers(db: Queryable, organisationId: string, target: Target, keys?: SealingKeys): Promise<number> {
  if (target.ids.length === 0) return 0;
  const { id, vehicle } = TABLES[target.table];
  const isSource = target.table === "job_emission_sources";
  const { rows } = await db.query<{ id: string; plate: string | null; client_id: string; opt_out: boolean }>(
    `SELECT x.${id} AS id,coalesce(nullif(btrim(x.asset_identifier),''),${isSource ? "nullif(btrim(x.detail_json->>'vehicleRegistration'),'')" : "NULL"}) AS plate,
            j.client_id,c.vehicle_registrations_opt_out AS opt_out
       FROM nzi_console.${target.table} x
       JOIN nzi_console.jobs j ON (j.organisation_id,j.job_id)=(x.organisation_id,x.job_id)
       JOIN nzi_console.clients c ON (c.organisation_id,c.client_id)=(j.organisation_id,j.client_id)
      WHERE x.organisation_id=$1 AND x.${id}=ANY($2::text[]) AND ${vehicle}`,
    [organisationId, [...target.ids]]);
  let sealed = 0;
  for (const row of rows) {
    // A source's copy in its detail never stays, whatever else happens to the row.
    if (isSource) await db.query(`UPDATE nzi_console.job_emission_sources SET detail_json=detail_json-'vehicleRegistration' WHERE organisation_id=$1 AND source_id=$2 AND detail_json ? 'vehicleRegistration'`, [organisationId, row.id]);
    // Opted out: what is in asset_identifier is a name or fleet number, not a registration — it stays, unsealed.
    if (!row.plate || row.opt_out) continue;
    const resolved = keysOrThrow(keys);
    const key = (await clientVehicleKey(db, organisationId, row.client_id, resolved, true))!;
    const value: Sealed = { k: key.keyId, ...sealForDocument(row.plate.toUpperCase(), key.key) };
    await db.query(
      `UPDATE nzi_console.${target.table} SET asset_identifier=NULL,asset_identifier_sealed=$3::jsonb,asset_identifier_bidx=$4 WHERE organisation_id=$1 AND ${id}=$2`,
      [organisationId, row.id, JSON.stringify(value), vehicleRegistrationIndex(row.client_id, normaliseRegistration(row.plate), resolved.indexKey)]);
    sealed += 1;
  }
  return sealed;
}

/**
 * After an edit: a vehicle saved with no registration holds none — the plate sealed before goes with it — and one saved with a
 * plate is sealed afresh (same digest for the same plate, so its identity holds).
 */
export async function resealVehicleIdentifiers(db: Queryable, organisationId: string, target: Target, keys?: SealingKeys): Promise<number> {
  if (target.ids.length === 0) return 0;
  const { id, vehicle } = TABLES[target.table];
  await db.query(
    `UPDATE nzi_console.${target.table} x SET asset_identifier_sealed=NULL,asset_identifier_bidx=NULL
      WHERE x.organisation_id=$1 AND x.${id}=ANY($2::text[]) AND ${vehicle} AND nullif(btrim(x.asset_identifier),'') IS NULL
        AND (x.asset_identifier_sealed IS NOT NULL OR x.asset_identifier_bidx IS NOT NULL)`,
    [organisationId, [...target.ids]]);
  return sealVehicleIdentifiers(db, organisationId, target, keys);
}

/**
 * Carry a sealed plate from one vehicle row or source to another of the same client (the sync from a source to its row; a row
 * rolled forward from last year's): the ciphertext and digest move as they are — same client, same key — and no plaintext is
 * ever produced. An opted-out client's rows carry nothing.
 */
export async function copySealedVehicleIdentifier(db: Queryable, organisationId: string,
  from: { table: Target["table"]; id: string }, to: { table: Target["table"]; id: string },
  /** `mirror`: the target takes the source's state exactly, a plate cleared included (the sync from a source to its row). */
  options: { mirror?: boolean } = {}): Promise<void> {
  await db.query(
    `UPDATE nzi_console.${to.table} t SET asset_identifier_sealed=f.asset_identifier_sealed,asset_identifier_bidx=f.asset_identifier_bidx
       FROM nzi_console.${from.table} f
      WHERE t.organisation_id=$1 AND t.${TABLES[to.table].id}=$3 AND f.organisation_id=$1 AND f.${TABLES[from.table].id}=$2
        ${options.mirror ? "" : "AND f.asset_identifier_sealed IS NOT NULL"}`,
    [organisationId, from.id, to.id]);
}

/**
 * D4 (R6): a company vehicle's year-on-year identity — its registration's client-scoped digest; else, for an opted-out client, the
 * name or fleet number it is identified by; else its label. Never the plate itself. The same vehicle in two years of one client
 * has the same key; two vehicles never share one unless they share a plate (or, with no plate, a name).
 */
export function vehicleIdentityKey(row: { asset_identifier_bidx?: string | null; asset_identifier?: string | null; source_label?: string | null }): string {
  if (row.asset_identifier_bidx) return `reg:${row.asset_identifier_bidx}`;
  const name = (row.asset_identifier ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (name) return `name:${name}`;
  return `label:${(row.source_label ?? "").trim().toLowerCase().replace(/\s+/g, " ")}`;
}

/**
 * Opens sealed plates for display, one client key at a time (cached). Null — "held, unreadable" — when the client's key is
 * shredded, the value was sealed under a key since shredded, or the application has no sealing keys: a read never fails on it.
 */
export function vehicleRegistrationReader(db: Queryable, organisationId: string, keys?: SealingKeys): (clientId: string, sealed: unknown) => Promise<string | null> {
  const cache = new Map<string, Promise<Map<string, Buffer | null>>>();
  const keysFor = (clientId: string) => {
    let found = cache.get(clientId);
    if (!found) {
      found = (async () => {
        const { rows } = await db.query<{ key_id: string; wrapped_key: never }>(
          `SELECT key_id,wrapped_key FROM nzi_console.client_data_keys WHERE organisation_id=$1 AND client_id=$2 AND purpose=$3`,
          [organisationId, clientId, VEHICLE_KEY_PURPOSE]);
        let master: string;
        try { master = keysOrThrow(keys).masterKey; } catch { return new Map(); }
        return new Map(rows.map((row) => {
          try { return [row.key_id, unwrapContentKey(row.wrapped_key, master)] as const; } catch { return [row.key_id, null] as const; }
        }));
      })();
      cache.set(clientId, found);
    }
    return found;
  };
  return async (clientId, sealed) => {
    if (!sealed || typeof sealed !== "object") return null;
    const value = sealed as Sealed;
    const key = (await keysFor(clientId)).get(value.k);
    if (!key) return null;
    try { return openForDocument(value, key); } catch { return null; }
  };
}

export type VehicleRegistrationsOptOutResult = { clientId: string; optOut: boolean; version: number; cleared: number; keysShredded: number };

/**
 * The client's "don't hold our reg numbers" (R1), under `client.update`, versioned on the client and audited by counts only.
 * Opting out shreds the client's vehicle key and clears every plate held for them — ciphertext, digest and any plaintext a
 * vehicle row still had — so nothing of a registration survives. Opting back in stores nothing retrospectively; the next vehicle
 * written with a plate mints a new key.
 */
export function setVehicleRegistrationsOptOut(pool: PoolLike, input: CommandInputMap["client.vehicle_registrations.set"], context: CommandContext): Promise<StoredOutcome<VehicleRegistrationsOptOutResult>> {
  return runPostgresCommand(pool, "client.vehicle_registrations.set", input, context, async (db) => {
    const current = (await db.query<{ version: number; opt_out: boolean }>(
      `SELECT version,vehicle_registrations_opt_out AS opt_out FROM nzi_console.clients WHERE organisation_id=$1 AND client_id=$2 FOR UPDATE`,
      [context.organisationId, input.clientId])).rows[0];
    if (!current) throw new CommandValidationError([{ field: "clientId", code: "NOT_FOUND", message: "That client was not found." }]);
    if (current.version !== input.expectedVersion) throw new VersionConflictError(input.expectedVersion, current.version);
    if (current.opt_out === input.optOut) throw new CommandValidationError([{ field: "optOut", code: "UNCHANGED", message: input.optOut ? "This client already opts out of holding registrations." : "This client already allows registrations to be held." }]);
    const saved = (await db.query<{ version: number }>(
      `UPDATE nzi_console.clients SET vehicle_registrations_opt_out=$3,version=version+1,updated_at=now() WHERE organisation_id=$1 AND client_id=$2 RETURNING version`,
      [context.organisationId, input.clientId, input.optOut])).rows[0]!;
    let cleared = 0, keysShredded = 0;
    if (input.optOut) {
      keysShredded = (await db.query(
        `UPDATE nzi_console.client_data_keys SET wrapped_key=NULL,shredded_at=now(),shredded_by=$4 WHERE organisation_id=$1 AND client_id=$2 AND purpose=$3 AND shredded_at IS NULL RETURNING key_id`,
        [context.organisationId, input.clientId, VEHICLE_KEY_PURPOSE, context.actorId])).rows.length;
      for (const [table, { vehicle }] of Object.entries(TABLES)) {
        cleared += (await db.query(
          `UPDATE nzi_console.${table} x SET asset_identifier=NULL,asset_identifier_sealed=NULL,asset_identifier_bidx=NULL
             FROM nzi_console.jobs j
            WHERE x.organisation_id=$1 AND j.organisation_id=x.organisation_id AND j.job_id=x.job_id AND j.client_id=$2 AND ${vehicle}
              AND (x.asset_identifier_sealed IS NOT NULL OR x.asset_identifier_bidx IS NOT NULL OR nullif(btrim(x.asset_identifier),'') IS NOT NULL)
            RETURNING 1`,
          [context.organisationId, input.clientId])).rows.length;
      }
      await db.query(
        `UPDATE nzi_console.job_emission_sources x SET detail_json=x.detail_json-'vehicleRegistration' FROM nzi_console.jobs j
          WHERE x.organisation_id=$1 AND j.organisation_id=x.organisation_id AND j.job_id=x.job_id AND j.client_id=$2 AND x.detail_json ? 'vehicleRegistration'`,
        [context.organisationId, input.clientId]);
    }
    return { data: { clientId: input.clientId, optOut: input.optOut, version: saved.version, cleared, keysShredded }, entityType: "client", entityId: input.clientId, topic: "client.vehicle_registrations.set" };
  });
}

/**
 * The one-off sealing of plates written before 0196 (an operator run, `npm run seal:vehicle-registrations`): every vehicle row and
 * source of the organisation still holding a plaintext plate, sealed by the same {@link sealVehicleIdentifiers} the writes use. Its
 * queue is "plaintext present", so an interrupted run simply has more to do; a dry run is the whole run, rolled back.
 */
export async function sealExistingVehicleRegistrations(pool: PoolLike, organisationId: string, options: { commit: boolean; keys?: SealingKeys }): Promise<{ rows: number; sources: number; optedOutLeft: number; remaining: number }> {
  const run = async (db: Queryable) => {
    const counts = { rows: 0, sources: 0 };
    for (const [table, { id, vehicle }] of Object.entries(TABLES) as Array<[Target["table"], (typeof TABLES)[Target["table"]]]>) {
      const ids = (await db.query<{ id: string }>(
        `SELECT x.${id} AS id FROM nzi_console.${table} x WHERE x.organisation_id=$1 AND ${vehicle}
            AND (nullif(btrim(x.asset_identifier),'') IS NOT NULL${table === "job_emission_sources" ? " OR x.detail_json ? 'vehicleRegistration'" : ""})`,
        [organisationId])).rows.map((row) => row.id);
      const sealed = await sealVehicleIdentifiers(db, organisationId, { table, ids }, options.keys);
      if (table === "job_scope_rows") counts.rows = sealed; else counts.sources = sealed;
    }
    // What is left in the clear is an opted-out client's names — by design — and nothing else.
    const left = async (optedOut: boolean) => Number((await db.query<{ n: string }>(
      `SELECT ((SELECT count(*) FROM nzi_console.job_scope_rows x JOIN nzi_console.jobs j USING (organisation_id,job_id) JOIN nzi_console.clients c ON (c.organisation_id,c.client_id)=(j.organisation_id,j.client_id)
                 WHERE x.organisation_id=$1 AND ${TABLES.job_scope_rows.vehicle} AND nullif(btrim(x.asset_identifier),'') IS NOT NULL AND c.vehicle_registrations_opt_out=$2)
             + (SELECT count(*) FROM nzi_console.job_emission_sources x JOIN nzi_console.jobs j USING (organisation_id,job_id) JOIN nzi_console.clients c ON (c.organisation_id,c.client_id)=(j.organisation_id,j.client_id)
                 WHERE x.organisation_id=$1 AND ${TABLES.job_emission_sources.vehicle} AND (nullif(btrim(x.asset_identifier),'') IS NOT NULL OR x.detail_json ? 'vehicleRegistration') AND c.vehicle_registrations_opt_out=$2))::text AS n`,
      [organisationId, optedOut])).rows[0]!.n);
    return { ...counts, optedOutLeft: await left(true), remaining: await left(false) };
  };
  if (options.commit) return withTenantWrite(pool, organisationId, run);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('app.organisation_id',$1,true)`, [organisationId]);
    return await run(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

export { ContentKeyShreddedError };
