import {
  composeSrsRoadmap, isAssessed, readinessNarrative, readinessReportTemplates, srsDashboard, strategyIsReportable, todayInLondon,
  type ReadinessReportTemplate, type ReportSrsRoadmap, type SrsDashboardModel,
} from "@nzi/contracts";
import { assertCapabilityOnClient, type CapabilityHolder } from "./access";
import { readOrganisationBrand } from "./organisationSettings";
import type { Queryable } from "./postgres";
import { listClientStrategies } from "./reductionStrategies";
import { srsFrameworksFor } from "./srsBridging";
import { getSrsFramework, listSrsAssessments } from "./srsReadinessRecords";

/**
 * SRS S3, R5 — the readiness report's read model: one completed assessment, drawn through a report **template**.
 *
 * Client-facing by construction. It is built from a **completed** assessment only (never working-out); each assessment is
 * read against the framework version it was made against; and every staff working field — owner, due date, the action
 * link, the evidence note — is taken out field by field before the model leaves, as the portal's is (NZC-110). The
 * report names the firm that prepared it, never an individual; it carries no money (NZC-120) and no figure that is not
 * the assessment's own: the narrative is written from the model, and the benchmark stays a truthful "Future".
 */

export type SrsReportReadModel =
  | { state: "none"; reason: string }
  | {
    state: "ready";
    template: ReadinessReportTemplate;
    client: { id: string; name: string };
    /** The firm, as its brand names it — never the consultant who did the work. */
    preparedBy: string;
    assessment: { id: string; assessedOn: string; frameworkLabel: string; frameworkVersion: number };
    dashboard: SrsDashboardModel;
    narrative: string[];
    roadmap: ReportSrsRoadmap;
    /** The day the document was drawn — so a printed copy says when it was true. */
    generatedOn: string;
  };

export async function getSrsReport(db: Queryable, holder: CapabilityHolder, input: { clientId: string; assessmentId?: string | null; templateKey: string }): Promise<SrsReportReadModel> {
  await assertCapabilityOnClient(db, holder, "srs.manage", { clientId: input.clientId });
  const template = readinessReportTemplates[input.templateKey];
  if (!template) return { state: "none", reason: "That report template does not exist." };
  const [framework, assessments, plan, client, brand] = await Promise.all([
    getSrsFramework(db),
    listSrsAssessments(db, input.clientId),
    listClientStrategies(db, input.clientId),
    db.query<{ name: string }>(`SELECT name FROM nzi_console.clients WHERE client_id = $1`, [input.clientId]).then((result) => result.rows[0]),
    readOrganisationBrand(db, holder.organisationId),
  ]);
  if (!client) return { state: "none", reason: "There is no such client." };
  if (!framework) return { state: "none", reason: "No readiness framework is published, so there is nothing to report against." };
  const completed = assessments.filter(isAssessed).sort((a, b) => b.assessedOn.localeCompare(a.assessedOn) || b.assessmentId.localeCompare(a.assessmentId));
  const assessment = input.assessmentId ? completed.find((entry) => entry.assessmentId === input.assessmentId) : completed[0];
  if (!assessment) {
    return { state: "none", reason: input.assessmentId
      ? "A report is made from a completed assessment, and that one is not complete."
      : "This client has no completed readiness assessment yet. A report is made from a completed one." };
  }
  const frameworks = await srsFrameworksFor(db, assessments);
  const own = frameworks.get(assessment.frameworkId) ?? framework;
  const model = srsDashboard(framework, assessment, assessments, { frameworks });
  // Field by field, as the portal's: no owner, due date, action link or evidence note crosses into a client document.
  const dashboard: SrsDashboardModel = {
    ...model,
    requirements: model.requirements.map(({ owner: _owner, dueDate: _due, linkedActionId: _link, ...requirement }) => ({
      ...requirement,
      evidence: requirement.evidence === null ? null : { kind: requirement.evidence.kind, ref: requirement.evidence.ref, note: "" },
    })),
  };
  return {
    state: "ready",
    template,
    client: { id: input.clientId, name: client.name },
    preparedBy: brand.displayName,
    assessment: { id: assessment.assessmentId, assessedOn: assessment.assessedOn, frameworkLabel: own.label, frameworkVersion: assessment.frameworkVersion },
    dashboard,
    narrative: readinessNarrative(dashboard, client.name),
    // The same builder, population and ordering the issued report and the portal use (A1: marked and agreed or beyond).
    roadmap: composeSrsRoadmap(own, assessment.items, plan.filter(strategyIsReportable)),
    generatedOn: todayInLondon(),
  };
}
