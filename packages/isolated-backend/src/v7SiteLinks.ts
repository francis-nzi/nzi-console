// One console site per V7 site (0235; SWEEP-v7-duplicate-sites.md, ruled 25 Nov 2026).
//
// The import names a V7 site's console site `v7-site-<id>`. After a merge, more than one V7 site maps to one console site, so
// nothing may assume the id: every load, re-sync and bring-in resolves a V7 site through `v7_site_links` (its latest link).
//
// The merge (`mergeV7DuplicateSites`) settles the duplicates the 29 Sep import minted with a " (v7 site N)" suffix:
//   - the survivor is the site with entries, then the site active in V7, then the unsuffixed site, then the lowest V7 id;
//   - it takes the name without the suffix; each duplicate is archived, records what it merged into, and keeps the name too;
//   - every V7 site that resolved to a duplicate is re-linked to the survivor;
//   - a group where more than one site has entries is held for a person, unless ruled (RULED_ROW_MOVES): there the duplicate's
//     rows move to the survivor, each move audited;
//   - a duplicate with any record other than scope rows (sources, inclusions, floor areas, headcount, FX, template lines, portal
//     records or grants) is held, as is a row move on a snapshotted job. Nothing is ever deleted.
// Ids, names and counts only in the audit: no figures, no addresses.
import { randomUUID } from "node:crypto";
import { withTenantWrite, type PoolLike, type Queryable } from "./postgres";
import { SOURCE_SYSTEM } from "./v7ClientImport";

export const V7_SITE_MERGE_ACTOR = "policy:v7-site-merge";
export const V7_SITE_MERGED = "client.site.merged";
export const V7_SITE_RENAMED = "client.site.renamed";
export const V7_SITE_ROW_MOVED = "job.scope_row.site_moved";
export const V7_SITE_LINKED = "client.site.v7_linked";

/** The planner's id for a V7 site, before it is resolved. */
export const v7SiteToken = (v7SiteId: string): string => `v7-site-${v7SiteId}`;
const tokenId = (token: string): string | null => /^v7-site-([0-9]+)$/.exec(token)?.[1] ?? null;

const SUFFIX = /\s*\(v7 site [0-9]+\)\s*$/i;
/** A site name as compared: the import's suffix gone, case and spacing normalised. */
export const siteNameKey = (name: string): string => name.replace(SUFFIX, "").trim().replace(/\s+/g, " ").toLowerCase();
/** The name without the import's suffix, as shown. */
export const unsuffixed = (name: string): string => name.replace(SUFFIX, "").trim();
/** A placeholder name for a nameless V7 site: never name-matched. */
export const isPlaceholderName = (name: string): boolean => /^unnamed site( [0-9]+)?$/i.test(unsuffixed(name));

/** Each V7 site's current console site, for the ids given (absent when never linked). */
export async function currentV7SiteLinks(db: Queryable, organisationId: string, v7SiteIds: readonly string[]): Promise<Map<string, string>> {
  if (v7SiteIds.length === 0) return new Map();
  const { rows } = await db.query<{ v7_site_id: string; site_id: string }>(
    `SELECT DISTINCT ON (v7_site_id) v7_site_id, site_id FROM nzi_console.v7_site_links
      WHERE organisation_id = $1 AND v7_site_id = ANY($2::text[]) ORDER BY v7_site_id, link_no DESC`,
    [organisationId, [...new Set(v7SiteIds)]]);
  return new Map(rows.map((row) => [row.v7_site_id, row.site_id]));
}

/**
 * Resolve the planner's site tokens (`v7-site-<id>`) to console sites through the links. A token with no link stays as it is
 * (the import's own id, as before 0235); anything else is returned unchanged.
 */
export async function resolveV7SiteTokens(db: Queryable, organisationId: string, tokens: ReadonlyArray<string | null>): Promise<(token: string | null) => string | null> {
  const ids = tokens.map((token) => (token ? tokenId(token) : null)).filter((id): id is string => id !== null);
  const links = await currentV7SiteLinks(db, organisationId, ids);
  return (token) => {
    if (token === null) return null;
    const id = tokenId(token);
    return id === null ? token : links.get(id) ?? token;
  };
}

export async function linkV7Site(db: Queryable, organisationId: string, v7SiteId: string, siteId: string,
  reason: "import" | "name-match" | "merge", actor: string, correlationId: string): Promise<void> {
  await db.query(
    `INSERT INTO nzi_console.v7_site_links (organisation_id, v7_site_id, site_id, reason, created_by, correlation_id) VALUES ($1,$2,$3,$4,$5,$6)`,
    [organisationId, v7SiteId, siteId, reason, actor, correlationId]);
}

// ── The merge ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** A group ruled to merge although both sides have entries: the duplicate's rows move to the survivor. */
export type RuledRowMove = { clientId: string; survivorSiteId: string; duplicateSiteIds: readonly string[]; ruling: string };
export const RULED_ROW_MOVES: readonly RuledRowMove[] = [
  { clientId: "v7-client-268", survivorSiteId: "v7-site-294", duplicateSiteIds: ["v7-site-295"], ruling: "Bryson Tractors, ruled 25 Nov 2026" },
];

type SiteFacts = {
  site_id: string; client_id: string; name: string; legacy_db_id: string | null; archived: boolean; is_registered_office: boolean;
  vacated_effective: string | null; rows: number; other_records: number;
};
export type SiteMergeGroup = {
  clientId: string; name: string;
  survivor: { siteId: string; name: string; rows: number };
  duplicates: Array<{ siteId: string; name: string; rows: number }>;
  rowsMoving: number;
};
export type HeldSiteGroup = { clientId: string; name: string; siteIds: string[]; why: string };
export type SiteMergePlan = { merge: SiteMergeGroup[]; held: HeldSiteGroup[] };

/** Every site of a V7-imported client, with its entries counted (scope rows) and every other record that cites it. */
async function siteFacts(db: Queryable, organisationId: string): Promise<SiteFacts[]> {
  const cites = (table: string) => `(SELECT count(*) FROM nzi_console.${table} x WHERE (x.organisation_id, x.site_id) = (s.organisation_id, s.site_id))`;
  return (await db.query<SiteFacts>(
    `SELECT s.site_id, s.client_id, s.name, s.legacy_db_id, s.archived, s.is_registered_office, s.vacated_effective::text,
            ${cites("job_scope_rows")}::int AS rows,
            (${cites("job_emission_sources")} + ${cites("job_site_inclusions")} + ${cites("client_site_floor_areas")} + ${cites("job_site_headcount")}
             + ${cites("job_site_fx_rates")} + ${cites("client_reporting_template_lines")} + ${cites("portal_data_entry_records")}
             + (SELECT count(*) FROM nzi_console.portal_data_entry_bucket_grants g WHERE g.organisation_id = s.organisation_id AND s.site_id = ANY(g.allowed_site_ids)))::int AS other_records
       FROM nzi_console.client_sites s
      WHERE s.organisation_id = $1 AND s.merged_into_site_id IS NULL
        AND s.client_id IN (SELECT client_id FROM nzi_console.client_sites WHERE organisation_id = $1 AND source_system = $2)
      ORDER BY s.client_id, s.site_id`, [organisationId, SOURCE_SYSTEM])).rows;
}

const v7Order = (a: SiteFacts, b: SiteFacts) => Number(a.legacy_db_id ?? Infinity) - Number(b.legacy_db_id ?? Infinity) || a.site_id.localeCompare(b.site_id);

/** The groups to merge, and those held for a person. A group is one client's sites sharing a name once the suffix is gone. */
export async function planV7DuplicateSiteMerges(db: Queryable, organisationId: string, ruled: readonly RuledRowMove[] = RULED_ROW_MOVES): Promise<SiteMergePlan> {
  const groups = new Map<string, SiteFacts[]>();
  for (const site of await siteFacts(db, organisationId)) {
    if (isPlaceholderName(site.name)) continue; // a nameless site is a placeholder, never "the same name"
    const key = `${site.client_id}\u0000${siteNameKey(site.name)}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(site);
  }
  const plan: SiteMergePlan = { merge: [], held: [] };
  for (const sites of groups.values()) {
    if (sites.length < 2 || !sites.some((site) => SUFFIX.test(site.name))) continue;
    sites.sort(v7Order);
    const clientId = sites[0]!.client_id;
    const name = unsuffixed(sites.find((site) => !SUFFIX.test(site.name))?.name ?? sites[0]!.name);
    const hold = (why: string) => plan.held.push({ clientId, name, siteIds: sites.map((site) => site.site_id), why });
    const withEntries = sites.filter((site) => site.rows > 0);
    const rule = ruled.find((entry) => entry.clientId === clientId && sites.some((site) => site.site_id === entry.survivorSiteId));
    let survivor: SiteFacts;
    if (withEntries.length > 1) {
      const covered = rule && sites.every((site) => site.site_id === rule.survivorSiteId || rule.duplicateSiteIds.includes(site.site_id));
      if (!covered) { hold("more than one of these sites has entries"); continue; }
      survivor = sites.find((site) => site.site_id === rule!.survivorSiteId)!;
    } else {
      // Ruled order: has entries → active in V7 → no suffix → lowest V7 id (sites are in V7-id order).
      survivor = withEntries[0] ?? [...sites].sort((a, b) =>
        Number(a.archived) - Number(b.archived) || Number(SUFFIX.test(a.name)) - Number(SUFFIX.test(b.name)) || v7Order(a, b))[0]!;
    }
    const duplicates = sites.filter((site) => site !== survivor);
    const blocked = duplicates.filter((site) => site.other_records > 0);
    if (blocked.length) { hold(`${blocked.map((site) => site.site_id).join(", ")} carries records other than scope rows`); continue; }
    plan.merge.push({
      clientId, name, survivor: { siteId: survivor.site_id, name: survivor.name, rows: survivor.rows },
      duplicates: duplicates.map((site) => ({ siteId: site.site_id, name: site.name, rows: site.rows })),
      rowsMoving: duplicates.reduce((sum, site) => sum + site.rows, 0),
    });
  }
  plan.merge.sort((a, b) => a.clientId.localeCompare(b.clientId) || a.name.localeCompare(b.name));
  plan.held.sort((a, b) => a.clientId.localeCompare(b.clientId));
  return plan;
}

export type SiteMergeContext = { organisationId: string; actorId: string; reason: string };
export type SiteMergeOutcome = { committed: boolean; correlationId: string; plan: SiteMergePlan; rowsMoved: number; linksWritten: number };

class DryRunRollback extends Error {}

async function audit(db: Queryable, context: SiteMergeContext, correlationId: string, clientId: string, action: string, entityType: string,
  entityId: string, before: Record<string, unknown> | null, after: Record<string, unknown>): Promise<void> {
  await db.query(
    `INSERT INTO nzi_console.audit_events (organisation_id,audit_event_id,actor_id,principal_type,action,entity_type,entity_id,correlation_id,reason,before_json,after_json,client_id)
     VALUES ($1,$2,$3,'system',$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11)`,
    [context.organisationId, randomUUID(), context.actorId, action, entityType, entityId, correlationId, context.reason.trim(),
      before === null ? null : JSON.stringify(before), JSON.stringify(after), clientId]);
}

/** Merge one planned group, inside the caller's transaction. */
async function mergeGroup(db: Queryable, context: SiteMergeContext, correlationId: string, group: SiteMergeGroup): Promise<{ rowsMoved: number; links: number }> {
  const org = context.organisationId;
  const survivorId = group.survivor.siteId;
  const ids = [survivorId, ...group.duplicates.map((site) => site.siteId)];
  const locked = new Map((await db.query<SiteFacts>(
    `SELECT site_id, client_id, name, legacy_db_id, archived, is_registered_office, vacated_effective::text, 0 AS rows, 0 AS other_records
       FROM nzi_console.client_sites WHERE organisation_id = $1 AND site_id = ANY($2::text[]) AND merged_into_site_id IS NULL FOR UPDATE`,
    [org, ids])).rows.map((site) => [site.site_id, site]));
  if (locked.size !== ids.length) throw new Error(`The sites of ${group.clientId} "${group.name}" changed since the plan; nothing of it was written.`);
  const survivor = locked.get(survivorId)!;

  let rowsMoved = 0;
  let links = 0;
  for (const { siteId } of group.duplicates) {
    const duplicate = locked.get(siteId)!;
    // The rows move first, while the duplicate is still in use; the 0235 guard then sees it merged.
    const rows = (await db.query<{ scope_row_id: string; job_id: string; origin: string }>(
      `SELECT scope_row_id, job_id, origin FROM nzi_console.job_scope_rows WHERE organisation_id = $1 AND site_id = $2 ORDER BY scope_row_id FOR UPDATE`,
      [org, siteId])).rows;
    if (rows.length) {
      const snapshotted = (await db.query<{ job_id: string }>(
        `SELECT DISTINCT job_id FROM nzi_console.reviewed_crp_snapshots WHERE organisation_id = $1 AND job_id = ANY($2::text[])`,
        [org, [...new Set(rows.map((row) => row.job_id))]])).rows;
      if (snapshotted.length) throw new Error(`${siteId}'s rows sit on snapshotted job(s) ${snapshotted.map((row) => row.job_id).join(", ")}; a row move is held.`);
    }
    await db.query(
      `UPDATE nzi_console.client_sites SET archived = true, is_registered_office = false, merged_into_site_id = $3, name = $4, version = version + 1
        WHERE organisation_id = $1 AND site_id = $2`, [org, siteId, survivorId, group.name]);
    for (const row of rows) {
      await db.query(`UPDATE nzi_console.job_scope_rows SET site_id = $3, version = version + 1 WHERE organisation_id = $1 AND scope_row_id = $2`,
        [org, row.scope_row_id, survivorId]);
      await audit(db, context, correlationId, group.clientId, V7_SITE_ROW_MOVED, "scope_row", row.scope_row_id,
        { siteId }, { siteId: survivorId, jobId: row.job_id, origin: row.origin, mergedSite: siteId });
      rowsMoved += 1;
    }
    // Every V7 site that resolved to the duplicate now resolves to the survivor.
    const pointing = (await db.query<{ v7_site_id: string }>(
      `SELECT v7_site_id FROM (SELECT DISTINCT ON (v7_site_id) v7_site_id, site_id FROM nzi_console.v7_site_links
          WHERE organisation_id = $1 ORDER BY v7_site_id, link_no DESC) current WHERE site_id = $2 ORDER BY v7_site_id::bigint`, [org, siteId])).rows;
    for (const { v7_site_id } of pointing) { await linkV7Site(db, org, v7_site_id, survivorId, "merge", context.actorId, correlationId); links += 1; }
    await audit(db, context, correlationId, group.clientId, V7_SITE_MERGED, "client_site", siteId,
      { name: duplicate.name, archived: duplicate.archived, isRegisteredOffice: duplicate.is_registered_office },
      { mergedInto: survivorId, name: group.name, archived: true, rowsMoved: rows.length, v7SitesRelinked: pointing.map((row) => row.v7_site_id) });
  }

  // The survivor loses the suffix. Its own V7 flags (archived, registered office) are V7's and stay as they are.
  if (survivor.name !== group.name) {
    await db.query(`UPDATE nzi_console.client_sites SET name = $3, version = version + 1 WHERE organisation_id = $1 AND site_id = $2`, [org, survivorId, group.name]);
    await audit(db, context, correlationId, group.clientId, V7_SITE_RENAMED, "client_site", survivorId, { name: survivor.name }, { name: group.name });
  }
  return { rowsMoved, links };
}

/** Plan and apply every merge, in one transaction: a dry run rolls it back. Held groups are never touched. */
export async function mergeV7DuplicateSites(pool: PoolLike, context: SiteMergeContext, options: { commit: boolean; ruled?: readonly RuledRowMove[] }): Promise<SiteMergeOutcome> {
  if (context.actorId !== V7_SITE_MERGE_ACTOR) throw new Error(`Only ${V7_SITE_MERGE_ACTOR} merges duplicate sites.`);
  if (!context.reason?.trim()) throw new Error("A merge records why it ran; the reason is blank.");
  const correlationId = `v7-site-merge-${randomUUID()}`;
  let outcome: SiteMergeOutcome | undefined;
  try {
    await withTenantWrite(pool, context.organisationId, async (db) => {
      const plan = await planV7DuplicateSiteMerges(db, context.organisationId, options.ruled);
      let rowsMoved = 0, linksWritten = 0;
      for (const group of plan.merge) {
        const done = await mergeGroup(db, context, correlationId, group);
        rowsMoved += done.rowsMoved; linksWritten += done.links;
      }
      outcome = { committed: options.commit, correlationId, plan, rowsMoved, linksWritten };
      if (!options.commit) throw new DryRunRollback();
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  }
  return outcome!;
}
