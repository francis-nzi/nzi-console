#!/usr/bin/env node
/**
 * How well would a person link across the four person-shaped tables?
 *
 * The erasure workstream needs a per-subject key, and a subject has to be something the data can
 * identify. Today there is no subject identity: `trainees`, `client_contacts`, `portal_users` and
 * `memberships` each key a person their own way, with no foreign key between them. Whether an
 * identity can be *derived* — rather than declared and backfilled by hand — depends on how many
 * people actually resolve by their email address, and how many do not.
 *
 * This counts that. It decides nothing.
 *
 * ## What it will not do
 *
 * **It never writes.** The connection is opened read-only and every statement runs inside a
 * `READ ONLY` transaction, so a stray `UPDATE` in a later edit fails rather than runs.
 *
 * **It never prints personal data.** Every output is a count or a bucket. No address, no name, no
 * fragment of either — not even a "most common shared email", because the result of this is going
 * to be pasted into a decision thread and counts can be, while examples cannot.
 *
 *   NZI_DATABASE_BOUNDARY=isolated-non-production node scripts/dsar-linkage-probe.mjs
 *
 * Run it from the service's own shell, where the connection string already lives in the
 * environment. It is never passed as an argument.
 */

import pg from "pg";

/* ── The same boundary refusal every script in this repo carries ─────────────────────── */

if (process.env.NEXT_PUBLIC_APP_ENV === "production" || process.env.NZI_DATABASE_BOUNDARY !== "isolated-non-production") {
  throw new Error("Only the confirmed isolated non-production database is allowed.");
}
const connectionString = process.env.NZI_ISOLATED_DATABASE_URL;
if (!connectionString) throw new Error("NZI_ISOLATED_DATABASE_URL is required.");

/**
 * The four tables, and how each spells a person's email and name.
 *
 * `memberships` carries staff identity and `staff_credentials` carries the login address for the
 * same people; the membership row is the one with a display name, so it stands for staff here.
 */
const SOURCES = [
  { label: "trainees", table: "trainees", email: "personal_email", name: "full_name" },
  { label: "client_contacts", table: "client_contacts", email: "email", name: "full_name" },
  { label: "portal_users", table: "portal_users", email: "email_normalized", name: "display_name" },
  { label: "memberships", table: "memberships", email: "email", name: "display_name" },
];

/** One normalisation, used everywhere, so "A@x.com " and "a@x.com" are one address. */
const NORMALISED = (column) => `nullif(lower(btrim(${column})), '')`;

const unionAll = SOURCES.map((source) =>
  `SELECT '${source.label}'::text AS source, organisation_id,
          ${NORMALISED(source.email)} AS email,
          nullif(lower(btrim(${source.name})), '') AS person_name
     FROM nzi_console.${source.table}`).join("\n    UNION ALL\n    ");

const QUERIES = [
  {
    title: "Population — rows, and how many carry an email at all",
    // Every source listed even at zero: a table that is simply empty must not read as a table
    // nobody checked.
    sql: `WITH people AS (${unionAll}),
               sources(source) AS (VALUES ${SOURCES.map((source) => `('${source.label}')`).join(", ")})
          SELECT s.source,
                 count(p.source)::int                            AS rows,
                 count(p.email)::int                             AS with_email,
                 (count(p.source) - count(p.email))::int         AS without_email,
                 count(DISTINCT p.email)::int                    AS distinct_emails
            FROM sources s LEFT JOIN people p ON p.source = s.source
           GROUP BY s.source ORDER BY s.source`,
  },
  {
    title: "Normalisation — addresses that differ only by case or padding",
    note: "If this is non-zero, matching on the stored value rather than a normalised one would split the same person in two.",
    sql: `WITH people AS (${unionAll.replace(/nullif\(lower\(btrim\((personal_email|email|email_normalized)\)\), ''\)/g, "nullif(btrim($1), '')")})
          SELECT count(*)::int AS raw_distinct,
                 count(DISTINCT lower(email))::int AS normalised_distinct,
                 (count(*) - count(DISTINCT lower(email)))::int AS collapsed_by_normalising
            FROM (SELECT DISTINCT email FROM people WHERE email IS NOT NULL) distinct_raw`,
  },
  {
    title: "Deterministic linkage — one email, appearing in more than one table",
    note: "These are the people an email-keyed subject identity would join without a judgement call.",
    sql: `WITH people AS (${unionAll}),
               by_email AS (
                 SELECT organisation_id, email,
                        count(DISTINCT source)::int AS in_tables,
                        count(*)::int               AS rows
                   FROM people WHERE email IS NOT NULL
                  GROUP BY organisation_id, email)
          SELECT in_tables,
                 count(*)::int        AS emails,
                 sum(rows)::int       AS rows_covered
            FROM by_email GROUP BY in_tables ORDER BY in_tables`,
  },
  {
    title: "Ambiguity A — one email held by more than one row in the SAME table",
    note: "A shared mailbox (info@, accounts@) behind several contacts. Keying a subject on email would fuse different people.",
    sql: `WITH people AS (${unionAll})
          SELECT source, count(*)::int AS emails_shared_within_table, sum(rows)::int AS rows_affected
            FROM (SELECT source, organisation_id, email, count(*)::int AS rows
                    FROM people WHERE email IS NOT NULL
                   GROUP BY source, organisation_id, email HAVING count(*) > 1) shared
           GROUP BY source ORDER BY source`,
  },
  {
    title: "Ambiguity B — the same name under different email addresses",
    note: "Possibly one person with a work and a personal address; possibly two people who share a common name. Not resolvable by data alone.",
    sql: `WITH people AS (${unionAll})
          SELECT count(*)::int AS names_with_multiple_emails,
                 sum(emails)::int AS distinct_emails_involved
            FROM (SELECT organisation_id, person_name, count(DISTINCT email)::int AS emails
                    FROM people WHERE person_name IS NOT NULL AND email IS NOT NULL
                   GROUP BY organisation_id, person_name HAVING count(DISTINCT email) > 1) multi`,
  },
  {
    title: "Ambiguity C — links that exist only through a superseded trainee email",
    note: "A trainee who changed address, whose OLD address still matches a row elsewhere. Invisible to a current-email join.",
    sql: `WITH people AS (${unionAll}),
               history AS (
                 SELECT organisation_id,
                        ${NORMALISED("current_email")} AS old_email,
                        ${NORMALISED("new_email")}     AS new_email
                   FROM nzi_console.trainee_email_changes)
          SELECT count(*)::int AS rows_reachable_only_by_history
            FROM history h
            JOIN people p
              ON p.organisation_id = h.organisation_id
             AND p.email = h.old_email
           WHERE h.old_email IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM people q
                              WHERE q.organisation_id = h.organisation_id
                                AND q.email = h.new_email
                                AND q.source = p.source)`,
  },
  {
    title: "The shape of the answer — how many clusters an email key would form",
    note: "Clusters counted per organisation. Singletons are people who appear in exactly one table.",
    sql: `WITH people AS (${unionAll}),
               by_email AS (
                 SELECT organisation_id, email, count(DISTINCT source)::int AS in_tables
                   FROM people WHERE email IS NOT NULL
                  GROUP BY organisation_id, email)
          SELECT count(*)::int                                          AS clusters,
                 count(*) FILTER (WHERE in_tables = 1)::int             AS singletons,
                 count(*) FILTER (WHERE in_tables > 1)::int             AS spanning_two_or_more,
                 (SELECT count(*)::int FROM people WHERE email IS NULL) AS rows_with_no_email
            FROM by_email`,
  },
];

/**
 * SSL where the server speaks it, and not where it does not.
 *
 * The migration runner hardcodes SSL on, which is right for the hosted database and is also why it
 * cannot be run against a local Postgres — so its behaviour is only ever observed in the place it
 * matters least to get wrong. Deriving it from the host instead means this script can be proved
 * against a throwaway database first and then run where it counts, unchanged.
 */
const localHost = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(connectionString).hostname);
const client = new pg.Client({
  connectionString,
  ...(localHost ? {} : { ssl: { rejectUnauthorized: false } }),
});
await client.connect();

try {
  // Structural, not a promise: a write inside this transaction is refused by the server.
  await client.query("BEGIN TRANSACTION READ ONLY");

  for (const query of QUERIES) {
    console.log(`\n── ${query.title} ${"─".repeat(Math.max(0, 74 - query.title.length))}`);
    if (query.note) console.log(`   ${query.note}\n`);
    const { rows } = await client.query(query.sql);
    if (rows.length === 0) console.log("   (none)");
    else console.table(rows);
  }

  await client.query("COMMIT");
} finally {
  await client.end();
}

console.log("\nCounts only — no personal data is printed, and nothing was written.\n");
