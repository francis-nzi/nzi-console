// 0238 rule 3 (ruled 25 Nov 2026) — "Use J… figures as the baseline". The baseline year's own CRP job supplies its figures:
// when that job has a current reviewed snapshot, one confirm writes Scope 1/2/3 from it, audited, citing the snapshot id.
// Typing figures by hand (client.update) stays possible and clears the citation.
import { randomUUID } from "node:crypto";
import { isSamePeriod, type CommandContext, type CommandInputMap } from "@nzi/contracts";
import { requireConditionalCapability } from "./access";
import { dateOnly } from "./dates";
import { VersionConflictError } from "./errors";
import type { PoolLike } from "./postgres";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";

export type UseSnapshotBaselineResult = {
  clientId: string; version: number; snapshotId: string; jobId: string; jobNumber: string;
  scope1Tco2e: number | null; scope2Tco2e: number | null; scope3Tco2e: number | null; totalTco2e: number;
  rebaselined: boolean;
};

const refuse = (field: string, code: string, message: string) => new CommandValidationError([{ field, code, message }]);
const tonnes = (value: string | null) => value === null ? null : Number(value);
const date = (value: Date | string | null) => value === null ? null : value instanceof Date ? dateOnly(value) : String(value).slice(0, 10);

/**
 * The figures are summed from the snapshot's frozen measurements, per scope, on the server — never sent by the caller. A
 * scope with no measured rows is left unset (pending), never 0, as the job-derived baseline load leaves it; the total is
 * the sum of the scopes that have rows. On a baseline that already has figures this is the governed re-baseline:
 * baseline.rebaseline, a reason, a baseline_change_events row with the prior figures, and the client_rebaselined event.
 */
export function useSnapshotAsBaseline(pool: PoolLike, input: CommandInputMap["client.baseline.useSnapshot"], context: CommandContext): Promise<StoredOutcome<UseSnapshotBaselineResult>> {
  return runPostgresCommand(pool, "client.baseline.useSnapshot", input, context, async (db, access) => {
    const client = (await db.query<{
      version: number; baseline_period_start: Date | string | null; baseline_period_end: Date | string | null;
      baseline_scope1_tco2e: string | null; baseline_scope2_tco2e: string | null; baseline_scope3_tco2e: string | null; baseline_total_tco2e: string | null; baseline_snapshot_id: string | null;
    }>(
      `SELECT version, baseline_period_start, baseline_period_end, baseline_scope1_tco2e, baseline_scope2_tco2e, baseline_scope3_tco2e, baseline_total_tco2e, baseline_snapshot_id
         FROM nzi_console.clients WHERE organisation_id = $1 AND client_id = $2 FOR UPDATE`, [context.organisationId, input.clientId])).rows[0];
    if (!client) throw refuse("clientId", "NOT_FOUND", "Client was not found.");
    if (client.version !== input.expectedVersion) throw new VersionConflictError(input.expectedVersion, client.version);
    const periodStart = date(client.baseline_period_start), periodEnd = date(client.baseline_period_end);
    if (!periodStart || !periodEnd) throw refuse("clientId", "BASELINE_YEAR_REQUIRED", "Set the baseline year first — the job's figures are used for the baseline period.");

    const snapshot = (await db.query<{
      job_id: string; job_number: string; client_id: string; job_family: string; status: string; snapshot_version: number;
      period_from: Date | string | null; period_to: Date | string | null; latest_version: number; superseded: boolean;
      measurements: Array<{ scope: string; tco2e: number | string }> | null;
    }>(
      `SELECT j.job_id, j.job_number, j.client_id, j.job_family, j.status, s.snapshot_version,
              coalesce(j.reporting_period_start, c.reporting_from) AS period_from, coalesce(j.reporting_period_end, c.reporting_to) AS period_to,
              (SELECT max(o.snapshot_version) FROM nzi_console.reviewed_crp_snapshots o WHERE (o.organisation_id, o.job_id) = (s.organisation_id, s.job_id)) AS latest_version,
              EXISTS (SELECT 1 FROM nzi_console.reviewed_crp_snapshot_supersessions x WHERE (x.organisation_id, x.snapshot_id) = (s.organisation_id, s.snapshot_id)) AS superseded,
              s.payload_json->'measurements' AS measurements
         FROM nzi_console.reviewed_crp_snapshots s
         JOIN nzi_console.jobs j ON (j.organisation_id, j.job_id) = (s.organisation_id, s.job_id)
         LEFT JOIN nzi_console.job_emissions_config c ON (c.organisation_id, c.job_id) = (j.organisation_id, j.job_id)
        WHERE s.organisation_id = $1 AND s.snapshot_id = $2`, [context.organisationId, input.snapshotId])).rows[0];
    if (!snapshot || snapshot.client_id !== input.clientId || snapshot.job_family !== "crp") throw refuse("snapshotId", "NOT_FOUND", "That reviewed snapshot is not one of this client's CRP jobs.");
    if (snapshot.status === "cancelled") throw refuse("snapshotId", "JOB_CANCELLED", `${snapshot.job_number} is cancelled, so its figures cannot be the baseline.`);
    if (snapshot.superseded || snapshot.snapshot_version !== snapshot.latest_version) throw refuse("snapshotId", "SNAPSHOT_NOT_CURRENT", `That is not ${snapshot.job_number}'s current reviewed snapshot.`);
    const from = date(snapshot.period_from), to = date(snapshot.period_to);
    if (!from || !to || !isSamePeriod(from, to, periodStart, periodEnd)) {
      throw refuse("snapshotId", "NOT_BASELINE_PERIOD", `${snapshot.job_number}'s reporting period is not the baseline period, so its figures cannot be the baseline.`);
    }

    const sums: Record<"1" | "2" | "3", number | null> = { "1": null, "2": null, "3": null };
    for (const measurement of snapshot.measurements ?? []) {
      const scope = String(measurement.scope) as "1" | "2" | "3";
      if (!(scope in sums)) continue;
      sums[scope] = (sums[scope] ?? 0) + Number(measurement.tco2e);
    }
    const present = (["1", "2", "3"] as const).map((scope) => sums[scope]).filter((value): value is number => value !== null);
    if (present.length === 0) throw refuse("snapshotId", "NO_FIGURES", `${snapshot.job_number}'s reviewed snapshot has no measured rows to use as the baseline.`);
    const total = present.reduce((sum, value) => sum + value, 0);

    const before = {
      baselineScope1Tco2e: tonnes(client.baseline_scope1_tco2e), baselineScope2Tco2e: tonnes(client.baseline_scope2_tco2e),
      baselineScope3Tco2e: tonnes(client.baseline_scope3_tco2e), baselineTotalTco2e: tonnes(client.baseline_total_tco2e),
      baselineSnapshotId: client.baseline_snapshot_id,
    };
    const after = { baselineScope1Tco2e: sums["1"], baselineScope2Tco2e: sums["2"], baselineScope3Tco2e: sums["3"], baselineTotalTco2e: total, baselineSnapshotId: input.snapshotId };
    const hadFigures = [before.baselineScope1Tco2e, before.baselineScope2Tco2e, before.baselineScope3Tco2e, before.baselineTotalTco2e].some((value) => value !== null);
    // Changing figures that exist is the governed re-baseline (NZC-068), with the prior kept; adding the first figures is not.
    if (hadFigures) {
      requireConditionalCapability(context, "baseline.rebaseline", access);
      if (!context.reason?.trim()) throw refuse("reason", "REASON_REQUIRED", "The baseline already has figures, so replacing them is a re-baseline and needs a reason.");
      await db.query(
        `INSERT INTO nzi_console.baseline_change_events (organisation_id, change_id, client_id, job_id, subject, reason, before_json, after_json, changed_by, correlation_id)
         VALUES ($1,$2,$3,$4,'client_baseline',$5,$6::jsonb,$7::jsonb,$8,$9)`,
        [context.organisationId, randomUUID(), input.clientId, snapshot.job_id, context.reason.trim(), JSON.stringify(before), JSON.stringify(after), context.actorId, context.correlationId],
      );
    }
    const updated = await db.query<{ version: number }>(
      `UPDATE nzi_console.clients
          SET baseline_scope1_tco2e = $4, baseline_scope2_tco2e = $5, baseline_scope3_tco2e = $6, baseline_total_tco2e = $7, baseline_snapshot_id = $8,
              version = version + 1, updated_at = now()
        WHERE organisation_id = $1 AND client_id = $2 AND version = $3 RETURNING version`,
      [context.organisationId, input.clientId, input.expectedVersion, sums["1"], sums["2"], sums["3"], total, input.snapshotId],
    );
    if (!updated.rows[0]) throw new VersionConflictError(input.expectedVersion, input.expectedVersion + 1);
    return {
      data: {
        clientId: input.clientId, version: updated.rows[0].version, snapshotId: input.snapshotId, jobId: snapshot.job_id, jobNumber: snapshot.job_number,
        scope1Tco2e: sums["1"], scope2Tco2e: sums["2"], scope3Tco2e: sums["3"], totalTco2e: total, rebaselined: hadFigures,
      },
      before,
      entityType: "client",
      entityId: input.clientId,
      topic: "client.updated",
      ...(hadFigures ? { governedEvents: [{ action: "client_rebaselined", entityType: "client", entityId: input.clientId, before, after }] } : {}),
    };
  });
}
