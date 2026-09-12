import type { Queryable } from "./postgres";
import type { SrsAssessment, SrsAssessmentItem, SrsFramework, SrsMaturity } from "@nzi/contracts";

/**
 * Reading the SRS framework and a client's assessments. Read-only and dependency-free, so
 * the client workspace can use it without a cycle through the command modules.
 *
 * The framework is reference data read as a whole; an assessment is read with the version
 * of the framework it was made against, never the one in force today.
 */

const iso = (value: Date | string) => value instanceof Date ? value.toISOString() : String(value);
const dateOnlyValue = (value: Date | string | null) => value == null ? null : iso(value).slice(0, 10);

/** The framework a given assessment was measured against, or the one in force. */
export async function getSrsFramework(db: Queryable, frameworkId?: string): Promise<SrsFramework | null> {
  const header = await db.query<{ framework_id: string; version: number; label: string; status: SrsFramework["status"]; effective_from: Date | string | null; notes: string | null }>(
    frameworkId
      ? `SELECT framework_id,version,label,status,effective_from,notes FROM nzi_console.srs_frameworks WHERE framework_id=$1`
      : `SELECT framework_id,version,label,status,effective_from,notes FROM nzi_console.srs_frameworks WHERE status='active' ORDER BY version DESC LIMIT 1`,
    frameworkId ? [frameworkId] : []);
  const row = header.rows[0];
  if (!row) return null;

  const [standards, pillars, levels, requirements] = await Promise.all([
    db.query<{ standard_key: string; label: string; description: string; climate_led: boolean; ordering: number }>(
      `SELECT standard_key,label,description,climate_led,ordering FROM nzi_console.srs_standards WHERE framework_id=$1 ORDER BY ordering`, [row.framework_id]),
    db.query<{ pillar_key: string; label: string; description: string; ordering: number }>(
      `SELECT pillar_key,label,description,ordering FROM nzi_console.srs_pillars WHERE framework_id=$1 ORDER BY ordering`, [row.framework_id]),
    db.query<{ level: number; key: string; label: string; definition: string }>(
      `SELECT level,key,label,definition FROM nzi_console.srs_maturity_levels WHERE framework_id=$1 ORDER BY level`, [row.framework_id]),
    db.query<{ requirement_id: string; standard_key: string; pillar_key: string; code: string; title: string; help_text: string; weight: string; source: "entered" | "nzi-data"; nzi_source_key: string | null; target_maturity: number; ordering: number; active: boolean }>(
      `SELECT requirement_id,standard_key,pillar_key,code,title,help_text,weight::text,source,nzi_source_key,target_maturity,ordering,active FROM nzi_console.srs_requirements WHERE framework_id=$1 ORDER BY standard_key,pillar_key,ordering`, [row.framework_id]),
  ]);

  return {
    frameworkId: row.framework_id, version: row.version, label: row.label, status: row.status,
    effectiveFrom: dateOnlyValue(row.effective_from), notes: row.notes,
    standards: standards.rows.map((standard) => ({ key: standard.standard_key, label: standard.label, description: standard.description, climateLed: standard.climate_led, ordering: standard.ordering })),
    pillars: pillars.rows.map((pillar) => ({ key: pillar.pillar_key, label: pillar.label, description: pillar.description, ordering: pillar.ordering })),
    maturityLevels: levels.rows.map((level) => ({ level: level.level as SrsMaturity, key: level.key, label: level.label, definition: level.definition })),
    requirements: requirements.rows.map((requirement) => ({
      id: requirement.requirement_id, standardKey: requirement.standard_key, pillarKey: requirement.pillar_key,
      code: requirement.code, title: requirement.title, helpText: requirement.help_text,
      weight: Number(requirement.weight), source: requirement.source, nziSourceKey: requirement.nzi_source_key,
      targetMaturity: requirement.target_maturity as SrsMaturity, ordering: requirement.ordering, active: requirement.active,
    })),
  };
}

type AssessmentRow = {
  assessment_id: string; client_id: string; framework_id: string; framework_version: number;
  status: "draft" | "complete"; assessed_on: Date | string; assessed_by: string; completed_at: Date | string | null;
  notes: string; version: number; sector_key: string | null; benchmark_percentile: string | null; benchmark_source: string | null;
};
const ASSESSMENT_COLUMNS = `assessment_id,client_id,framework_id,framework_version,status,assessed_on,assessed_by,completed_at,notes,version,sector_key,benchmark_percentile::text,benchmark_source`;

export async function listSrsAssessments(db: Queryable, clientId: string): Promise<SrsAssessment[]> {
  const { rows } = await db.query<AssessmentRow>(
    `SELECT ${ASSESSMENT_COLUMNS} FROM nzi_console.srs_assessments WHERE client_id=$1 ORDER BY assessed_on DESC, assessment_id DESC`, [clientId]);
  if (rows.length === 0) return [];
  const items = await db.query<{ assessment_id: string; requirement_id: string; maturity: number | null; source: "entered" | "auto"; evidence_kind: "document" | "data" | "note" | null; evidence_ref: string | null; evidence_note: string; owner: string; due_date: Date | string | null; linked_action_id: string | null; version: number }>(
    `SELECT assessment_id,requirement_id,maturity,source,evidence_kind,evidence_ref,evidence_note,owner,due_date,linked_action_id,version FROM nzi_console.srs_assessment_items WHERE assessment_id = ANY($1::text[])`,
    [rows.map((row) => row.assessment_id)]);
  const byAssessment = new Map<string, SrsAssessmentItem[]>();
  for (const item of items.rows) {
    byAssessment.set(item.assessment_id, [...(byAssessment.get(item.assessment_id) ?? []), {
      requirementId: item.requirement_id,
      maturity: item.maturity === null ? null : item.maturity as SrsMaturity,
      source: item.source,
      evidence: item.evidence_kind === null ? null : { kind: item.evidence_kind, ref: item.evidence_ref, note: item.evidence_note },
      owner: item.owner, dueDate: dateOnlyValue(item.due_date), linkedActionId: item.linked_action_id, version: item.version,
    }]);
  }
  return rows.map((row) => ({
    assessmentId: row.assessment_id, clientId: row.client_id, frameworkId: row.framework_id, frameworkVersion: row.framework_version,
    status: row.status, assessedOn: dateOnlyValue(row.assessed_on)!, assessedBy: row.assessed_by,
    completedAt: row.completed_at === null ? null : iso(row.completed_at), notes: row.notes, version: row.version,
    sectorKey: row.sector_key,
    benchmarkPercentile: row.benchmark_percentile === null ? null : Number(row.benchmark_percentile),
    benchmarkSource: row.benchmark_source,
    items: byAssessment.get(row.assessment_id) ?? [],
  }));
}

export async function getSrsAssessment(db: Queryable, assessmentId: string): Promise<SrsAssessment | null> {
  const { rows } = await db.query<AssessmentRow>(`SELECT ${ASSESSMENT_COLUMNS} FROM nzi_console.srs_assessments WHERE assessment_id=$1`, [assessmentId]);
  const row = rows[0];
  if (!row) return null;
  const all = await listSrsAssessments(db, row.client_id);
  return all.find((assessment) => assessment.assessmentId === assessmentId) ?? null;
}
