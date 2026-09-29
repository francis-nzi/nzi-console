import { clientListSpec, dateOnlyOrNull, JOB_STATUS_ALL, jobListSpec, type ClientListFilterKey, type ClientListQuery, type JobListFilterKey, type JobListQuery, type ListPage } from "@nzi/contracts";
import type { Queryable } from "./postgres";
import { defineListSql, readListPage } from "./listPage";
import type { ClientStatus, JobFamily, JobScreenReadModel } from "./readModels";

/**
 * The Clients and Jobs lists (docs/LIST_PARITY_DESIGN.md §3–§4): two specs over {@link readListPage}.
 *
 * ## Labels are resolved once, in SQL, the way `clientReferences` resolves them
 *
 * A filter, a sort and a search must all act on the label the row displays, or a list would sort by one thing and
 * show another. So each reference is resolved here exactly as `resolveReference` does it — the curated label when
 * the record holds an id that resolves, else the record's own text, else nothing — and a blank becomes NULL, which
 * is what "Unspecified"/"Unassigned" matches.
 */

export type ClientListRow = {
  id: string; name: string; status: ClientStatus; sector: string; owner: string; portfolio: string | null; clientManager: string | null;
  location: string; memberSince: string; latestFootprint: string | null; yoy: string | null; completeness: number;
  openJobs: number; nextReportDue: string; contact: { name: string; role: string; email: string };
  jobs: Array<{ number: string; year: number; status: string }>;
};
export type ClientListSummary = {
  clients: number; openJobs: number; averageCompleteness: number | null; atRisk: number;
  withoutOwner: number; deliveryClients: number; deliveryWithoutJobs: number; activeWithoutFootprint: number;
};
export type ClientListPage = ListPage<ClientListRow, ClientListFilterKey, ClientListSummary>;

export type JobListRow = {
  id: string; number: string; legacyNumber: string | null; family: JobFamily; clientId: string; client: string; title: string;
  status: JobScreenReadModel["header"]["status"]; workflowStage: string; dueDate: string | null; manager: string | null; progressPct: number;
};
export type JobListSummary = { jobs: number; carbonReporting: number; averageProgress: number | null; dueWithin30Days: number };
export type JobListPage = ListPage<JobListRow, JobListFilterKey, JobListSummary>;

/** A blank string is no value at all. */
const clean = (expression: string) => `nullif(btrim(${expression}), '')`;

const clientSql = defineListSql<ClientListQuery["sort"]["key"], ClientListFilterKey>({
  base: `SELECT c.organisation_id, c.client_id, c.name, c.status::text AS status,
      coalesce(${clean("sv.label")}, ${clean("c.sector")}) AS industry,
      coalesce(${clean("ow.display_name")}, ${clean("c.owner_name")}) AS owner,
      ${clean("c.portfolio")} AS portfolio,
      coalesce(${clean("mg.display_name")}, ${clean("c.client_manager")}) AS manager,
      c.location, c.member_since, c.latest_footprint_tco2e AS footprint, c.yoy_percent, c.completeness_percent AS completeness,
      c.next_report_due_label,
      (SELECT count(*) FROM nzi_console.jobs j WHERE (j.organisation_id, j.client_id) = (c.organisation_id, c.client_id)
         AND j.status IN ('draft','open','on-hold'))::int AS open_jobs,
      (SELECT count(*) FROM nzi_console.jobs j WHERE (j.organisation_id, j.client_id) = (c.organisation_id, c.client_id))::int AS job_count
    FROM nzi_console.clients c
    LEFT JOIN nzi_console.reference_values sv ON (sv.organisation_id, sv.value_id) = (c.organisation_id, c.sector_value_id)
    LEFT JOIN nzi_console.memberships ow ON (ow.organisation_id, ow.user_id) = (c.organisation_id, c.owner_user_id)
    LEFT JOIN nzi_console.memberships mg ON (mg.organisation_id, mg.user_id) = (c.organisation_id, c.client_manager_user_id)`,
  search: ["name", "industry"],
  filters: {
    industry: { kind: "equals", column: "industry", facet: { noneLabel: "Unspecified" } },
    status: { kind: "equals", column: "status", facet: { noneLabel: "Unspecified" } },
    owner: { kind: "equals", column: "owner", facet: { noneLabel: "Unassigned" } },
    portfolio: { kind: "equals", column: "portfolio", facet: { noneLabel: "Unassigned" } },
    manager: { kind: "equals", column: "manager", facet: { noneLabel: "Unassigned" } },
  },
  sort: {
    name: { column: "name", text: true }, industry: { column: "industry", text: true }, status: { column: "status", text: true },
    owner: { column: "owner", text: true }, footprint: { column: "footprint" }, completeness: { column: "completeness" }, openJobs: { column: "open_jobs" },
  },
  tiebreak: "client_id",
  pageColumns: `
    (SELECT jsonb_build_object('name', k.full_name, 'role', coalesce(k.job_title, ''), 'email', coalesce(k.email, ''))
       FROM nzi_console.client_contacts k
      WHERE (k.organisation_id, k.client_id) = (base.organisation_id, base.client_id) AND k.is_primary AND k.status = 'active' LIMIT 1) AS primary_contact,
    coalesce((SELECT jsonb_agg(jsonb_build_object('number', j.job_number, 'year', coalesce(j.reporting_year, extract(year from j.start_date)::int), 'status', j.workflow_stage) ORDER BY j.sequence DESC)
       FROM nzi_console.jobs j WHERE (j.organisation_id, j.client_id) = (base.organisation_id, base.client_id)), '[]'::jsonb) AS jobs`,
  summary: `count(*)::int AS clients, coalesce(sum(open_jobs), 0)::int AS open_jobs, round(avg(completeness))::int AS average_completeness,
    count(*) FILTER (WHERE status = 'at-risk')::int AS at_risk,
    count(*) FILTER (WHERE owner IS NULL OR owner = 'Unassigned')::int AS without_owner,
    count(*) FILTER (WHERE status <> 'prospect')::int AS delivery_clients,
    count(*) FILTER (WHERE status <> 'prospect' AND job_count = 0)::int AS delivery_without_jobs,
    count(*) FILTER (WHERE status = 'active' AND footprint IS NULL)::int AS active_without_footprint`,
});

const footprint = (value: unknown) => value === null || value === undefined ? null : `${Number(value).toLocaleString("en-GB")} tCO₂e`;
const percentage = (value: unknown) => value === null || value === undefined ? null : `${Number(value) > 0 ? "+" : "−"}${Math.abs(Number(value)).toFixed(1)}%`;
const text = (value: unknown) => value === null || value === undefined ? null : String(value);

export async function listClients(db: Queryable, query: ClientListQuery): Promise<ClientListPage> {
  return readListPage(db, clientSql, clientListSpec, query, {
    mapRow: (row) => ({
      id: String(row.client_id), name: String(row.name), status: row.status as ClientStatus,
      sector: text(row.industry) ?? "", owner: text(row.owner) ?? "", portfolio: text(row.portfolio), clientManager: text(row.manager),
      location: text(row.location) ?? "", memberSince: row.member_since === null ? "" : String(row.member_since),
      latestFootprint: footprint(row.footprint), yoy: percentage(row.yoy_percent), completeness: Number(row.completeness ?? 0),
      openJobs: Number(row.open_jobs), nextReportDue: text(row.next_report_due_label) ?? "",
      contact: (row.primary_contact as ClientListRow["contact"] | null) ?? { name: "", role: "", email: "" },
      jobs: (row.jobs as ClientListRow["jobs"] | null) ?? [],
    }),
    mapSummary: (row) => ({
      clients: Number(row.clients ?? 0), openJobs: Number(row.open_jobs ?? 0),
      averageCompleteness: row.average_completeness === null || row.average_completeness === undefined ? null : Number(row.average_completeness),
      atRisk: Number(row.at_risk ?? 0), withoutOwner: Number(row.without_owner ?? 0), deliveryClients: Number(row.delivery_clients ?? 0),
      deliveryWithoutJobs: Number(row.delivery_without_jobs ?? 0), activeWithoutFootprint: Number(row.active_without_footprint ?? 0),
    }),
  });
}

/**
 * `$1` is the operating day (`todayInLondon`), passed in rather than read from the database clock, so "due within 30
 * days" means the same day the rest of the platform means — and a test can fix it.
 */
const jobSql = defineListSql<JobListQuery["sort"]["key"], JobListFilterKey>({
  base: `SELECT j.organisation_id, j.job_id, j.sequence, j.job_number, j.legacy_job_number, j.job_family::text AS family,
      j.client_id, c.name AS client, j.title, j.status::text AS status, j.workflow_stage, j.due_date, j.progress_percent,
      $1::date AS operating_day,
      /* Ruled D3: the job's manager, then the job's owner, then the client's manager. */
      coalesce(${clean("jm.display_name")}, ${clean("j.owner_name")}, ${clean("cm.display_name")}, ${clean("c.client_manager")}) AS manager
    FROM nzi_console.jobs j
    JOIN nzi_console.clients c ON (c.organisation_id, c.client_id) = (j.organisation_id, j.client_id)
    LEFT JOIN nzi_console.memberships jm ON (jm.organisation_id, jm.user_id) = (j.organisation_id, j.client_manager_user_id)
    LEFT JOIN nzi_console.memberships cm ON (cm.organisation_id, cm.user_id) = (c.organisation_id, c.client_manager_user_id)`,
  search: ["job_number", "legacy_job_number", "title", "client"],
  filters: {
    client: { kind: "equals", column: "client_id" },
    manager: { kind: "equals", column: "manager", facet: { noneLabel: "Unassigned" } },
    family: { kind: "equals", column: "family", facet: { noneLabel: "Unspecified" } },
    status: { kind: "equals", column: "status", facet: { noneLabel: "Unspecified" }, whenAbsent: "status <> 'cancelled'", allValue: JOB_STATUS_ALL },
    dueFrom: { kind: "onOrAfter", column: "due_date" },
    dueTo: { kind: "onOrBefore", column: "due_date" },
  },
  sort: {
    number: { column: "sequence" }, client: { column: "client", text: true }, title: { column: "title", text: true },
    family: { column: "family", text: true }, manager: { column: "manager", text: true }, dueDate: { column: "due_date" },
    status: { column: "status", text: true },
  },
  tiebreak: "sequence",
  summary: `count(*)::int AS jobs, count(*) FILTER (WHERE family = 'crp')::int AS carbon_reporting,
    round(avg(progress_percent))::int AS average_progress,
    count(*) FILTER (WHERE due_date >= operating_day AND due_date < operating_day + 30)::int AS due_within_30_days`,
});

export async function listJobs(db: Queryable, query: JobListQuery, context: { today: string }): Promise<JobListPage> {
  return readListPage(db, jobSql, jobListSpec, query, {
    baseParams: [context.today],
    mapRow: (row) => ({
      id: String(row.job_id), number: String(row.job_number), legacyNumber: text(row.legacy_job_number), family: row.family as JobFamily,
      clientId: String(row.client_id), client: String(row.client), title: String(row.title), status: row.status as JobListRow["status"],
      workflowStage: String(row.workflow_stage), dueDate: dateOnlyOrNull(row.due_date as Date | string | null), manager: text(row.manager),
      progressPct: Number(row.progress_percent ?? 0),
    }),
    mapSummary: (row) => ({
      jobs: Number(row.jobs ?? 0), carbonReporting: Number(row.carbon_reporting ?? 0),
      averageProgress: row.average_progress === null || row.average_progress === undefined ? null : Number(row.average_progress),
      dueWithin30Days: Number(row.due_within_30_days ?? 0),
    }),
  });
}
