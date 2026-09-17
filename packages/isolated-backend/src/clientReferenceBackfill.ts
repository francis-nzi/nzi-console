import { withTenantWrite, type PoolLike, type Queryable } from "./postgres";

/**
 * Carry the free-text client identity fields onto the curated references (NZC-090).
 *
 * Best-effort by name, and **loud about what it could not match**. A client's recorded industry,
 * referral, owner and manager are things the firm typed about a real relationship; a value this
 * cannot place is reported so a person can decide, never blanked and never guessed at. The text
 * stays in the column it is in, so a client record reads the same the day after this runs.
 *
 * Idempotent and reconcile-by-reading (§14): a second run matches the same rows, finds the ids
 * already set, and writes nothing.
 */

export type BackfillField = "sector" | "referral" | "owner" | "clientManager";

export type Unmatched = {
  clientId: string;
  clientName: string;
  field: BackfillField;
  /** What the client actually holds, so the report is actionable without another query. */
  value: string;
  reason: "no match" | "ambiguous" | "owner already set to someone else";
};

export type BackfillOutcome = {
  matched: Record<BackfillField, number>;
  alreadySet: Record<BackfillField, number>;
  blank: Record<BackfillField, number>;
  unmatched: Unmatched[];
};

const normalise = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");

const zero = (): Record<BackfillField, number> => ({ sector: 0, referral: 0, owner: 0, clientManager: 0 });

type ClientRow = {
  client_id: string; name: string;
  sector: string | null; sector_value_id: string | null;
  referral: string | null; referral_value_id: string | null;
  owner_name: string | null; owner_user_id: string | null;
  client_manager: string | null; client_manager_user_id: string | null;
};

/** Labels → the one id that carries them; ambiguous labels are held back deliberately. */
function index(rows: Array<{ id: string; label: string }>): Map<string, string | "ambiguous"> {
  const byLabel = new Map<string, string | "ambiguous">();
  for (const row of rows) {
    const key = normalise(row.label);
    byLabel.set(key, byLabel.has(key) ? "ambiguous" : row.id);
  }
  return byLabel;
}

export async function backfillClientReferences(
  pool: PoolLike, input: { organisationId: string; actorId: string; dryRun?: boolean },
): Promise<BackfillOutcome> {
  return withTenantWrite(pool, input.organisationId, async (db: Queryable) => {
    const values = await db.query<{ value_id: string; category_key: string; label: string }>(
      `SELECT value_id, category_key, label FROM nzi_console.reference_values WHERE active`);
    const members = await db.query<{ user_id: string; display_name: string | null }>(
      `SELECT user_id, display_name FROM nzi_console.memberships WHERE status = 'active'`);

    const industries = index(values.rows.filter((r) => r.category_key === "industries").map((r) => ({ id: r.value_id, label: r.label })));
    const referrals = index(values.rows.filter((r) => r.category_key === "referrals").map((r) => ({ id: r.value_id, label: r.label })));
    // People are matched on their name; a membership with no name yet cannot be matched by one.
    const people = index(members.rows.filter((r) => r.display_name?.trim()).map((r) => ({ id: r.user_id, label: r.display_name! })));

    const clients = await db.query<ClientRow>(
      `SELECT client_id, name, sector, sector_value_id, referral, referral_value_id,
              owner_name, owner_user_id, client_manager, client_manager_user_id
         FROM nzi_console.clients`);

    const outcome: BackfillOutcome = { matched: zero(), alreadySet: zero(), blank: zero(), unmatched: [] };

    for (const client of clients.rows) {
      const resolve = (
        field: BackfillField, text: string | null, current: string | null, lookup: Map<string, string | "ambiguous">,
      ): string | null => {
        if (current) { outcome.alreadySet[field] += 1; return null; }
        const value = text?.trim();
        if (!value) { outcome.blank[field] += 1; return null; }
        const found = lookup.get(normalise(value));
        if (found === undefined) {
          outcome.unmatched.push({ clientId: client.client_id, clientName: client.name, field, value, reason: "no match" });
          return null;
        }
        if (found === "ambiguous") {
          outcome.unmatched.push({ clientId: client.client_id, clientName: client.name, field, value, reason: "ambiguous" });
          return null;
        }
        outcome.matched[field] += 1;
        return found;
      };

      const sectorId = resolve("sector", client.sector, client.sector_value_id, industries);
      const referralId = resolve("referral", client.referral, client.referral_value_id, referrals);
      const managerId = resolve("clientManager", client.client_manager, client.client_manager_user_id, people);

      // The owner is the exception, and deliberately so: `owner_user_id` is what `own_clients`
      // resolves against, so writing it decides who can see this client. Populating a null one
      // from an unambiguous name is filling in a blank; changing one that is already set would be
      // re-pointing access from a script, which is a person's decision and is reported instead.
      let ownerId: string | null = null;
      const ownerText = client.owner_name?.trim();
      if (client.owner_user_id) {
        outcome.alreadySet.owner += 1;
        const claimed = ownerText ? people.get(normalise(ownerText)) : undefined;
        if (typeof claimed === "string" && claimed !== client.owner_user_id) {
          outcome.unmatched.push({
            clientId: client.client_id, clientName: client.name, field: "owner",
            value: ownerText!, reason: "owner already set to someone else",
          });
        }
      } else {
        ownerId = resolve("owner", client.owner_name, null, people);
      }

      if (input.dryRun) continue;
      if (!sectorId && !referralId && !managerId && !ownerId) continue;

      await db.query(
        `UPDATE nzi_console.clients
            SET sector_value_id = coalesce($3, sector_value_id),
                referral_value_id = coalesce($4, referral_value_id),
                client_manager_user_id = coalesce($5, client_manager_user_id),
                owner_user_id = coalesce(owner_user_id, $6)
          WHERE organisation_id = $1 AND client_id = $2`,
        [input.organisationId, client.client_id, sectorId, referralId, managerId, ownerId]);
    }

    if (!input.dryRun) {
      await db.query(
        `INSERT INTO nzi_console.audit_events
           (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, after_json)
         VALUES ($1,$2,$3,'staff','client.references.backfilled','organisation',$1,$2,$4::jsonb)`,
        [input.organisationId, `audit-backfill-${Date.now()}`, input.actorId,
          JSON.stringify({ matched: outcome.matched, alreadySet: outcome.alreadySet, unmatched: outcome.unmatched.length })]);
    }

    return outcome;
  });
}
