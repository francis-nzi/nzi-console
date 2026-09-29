import { RISK_RANK, type RiskLevel } from "@nzi/contracts";

/**
 * The Risk rule — defined once (docs/LIST_PARITY_DESIGN.md, PR 2).
 *
 * v7's rule, exactly (api/job_management_routes.py:777–814; api/client_index_routes.py:33–47):
 *
 * - Only a milestone with a due date counts. A completed milestone counts as neither Overdue nor Due.
 * - **Overdue** — an unfinished milestone more than one day past due: `due < day − 1`.
 * - **Due** — otherwise, an unfinished milestone due within seven days: `due ≤ day + 7` (so due yesterday is Due).
 * - **Healthy** — otherwise, when the job has at least one dated milestone.
 * - **Not set** — no dated milestone at all. v7 shows this as Healthy; the ruling makes it its own state (R5 ranks it
 *   below Healthy: Overdue 3 > Due 2 > Healthy 1 > Not set 0).
 * - A client is the worst of its jobs (see {@link CLIENT_RISK_JOBS} for which jobs).
 *
 * `jobs.due_date` (End date) plays no part, here or anywhere Risk is read.
 *
 * **The operating day** is `todayInLondon()`, passed in — never the database's `CURRENT_DATE`, which is UTC and turns
 * over an hour early during British Summer Time. That is a deliberate, more correct deviation from v7 (ruled A1).
 *
 * The SQL fragments below are what every list reads. {@link riskOf} is the same rule in TypeScript, for the backfill's
 * report and for tests — and a real-database test runs both over one table, so the two cannot drift apart.
 */

/**
 * Ruled R1, provisionally: which of a client's jobs its Risk rolls up over. v7 uses every job; the provisional ruling
 * is to leave cancelled jobs out (v7's archived jobs import as cancelled). Confirmed on the dry-run numbers — changing
 * it is this one line.
 */
export const CLIENT_RISK_JOBS: ClientRiskJobSet = "exclude-cancelled";
export type ClientRiskJobSet = "all" | "exclude-cancelled";

const JOB_SET_SQL: Record<ClientRiskJobSet, (alias: string) => string> = {
  all: () => "true",
  "exclude-cancelled": (alias) => `${alias}.status <> 'cancelled'`,
};
export const clientRiskIncludesJob = (status: string, jobSet: ClientRiskJobSet = CLIENT_RISK_JOBS): boolean =>
  jobSet === "all" || status !== "cancelled";

/**
 * A job's risk rank (3 Overdue … 0 Not set), as a scalar subquery on the job aliased `job`. `day` is a SQL expression
 * of type date — a bound parameter, never the database clock.
 */
export function jobRiskRankSql(job: string, day: string): string {
  return `(SELECT CASE
      WHEN bool_or(m.completed_at IS NULL AND m.due_date < ${day} - 1) THEN 3
      WHEN bool_or(m.completed_at IS NULL AND m.due_date <= ${day} + 7) THEN 2
      WHEN bool_or(m.due_date IS NOT NULL) THEN 1
      ELSE 0 END
    FROM nzi_console.job_milestones m WHERE (m.organisation_id, m.job_id) = (${job}.organisation_id, ${job}.job_id))`;
}

/** A client's risk rank: the worst of its jobs in the ruled job set; Not set (0) when none has a dated milestone. */
export function clientRiskRankSql(client: string, day: string, jobSet: ClientRiskJobSet = CLIENT_RISK_JOBS): string {
  return `(SELECT coalesce(max(${jobRiskRankSql("rj", day)}), 0) FROM nzi_console.jobs rj
    WHERE (rj.organisation_id, rj.client_id) = (${client}.organisation_id, ${client}.client_id) AND ${JOB_SET_SQL[jobSet]("rj")})`;
}

/** The label for a rank column. */
export const riskLabelSql = (rank: string): string =>
  `CASE ${rank} WHEN 3 THEN 'Overdue' WHEN 2 THEN 'Due' WHEN 1 THEN 'Healthy' ELSE 'Not set' END`;

// ── The same rule in TypeScript ─────────────────────────────────────────────────────────────────────────────────

export type RiskMilestone = { dueDate: string | null; completedAt: string | null };

const dayNumber = (day: string): number => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / 86_400_000;

/** One milestone's contribution: Overdue, Due, Healthy (dated, and either done or not yet close), or nothing (undated). */
export function milestoneRisk(milestone: RiskMilestone, operatingDay: string): Exclude<RiskLevel, "Not set"> | null {
  if (milestone.dueDate === null) return null;
  if (milestone.completedAt !== null) return "Healthy";
  const daysUntilDue = dayNumber(milestone.dueDate) - dayNumber(operatingDay);
  if (daysUntilDue < -1) return "Overdue";
  if (daysUntilDue <= 7) return "Due";
  return "Healthy";
}

/** The worst of several levels; Not set when there are none. */
export const worstRisk = (levels: Iterable<RiskLevel | null>): RiskLevel => {
  let worst: RiskLevel = "Not set";
  for (const level of levels) if (level !== null && RISK_RANK[level] > RISK_RANK[worst]) worst = level;
  return worst;
};

/** A job's Risk from its milestones. */
export const riskOf = (milestones: readonly RiskMilestone[], operatingDay: string): RiskLevel =>
  worstRisk(milestones.map((milestone) => milestoneRisk(milestone, operatingDay)));
