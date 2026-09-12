// Intensity metrics — the client defines the set, the job records the annual values.
//
// A definition change writes the next version and leaves the one before it readable, so a
// report issued last year keeps the wording and divider it was issued with. Deactivating
// keeps the metric for historical reporting; nothing is ever hard-deleted.
import { suggestIconKey, type CommandContext, type CommandInputMap } from "@nzi/contracts";
import { listClientIntensityMetrics } from "./intensityMetricRecords";
import { VersionConflictError } from "./errors";
import type { PoolLike } from "./postgres";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";
export * from "./intensityMetricRecords";

export type SetIntensityMetricResult = { clientId: string; metricKey: string; version: number };

/** Define or redefine one metric. Standard metrics keep their identity: only wording, divider and icon move. */
export function setClientIntensityMetric(pool: PoolLike, input: CommandInputMap["client.intensityMetric.set"], context: CommandContext): Promise<StoredOutcome<SetIntensityMetricResult>> {
  return runPostgresCommand(pool, "client.intensityMetric.set", input, context, async (db) => {
    const current = await db.query<{ version: number; is_standard: boolean; value_source: "entered" | "site-floor-area"; ordering: number; active: boolean; label: string; unit_wording: string; divider: number; icon_key: string }>(
      `SELECT version,is_standard,value_source,ordering,active,label,unit_wording,divider,icon_key
       FROM nzi_console.client_intensity_metrics WHERE organisation_id=$1 AND client_id=$2 AND metric_key=$3
       ORDER BY version DESC LIMIT 1`,
      [context.organisationId, input.clientId, input.metricKey]);
    const previous = current.rows[0] ?? null;
    if ((previous?.version ?? 0) !== input.expectedVersion) throw new VersionConflictError(input.expectedVersion, previous?.version ?? 0);

    const version = (previous?.version ?? 0) + 1;
    const ordering = input.ordering ?? previous?.ordering ?? 99;
    await db.query(
      `INSERT INTO nzi_console.client_intensity_metrics
        (organisation_id,client_id,metric_key,version,label,unit_wording,divider,icon_key,is_standard,value_source,active,ordering,set_by,correlation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,$11,$12,$13)`,
      [context.organisationId, input.clientId, input.metricKey, version, input.label.trim(), input.unitWording.trim(),
        input.divider, input.iconKey, previous?.is_standard ?? false, previous?.value_source ?? "entered", ordering,
        context.actorId, context.correlationId]);

    return {
      data: { clientId: input.clientId, metricKey: input.metricKey, version },
      entityType: "client_intensity_metric", entityId: `${input.clientId}:${input.metricKey}`, topic: "client.intensity_metric.set",
      ...(previous ? { before: { label: previous.label, unitWording: previous.unit_wording, divider: previous.divider, iconKey: previous.icon_key, active: previous.active } } : {}),
      after: { label: input.label.trim(), unitWording: input.unitWording.trim(), divider: input.divider, iconKey: input.iconKey, active: true },
    };
  });
}

/** Deactivate, never delete: a historical report still needs the metric it was issued with. */
export function deactivateClientIntensityMetric(pool: PoolLike, input: CommandInputMap["client.intensityMetric.deactivate"], context: CommandContext): Promise<StoredOutcome<SetIntensityMetricResult>> {
  return runPostgresCommand(pool, "client.intensityMetric.deactivate", input, context, async (db) => {
    const current = await db.query<{ version: number; label: string; unit_wording: string; divider: number; icon_key: string; is_standard: boolean; value_source: "entered" | "site-floor-area"; ordering: number; active: boolean }>(
      `SELECT version,label,unit_wording,divider,icon_key,is_standard,value_source,ordering,active
       FROM nzi_console.client_intensity_metrics WHERE organisation_id=$1 AND client_id=$2 AND metric_key=$3
       ORDER BY version DESC LIMIT 1`,
      [context.organisationId, input.clientId, input.metricKey]);
    const previous = current.rows[0];
    if (!previous) throw new CommandValidationError([{ field: "metricKey", code: "NOT_FOUND", message: "That metric is not defined for this client." }]);
    if (previous.version !== input.expectedVersion) throw new VersionConflictError(input.expectedVersion, previous.version);

    const version = previous.version + 1;
    await db.query(
      `INSERT INTO nzi_console.client_intensity_metrics
        (organisation_id,client_id,metric_key,version,label,unit_wording,divider,icon_key,is_standard,value_source,active,ordering,set_by,correlation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,$11,$12,$13)`,
      [context.organisationId, input.clientId, input.metricKey, version, previous.label, previous.unit_wording,
        previous.divider, previous.icon_key, previous.is_standard, previous.value_source, previous.ordering,
        context.actorId, context.correlationId]);

    return {
      data: { clientId: input.clientId, metricKey: input.metricKey, version },
      entityType: "client_intensity_metric", entityId: `${input.clientId}:${input.metricKey}`, topic: "client.intensity_metric.deactivated",
      before: { active: true }, after: { active: false },
    };
  });
}

export type SetIntensityValueResult = { jobId: string; reportingYear: number; metricKey: string; version: number };

/** Record one metric's value for one reporting year on this job. */
export function setJobIntensityValue(pool: PoolLike, input: CommandInputMap["job.intensityValue.set"], context: CommandContext): Promise<StoredOutcome<SetIntensityValueResult>> {
  return runPostgresCommand(pool, "job.intensityValue.set", input, context, async (db) => {
    const client = await db.query<{ client_id: string }>(`SELECT client_id FROM nzi_console.jobs WHERE organisation_id=$1 AND job_id=$2`, [context.organisationId, input.jobId]);
    const clientId = client.rows[0]?.client_id;
    if (!clientId) throw new CommandValidationError([{ field: "jobId", code: "NOT_FOUND", message: "That job does not exist." }]);

    // The metric has to be one this client has defined and still uses.
    const definitions = await listClientIntensityMetrics(db, clientId);
    const definition = definitions.find((entry) => entry.key === input.metricKey);
    if (!definition) throw new CommandValidationError([{ field: "metricKey", code: "NOT_DEFINED", message: "That metric is not defined for this client. Add it on the client before recording values." }]);
    if (!definition.active) throw new CommandValidationError([{ field: "metricKey", code: "METRIC_INACTIVE", message: "That metric is deactivated for this client." }]);

    const periodKey = input.periodKey ?? "year";
    const existing = await db.query<{ version: number; value: string | null }>(
      `SELECT version,value::text FROM nzi_console.job_intensity_values
       WHERE organisation_id=$1 AND job_id=$2 AND reporting_year=$3 AND metric_key=$4 AND period_key=$5 FOR UPDATE`,
      [context.organisationId, input.jobId, input.reportingYear, input.metricKey, periodKey]);
    const previous = existing.rows[0] ?? null;
    if ((previous?.version ?? 0) !== input.expectedVersion) throw new VersionConflictError(input.expectedVersion, previous?.version ?? 0);

    // A typed value against a site-derived metric is an override, and says so.
    const overrides = definition.valueSource === "site-floor-area" && input.value !== null;
    const saved = previous
      ? await db.query<{ version: number }>(
        `UPDATE nzi_console.job_intensity_values SET value=$6,overrides_resolved=$7,note=$8,recorded_by=$9,recorded_at=now(),version=version+1
         WHERE organisation_id=$1 AND job_id=$2 AND reporting_year=$3 AND metric_key=$4 AND period_key=$5 RETURNING version`,
        [context.organisationId, input.jobId, input.reportingYear, input.metricKey, periodKey, input.value, overrides, input.note ?? "", context.actorId])
      : await db.query<{ version: number }>(
        `INSERT INTO nzi_console.job_intensity_values (organisation_id,job_id,reporting_year,metric_key,period_key,value,overrides_resolved,note,recorded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING version`,
        [context.organisationId, input.jobId, input.reportingYear, input.metricKey, periodKey, input.value, overrides, input.note ?? "", context.actorId]);

    return {
      data: { jobId: input.jobId, reportingYear: input.reportingYear, metricKey: input.metricKey, version: saved.rows[0]!.version },
      entityType: "job_intensity_value", entityId: `${input.jobId}:${input.reportingYear}:${input.metricKey}`, topic: "job.intensity_value.set",
      ...(previous ? { before: { value: previous.value === null ? null : Number(previous.value) } } : {}),
      after: { value: input.value, periodKey, overridesResolved: overrides },
    };
  });
}

/** The icon a new metric starts with, before anyone overrides it. */
export const suggestedIconFor = suggestIconKey;
