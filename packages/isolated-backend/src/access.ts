// NZC-022 — the authoritative permission check, run by the command runner inside the
// command's own transaction (so it sees the same rows the handler will change).
//
// Every command names one PERMISSION_MATRIX.md capability. The runner refuses it
// unless (1) a grant from the resolved staff principal accompanies the command, for
// this actor and this tenant; (2) the grant holds the capability; (3) the record the
// command touches is in the caller's organisation (assert_client_access /
// assert_job_access); and (4) an `own_clients` grant is exercised only on a client
// the caller owns. UI gating reads the same capabilities but is never relied on.
import { commandDefinitions, grantFor, grantsAllow, type Capability, type CapabilityGrant, type CapabilityScope, type CommandContext, type CommandInputMap, type CommandKey } from "@nzi/contracts";
import { AuthorizationError } from "./auth";
import type { Queryable } from "./postgres";

/** The client a command's record belongs to, resolved inside the caller's tenant. */
export type ClientAccess = { clientId: string; ownerUserId: string | null; ownedByActor: boolean };

type Subject =
  | { kind: "organisation" }
  | { kind: "client" | "job" | "site" | "clientFactor" | "contact" | "snapshot" | "reportVersion" | "srsAssessment"; id: string };

const organisation = (): Subject => ({ kind: "organisation" });
const client = (input: { clientId: string }): Subject => ({ kind: "client", id: input.clientId });
const job = (input: { jobId: string }): Subject => ({ kind: "job", id: input.jobId });
const site = (input: { siteId: string }): Subject => ({ kind: "site", id: input.siteId });
const srsAssessment = (input: { assessmentId: string }): Subject => ({ kind: "srsAssessment", id: input.assessmentId });

/** Which record each command touches — exhaustive over CommandKey, so a new command must declare its subject. */
const subjectOf: { [K in CommandKey]: (input: CommandInputMap[K]) => Subject } = {
  "client.create": organisation,
  "client.update": client,
  "job.create": client,
  "job.stage.change": job,
  "scope.row.create": job,
  "scope.row.update": job,
  "scope.row.calculate": job,
  "scope.review.approve": job,
  "scope.review.reject": job,
  "report.publish": (input) => ({ kind: "reportVersion", id: input.reportVersionId }),
  "report.validate": (input) => ({ kind: "snapshot", id: input.reviewedSnapshotId }),
  "report.snapshot.create": job,
  "report.snapshot.approve": (input) => ({ kind: "snapshot", id: input.reviewedSnapshotId }),
  "client.contact.create": client,
  "client.contact.update": (input) => ({ kind: "contact", id: input.contactId }),
  "client.contact.deactivate": (input) => ({ kind: "contact", id: input.contactId }),
  "client.targets.set": client,
  "client.intensityMetric.set": client,
  "client.intensityMetric.deactivate": client,
  "job.intensityValue.set": job,
  "srs.assessment.start": client,
  "srs.assessment.item.set": srsAssessment,
  "srs.assessment.complete": srsAssessment,
  "client.logo.set": client,
  "client.logo.remove": client,
  "report.section.edit": job,
  "report.section.reset": job,
  "report.section.regenerate": job,
  "assurance.gap.resolve": job,
  "emissions.target.upsert": job,
  "site.create": (input) => input.jobId ? { kind: "job", id: input.jobId } : { kind: "client", id: input.clientId ?? "" },
  "site.edit": site,
  "site.registeredOffice": site,
  "site.vacate": site,
  "site.reinstate": site,
  "site.floorArea.record": site,
  "emissions.intensity.upsert": job,
  "purchased.goods.category.create": job,
  "client.factor.create": job,
  "client.factor.update": (input) => ({ kind: "clientFactor", id: input.clientFactorId }),
  "client.factor.archive": (input) => ({ kind: "clientFactor", id: input.clientFactorId }),
  "emission.source.group.create": job,
  "emission.source.group.sync": job,
  "emission.source.create": job,
  "emission.source.sync": job,
  "emission.source.activity.update": job,
  "emission.source.status.update": job,
  "emission.source.rollforward": job,
  "scope.row.rollforward": job,
  "emission.source.import.commit": job,
  "emission.source.import.void": job,
  "client.import.mapping.save": client,
  "dataset.override.add": job,
  "portal.access.grant": client,
  "sales.opportunity.convert": organisation,
  "lca.assessment.create": job,
  "lca.assessment.update": job,
  "lca.lineItem.create": job,
  "lca.lineItem.update": job,
  "lca.lineItem.delete": job,
  "lca.lineItem.bulkCreate": job,
  "lca.transportLeg.create": job,
  "lca.transportLeg.update": job,
  "lca.transportLeg.delete": job,
  "lca.lineItem.gapFill": job,
  "lca.assessment.calculate": job,
  "lca.assessment.review.approve": job,
  "lca.assessment.review.reject": job,
  "lca.assessment.snapshot.create": job,
  "lca.scenario.create": job,
  "lca.scenario.update": job,
  "lca.scenario.delete": job,
  "lca.scenario.multiplier.set": job,
  "lca.scenario.multiplier.delete": job,
};

// Each resolves the owning client strictly inside the caller's organisation. Under RLS
// another tenant's row is invisible as well — the explicit predicate makes the check
// independent of it. The `nzi:access` marker names the statement in logs and tests.
const accessSql: Record<Exclude<Subject["kind"], "organisation">, string> = {
  client: `SELECT /* nzi:access */ c.client_id, c.owner_user_id FROM nzi_console.clients c WHERE c.organisation_id=$1 AND c.client_id=$2`,
  job: `SELECT /* nzi:access */ c.client_id, c.owner_user_id FROM nzi_console.jobs j JOIN nzi_console.clients c ON (c.organisation_id,c.client_id)=(j.organisation_id,j.client_id) WHERE j.organisation_id=$1 AND j.job_id=$2`,
  site: `SELECT /* nzi:access */ c.client_id, c.owner_user_id FROM nzi_console.client_sites s JOIN nzi_console.clients c ON (c.organisation_id,c.client_id)=(s.organisation_id,s.client_id) WHERE s.organisation_id=$1 AND s.site_id=$2`,
  clientFactor: `SELECT /* nzi:access */ c.client_id, c.owner_user_id FROM nzi_console.client_factors f JOIN nzi_console.clients c ON (c.organisation_id,c.client_id)=(f.organisation_id,f.client_id) WHERE f.organisation_id=$1 AND f.client_factor_id=$2`,
  contact: `SELECT /* nzi:access */ c.client_id, c.owner_user_id FROM nzi_console.client_contacts k JOIN nzi_console.clients c ON (c.organisation_id,c.client_id)=(k.organisation_id,k.client_id) WHERE k.organisation_id=$1 AND k.contact_id=$2`,
  snapshot: `SELECT /* nzi:access */ c.client_id, c.owner_user_id FROM nzi_console.reviewed_crp_snapshots s JOIN nzi_console.jobs j ON (j.organisation_id,j.job_id)=(s.organisation_id,s.job_id) JOIN nzi_console.clients c ON (c.organisation_id,c.client_id)=(j.organisation_id,j.client_id) WHERE s.organisation_id=$1 AND s.snapshot_id=$2`,
  srsAssessment: `SELECT /* nzi:access */ c.client_id, c.owner_user_id FROM nzi_console.srs_assessments a JOIN nzi_console.clients c ON (c.organisation_id,c.client_id)=(a.organisation_id,a.client_id) WHERE a.organisation_id=$1 AND a.assessment_id=$2`,
  reportVersion: `SELECT /* nzi:access */ c.client_id, c.owner_user_id FROM nzi_console.report_versions r JOIN nzi_console.jobs j ON (j.organisation_id,j.job_id)=(r.organisation_id,r.job_id) JOIN nzi_console.clients c ON (c.organisation_id,c.client_id)=(j.organisation_id,j.client_id) WHERE r.organisation_id=$1 AND r.report_version_id=$2`,
};

const TENANT_REFUSED = "The record is not in your organisation.";

async function resolveAccess(db: Queryable, organisationId: string, actorId: string, kind: keyof typeof accessSql, id: string): Promise<ClientAccess> {
  if (!id.trim()) throw new AuthorizationError("tenant", TENANT_REFUSED);
  const found = await db.query<{ client_id: string; owner_user_id: string | null }>(accessSql[kind], [organisationId, id]);
  const row = found.rows[0];
  if (!row) throw new AuthorizationError("tenant", TENANT_REFUSED);
  return { clientId: row.client_id, ownerUserId: row.owner_user_id ?? null, ownedByActor: (row.owner_user_id ?? null) === actorId };
}

/** assert_client_access — the client exists in this organisation; says whether the actor owns it. */
export function assertClientAccess(db: Queryable, organisationId: string, actorId: string, clientId: string): Promise<ClientAccess> {
  return resolveAccess(db, organisationId, actorId, "client", clientId);
}

/** assert_job_access — the job exists in this organisation; resolves its client. */
export function assertJobAccess(db: Queryable, organisationId: string, actorId: string, jobId: string): Promise<ClientAccess> {
  return resolveAccess(db, organisationId, actorId, "job", jobId);
}

/**
 * The runner's check. Returns the client the command concerns (null for an
 * organisation-level command such as client.create), which the handler may use for
 * further conditional checks (baseline.rebaseline, separation of duties).
 */
export async function authorizeCommandInTransaction<K extends CommandKey>(db: Queryable, key: K, input: CommandInputMap[K], context: CommandContext): Promise<ClientAccess | null> {
  const capability = commandDefinitions[key].permission;
  const grant = context.grant;
  if (!grant) throw new AuthorizationError(capability, "No staff grant accompanies this command.");
  if (grant.organisationId !== context.organisationId || grant.userId !== context.actorId) throw new AuthorizationError("tenant", "The command's grant belongs to a different user or organisation.");
  const held = grantFor(grant.capabilities, capability);
  if (!held) throw new AuthorizationError(capability);
  const subject = subjectOf[key](input);
  if (subject.kind === "organisation") {
    if (held.scope !== "all") throw new AuthorizationError(capability, "This capability is limited to your own clients.");
    return null;
  }
  const access = await resolveAccess(db, context.organisationId, context.actorId, subject.kind, subject.id);
  if (held.scope === "own_clients" && !access.ownedByActor) throw new AuthorizationError(capability, "This capability is limited to your own clients.");
  return access;
}

/** A staff principal's identity and grants — what a non-command check needs. */
export type CapabilityHolder = { organisationId: string; userId: string; capabilities: readonly CapabilityGrant[] };

/** The scope the holder has the capability at, or null when they do not hold it. */
export function capabilityScope(holder: Pick<CapabilityHolder, "capabilities">, capability: Capability): CapabilityScope | null {
  return grantFor(holder.capabilities, capability)?.scope ?? null;
}

/** For list reads under an `own_clients` grant: the owner to filter by (null = no filter). Throws when the capability is not held. */
export function ownerFilterFor(holder: CapabilityHolder, capability: Capability): string | null {
  const scope = capabilityScope(holder, capability);
  if (!scope) throw new AuthorizationError(capability);
  return scope === "own_clients" ? holder.userId : null;
}

const portalUserAccessSql = `SELECT /* nzi:access */ c.client_id, c.owner_user_id FROM nzi_console.portal_users u JOIN nzi_console.clients c ON (c.organisation_id,c.client_id)=(u.organisation_id,u.client_id) WHERE u.organisation_id=$1 AND u.portal_user_id=$2`;

/**
 * The same capability + tenant + own-client rule for the paths that are not (yet)
 * registered commands — portal administration and data-entry review.
 */
export async function assertCapabilityOnClient(db: Queryable, holder: CapabilityHolder, capability: Capability, ref: { clientId: string } | { jobId: string } | { portalUserId: string }): Promise<ClientAccess> {
  const scope = capabilityScope(holder, capability);
  if (!scope) throw new AuthorizationError(capability);
  let access: ClientAccess;
  if ("portalUserId" in ref) {
    if (!ref.portalUserId.trim()) throw new AuthorizationError("tenant", TENANT_REFUSED);
    const row = (await db.query<{ client_id: string; owner_user_id: string | null }>(portalUserAccessSql, [holder.organisationId, ref.portalUserId])).rows[0];
    if (!row) throw new AuthorizationError("tenant", TENANT_REFUSED);
    access = { clientId: row.client_id, ownerUserId: row.owner_user_id ?? null, ownedByActor: (row.owner_user_id ?? null) === holder.userId };
  } else if ("jobId" in ref) access = await assertJobAccess(db, holder.organisationId, holder.userId, ref.jobId);
  else access = await assertClientAccess(db, holder.organisationId, holder.userId, ref.clientId);
  if (scope === "own_clients" && !access.ownedByActor) throw new AuthorizationError(capability, "This capability is limited to your own clients.");
  return access;
}

/** A conditional capability checked by a handler once it knows it is needed (e.g. a baseline change inside client.update). */
export function requireConditionalCapability(context: CommandContext, capability: Capability, access: ClientAccess | null): void {
  if (!grantsAllow(context.grant?.capabilities ?? [], capability, access?.ownedByActor)) {
    throw new AuthorizationError(capability, grantFor(context.grant?.capabilities ?? [], capability) ? "This capability is limited to your own clients." : "Permission denied.");
  }
}

/** Separation of duties (PERMISSION_MATRIX.md ⚑): the snapshot's preparer may not review or publish it. */
export class SeparationOfDutiesError extends AuthorizationError {
  constructor(capability: Capability, message: string) { super(capability, message); this.name = "SeparationOfDutiesError"; }
}
