import type { CommandContext, CommandKey, CommandOutcome } from "@nzi/contracts";
import { TenantContextError, VersionConflictError } from "./errors";
export * from "./databaseBoundary";
export * from "./errors";
export * from "./auth";
export * from "./credentials";
export * from "./login";
export * from "./postgres";
export * from "./postgresCommands";
export * from "./readModels";
export * from "./spendImportIdentity";
export * from "./spendImport";
export * from "./scopeRowHistory";
export * from "./lcaAssessments";
export * from "./lcaLineItems";
export * from "./lcaTransportLegs";
export * from "./lcaUnits";
export * from "./lcaGeocoding";
export * from "./lcaCalcEngine";
export * from "./lcaAssessmentReview";
export * from "./lcaResultSnapshots";
export * from "./portalReview";
export * from "./portalAccess";
export * from "./portalInvitations";
export * from "./portalDataEntry";
export * from "./portalDataEntryRecords";
export * from "./portalDeliverables";
export * from "./vehicleLookup";

export type TenantRecord = { id: string; organisationId: string; version: number };
export type AuditRecord = { id: string; organisationId: string; actorId: string; action: string; entityId: string; correlationId: string; at: string };
export type OutboxRecord = { id: string; organisationId: string; topic: string; payload: Record<string, unknown>; correlationId: string; state: "pending" | "sent" };
type StoreState = { records: Map<string, TenantRecord>; audits: AuditRecord[]; outbox: OutboxRecord[]; idempotency: Map<string, CommandOutcome> };

const tenantKey = (organisationId: string, id: string) => `${organisationId}:${id}`;
const cloneState = (state: StoreState): StoreState => structuredClone(state);

export class IsolatedStore {
  private state: StoreState = { records: new Map(), audits: [], outbox: [], idempotency: new Map() };
  async transaction<T>(work: (unit: IsolatedUnitOfWork) => Promise<T>): Promise<T> {
    const draft = cloneState(this.state);
    const result = await work(new IsolatedUnitOfWork(draft));
    this.state = draft;
    return result;
  }
  snapshot() { return cloneState(this.state); }
}

export class IsolatedUnitOfWork {
  constructor(private readonly state: StoreState) {}
  repository<T extends TenantRecord>(organisationId: string) { if (!organisationId.trim()) throw new TenantContextError(); return new TenantRepository<T>(this.state.records, organisationId); }
  audit(record: AuditRecord) { if (!record.organisationId) throw new TenantContextError(); this.state.audits.push(record); }
  enqueue(record: OutboxRecord) { if (!record.organisationId) throw new TenantContextError(); this.state.outbox.push(record); }
  replay(organisationId: string, idempotencyKey: string) { return this.state.idempotency.get(tenantKey(organisationId, idempotencyKey)); }
  remember(organisationId: string, idempotencyKey: string, outcome: CommandOutcome) { this.state.idempotency.set(tenantKey(organisationId, idempotencyKey), outcome); }
}

export class TenantRepository<T extends TenantRecord> {
  constructor(private readonly records: Map<string, TenantRecord>, private readonly organisationId: string) {}
  list(): T[] { return [...this.records.values()].filter((record) => record.organisationId === this.organisationId) as T[]; }
  get(id: string): T | undefined { return this.records.get(tenantKey(this.organisationId, id)) as T | undefined; }
  insert(record: T): T { if (record.organisationId !== this.organisationId) throw new TenantContextError("Cross-tenant insert denied."); this.records.set(tenantKey(this.organisationId, record.id), structuredClone(record)); return record; }
  update(id: string, expectedVersion: number, change: (current: T) => T): T {
    const current = this.get(id); if (!current) throw new Error("Record not found."); if (current.version !== expectedVersion) throw new VersionConflictError();
    const next = change(structuredClone(current)); if (next.organisationId !== this.organisationId) throw new TenantContextError("Cross-tenant update denied."); next.version = current.version + 1; this.records.set(tenantKey(this.organisationId, id), structuredClone(next)); return next;
  }
}

export type IsolatedCommandHandler<T extends Record<string, unknown>> = (unit: IsolatedUnitOfWork) => Promise<{ data: T; entityId: string; outbox?: { topic: string; payload: Record<string, unknown> } }>;
export async function runIsolatedCommand<T extends Record<string, unknown>>(store: IsolatedStore, key: CommandKey, context: CommandContext, handler: IsolatedCommandHandler<T>): Promise<CommandOutcome<T>> {
  if (!context.organisationId.trim()) return { state: "denied", permission: "tenant.context", message: "Tenant context is required.", correlationId: context.correlationId };
  try {
    return await store.transaction(async (unit) => {
      const replay = unit.replay(context.organisationId, context.idempotencyKey) as CommandOutcome<T> | undefined;
      if (replay?.state === "success") return { ...replay, replayed: true };
      const result = await handler(unit);
      const auditEventId = `audit-${context.correlationId}`;
      unit.audit({ id: auditEventId, organisationId: context.organisationId, actorId: context.actorId, action: key, entityId: result.entityId, correlationId: context.correlationId, at: new Date().toISOString() });
      if (result.outbox) unit.enqueue({ id: `outbox-${context.correlationId}`, organisationId: context.organisationId, topic: result.outbox.topic, payload: result.outbox.payload, correlationId: context.correlationId, state: "pending" });
      const outcome: CommandOutcome<T> = { state: "success", data: result.data, auditEventId, correlationId: context.correlationId, replayed: false };
      unit.remember(context.organisationId, context.idempotencyKey, outcome);
      return outcome;
    });
  } catch (error) {
    if (error instanceof VersionConflictError) return { state: "conflict", code: "VERSION_CONFLICT", message: error.message, correlationId: context.correlationId };
    return { state: "failed", code: "TRANSACTION_FAILED", message: error instanceof Error ? error.message : "Transaction failed.", retryable: false, correlationId: context.correlationId };
  }
}
