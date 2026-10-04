import {
  budgetStatus, budgetUsedPct, capacityMinutes, utilisationPct, weekdaysBetween,
  type OversightJob, type PayrollPerson, type TimeMoney, type TimeOversight, type TimePayroll, type TimePeriod, type TimeUtilisation, type UtilisationPerson,
} from "@nzi/contracts";
import { capabilityScope, type CapabilityHolder } from "./access";
import { AuthorizationError } from "./auth";
import type { Queryable } from "./postgres";

/**
 * Time PR B — the reads over the entries (TIME-v7-RULINGS ⚑5, ⚑6, ⚑8; the approved mockup). Every figure is computed
 * from `time_entries`; nothing is captured twice.
 *
 * - **Oversight**: jobs over their budgeted hours ("budget used", never "utilisation" — ⚑8), and jobs whose labour cost
 *   runs over the fee (⚑6). `time.view`; an own-clients holder sees their own clients' jobs.
 * - **Payroll** and **Utilisation** span the whole team, so they need `time.view` across all clients — an own-clients
 *   holder is refused rather than shown a partial team that reads as the whole.
 * - **Money** (cost, charge, fee, margin) is computed only for a `finance.view` holder, per job for an own-clients one,
 *   and is otherwise null — not zero. Voided entries never count.
 */

type Holder = CapabilityHolder;
type MoneyRow = { currencies: string; currency: string | null; cost: string | null; charge: string | null; unrated: string };

/** The money columns over a set of entries `t`, filtered by `filter` (SQL), as a MoneyRow. */
const moneySql = (filter: string) => `
  count(DISTINCT t.rate_currency) FILTER (WHERE ${filter} AND t.rate_id IS NOT NULL)::text AS currencies,
  min(t.rate_currency) FILTER (WHERE ${filter} AND t.rate_id IS NOT NULL) AS currency,
  round(coalesce(sum(t.minutes * t.cost_rate) FILTER (WHERE ${filter}), 0) / 60.0, 2)::text AS cost,
  round(coalesce(sum(t.minutes * t.charge_rate) FILTER (WHERE ${filter}), 0) / 60.0, 2)::text AS charge,
  coalesce(sum(t.minutes) FILTER (WHERE ${filter} AND t.rate_id IS NULL), 0)::text AS unrated`;

/** Money from its row: entries in more than one currency are never summed into one figure. */
export function moneyFrom(row: MoneyRow): TimeMoney {
  const mixed = Number(row.currencies) > 1;
  return {
    currency: mixed ? null : row.currency, mixedCurrency: mixed,
    cost: mixed ? null : Number(row.cost ?? 0), charge: mixed ? null : Number(row.charge ?? 0),
    unratedMinutes: Number(row.unrated),
  };
}

/** finance.view on a job: everywhere, or on one's own clients' jobs. */
function moneyOnJob(holder: Holder, clientOwner: string | null): boolean {
  const scope = capabilityScope(holder, "finance.view");
  return scope === "all" || (scope === "own_clients" && clientOwner === holder.userId);
}

function requireTeamWide(holder: Holder, what: string) {
  const scope = capabilityScope(holder, "time.view");
  if (scope === null) throw new AuthorizationError("time.view", `${what} needs time.view.`);
  if (scope !== "all") throw new AuthorizationError("time.view", `${what} spans the whole team, so it needs time.view across all clients.`);
}

// ── Oversight ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The jobs with time in the period. A job's logged hours and cost are **to date as at the period's end** — a budget is
 * the whole job's, so "budget used" compares everything logged on it so far — beside the period's own hours.
 */
export async function readTimeOversight(db: Queryable, holder: Holder, period: TimePeriod): Promise<TimeOversight> {
  const scope = capabilityScope(holder, "time.view");
  if (scope === null) throw new AuthorizationError("time.view", "Oversight needs time.view.");
  const { rows } = await db.query<MoneyRow & {
    job_id: string; job_number: string; title: string; client: string; family: string; owner_name: string | null; client_owner: string | null;
    budgeted_hours: string | null; fee_amount: string | null; logged: string; period_minutes: string; billable_minutes: string;
  }>(
    `SELECT j.job_id, j.job_number, j.title, c.name AS client, j.job_family::text AS family, nullif(btrim(j.owner_name), '') AS owner_name,
            c.owner_user_id AS client_owner, j.budgeted_hours::text AS budgeted_hours, j.fee_amount::text AS fee_amount,
            sum(t.minutes)::text AS logged,
            coalesce(sum(t.minutes) FILTER (WHERE t.work_date >= $2::date), 0)::text AS period_minutes,
            coalesce(sum(t.minutes) FILTER (WHERE t.work_date >= $2::date AND t.billable), 0)::text AS billable_minutes,
            ${moneySql("true")}
       FROM nzi_console.time_entries t
       JOIN nzi_console.jobs j ON (j.organisation_id, j.job_id) = (t.organisation_id, t.job_id)
       JOIN nzi_console.clients c ON (c.organisation_id, c.client_id) = (j.organisation_id, j.client_id)
      WHERE t.organisation_id = $1 AND t.active AND t.work_date <= $3::date AND ($4::text IS NULL OR c.owner_user_id = $4)
      GROUP BY j.job_id, j.job_number, j.title, c.name, j.job_family, j.owner_name, c.owner_user_id, j.budgeted_hours, j.fee_amount, j.sequence
     HAVING coalesce(sum(t.minutes) FILTER (WHERE t.work_date >= $2::date), 0) > 0`,
    [holder.organisationId, period.from, period.to, scope === "own_clients" ? holder.userId : null]);

  const jobs: OversightJob[] = rows.map((row) => {
    const budgetedMinutes = row.budgeted_hours === null ? null : Math.round(Number(row.budgeted_hours) * 60);
    const loggedMinutes = Number(row.logged);
    const pct = budgetUsedPct(loggedMinutes, budgetedMinutes);
    let money: OversightJob["money"] = null;
    if (moneyOnJob(holder, row.client_owner)) {
      const base = moneyFrom(row);
      const fee = row.fee_amount === null ? null : Number(row.fee_amount);
      const margin = fee !== null && base.cost !== null ? Math.round((fee - base.cost) * 100) / 100 : null;
      money = { ...base, fee, margin, overCost: margin === null ? null : margin < 0 };
    }
    return {
      jobId: row.job_id, jobNumber: row.job_number, title: row.title, clientName: row.client, family: row.family, ownerName: row.owner_name,
      loggedMinutes, periodMinutes: Number(row.period_minutes), billableMinutes: Number(row.billable_minutes),
      budgetedMinutes, budgetUsedPct: pct, budgetStatus: budgetStatus(pct), money,
    };
  });
  // Over first, the most over at the top; then approaching; then the rest by share used; no budget last.
  const rank = { over: 0, approaching: 1, "on-track": 2, "no-budget": 3 } as const;
  jobs.sort((a, b) => rank[a.budgetStatus] - rank[b.budgetStatus] || (b.budgetUsedPct ?? -1) - (a.budgetUsedPct ?? -1) || a.jobNumber.localeCompare(b.jobNumber));
  const costed = jobs.filter((job) => job.money !== null);
  return {
    period, jobs,
    totals: {
      periodMinutes: jobs.reduce((sum, job) => sum + job.periodMinutes, 0),
      billableMinutes: jobs.reduce((sum, job) => sum + job.billableMinutes, 0),
      overBudget: jobs.filter((job) => job.budgetStatus === "over").length,
      approaching: jobs.filter((job) => job.budgetStatus === "approaching").length,
      overCost: costed.length ? costed.filter((job) => job.money!.overCost === true).length : null,
    },
    allClients: scope === "all",
  };
}

// ── The team: payroll and utilisation ──────────────────────────────────────────────────────────────────────────

/** Everyone active, plus anyone with time in the period (a person since deactivated was still worked and paid). */
const teamSql = `
  SELECT p.user_id, coalesce(nullif(btrim(m.display_name), ''), p.user_id) AS name,
         coalesce(m.weekly_capacity_hours, 37.5)::text AS capacity, coalesce(m.version, 0) AS version
    FROM (SELECT user_id FROM nzi_console.memberships WHERE organisation_id = $1 AND status = 'active'
          UNION SELECT user_id FROM nzi_console.time_entries WHERE organisation_id = $1 AND active AND work_date BETWEEN $2::date AND $3::date) p
    LEFT JOIN nzi_console.memberships m ON (m.organisation_id, m.user_id) = ($1, p.user_id)`;

type PersonTime = MoneyRow & { user_id: string; minutes: string; billable: string; entries: string };
async function timeByPerson(db: Queryable, holder: Holder, period: TimePeriod): Promise<Map<string, PersonTime>> {
  const { rows } = await db.query<PersonTime>(
    `SELECT t.user_id, sum(t.minutes)::text AS minutes, coalesce(sum(t.minutes) FILTER (WHERE t.billable), 0)::text AS billable, count(*)::text AS entries,
            ${moneySql("true")}
       FROM nzi_console.time_entries t
      WHERE t.organisation_id = $1 AND t.active AND t.work_date BETWEEN $2::date AND $3::date
      GROUP BY t.user_id`, [holder.organisationId, period.from, period.to]);
  return new Map(rows.map((row) => [row.user_id, row]));
}

/** Payroll: each person's hours over the period — and, for finance.view across all clients, their cost. */
export async function readTimePayroll(db: Queryable, holder: Holder, period: TimePeriod): Promise<TimePayroll> {
  requireTeamWide(holder, "Payroll");
  // A person's cost spans every client's jobs, so only an all-clients finance.view sees it; an own-clients one would see
  // part of a person's pay presented as the whole.
  const moneyVisible = capabilityScope(holder, "finance.view") === "all";
  const [team, time] = await Promise.all([
    db.query<{ user_id: string; name: string }>(teamSql, [holder.organisationId, period.from, period.to]),
    timeByPerson(db, holder, period),
  ]);
  const people: PayrollPerson[] = team.rows.map((person) => {
    const row = time.get(person.user_id);
    const total = Number(row?.minutes ?? 0), billable = Number(row?.billable ?? 0);
    return {
      userId: person.user_id, name: person.name, billableMinutes: billable, nonBillableMinutes: total - billable, totalMinutes: total,
      entries: Number(row?.entries ?? 0),
      money: moneyVisible ? (row ? moneyFrom(row) : { currency: null, mixedCurrency: false, cost: 0, charge: 0, unratedMinutes: 0 }) : null,
    };
  });
  people.sort((a, b) => b.totalMinutes - a.totalMinutes || a.name.localeCompare(b.name));
  return { period, people, moneyVisible };
}

/** Utilisation (⚑8, capacity only): logged hours against each person's weekly capacity, over the period's weekdays. */
export async function readTimeUtilisation(db: Queryable, holder: Holder, period: TimePeriod): Promise<TimeUtilisation> {
  requireTeamWide(holder, "Utilisation");
  const weekdays = weekdaysBetween(period.from, period.to);
  const [team, time] = await Promise.all([
    db.query<{ user_id: string; name: string; capacity: string; version: number }>(teamSql, [holder.organisationId, period.from, period.to]),
    timeByPerson(db, holder, period),
  ]);
  const people: UtilisationPerson[] = team.rows.map((person) => {
    const row = time.get(person.user_id);
    const weekly = Number(person.capacity), capacity = capacityMinutes(weekly, weekdays), logged = Number(row?.minutes ?? 0);
    return {
      userId: person.user_id, name: person.name, weeklyCapacityHours: weekly, capacityMinutes: capacity,
      loggedMinutes: logged, billableMinutes: Number(row?.billable ?? 0), utilisationPct: utilisationPct(logged, capacity), version: Number(person.version),
    };
  });
  people.sort((a, b) => (b.utilisationPct ?? -1) - (a.utilisationPct ?? -1) || a.name.localeCompare(b.name));
  return { period, weekdays, people, capacityEditable: capabilityScope(holder, "admin.users") === "all" };
}
