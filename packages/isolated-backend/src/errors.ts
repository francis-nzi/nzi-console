export class TenantContextError extends Error {
  constructor(message = "Tenant context is required.") { super(message); this.name = "TenantContextError"; }
}

export class VersionConflictError extends Error {
  constructor(expected?:number,actual?:number) { super(expected===undefined||actual===undefined?"Record version conflict.":`Record version conflict: expected v${expected}, found v${actual}.`); this.name = "VersionConflictError"; }
}

/**
 * Reporting S-1 (0163): a report version collided with another at the same scope — validated twice off one snapshot, or two
 * publishes of one scope racing. A conflict (it is a VersionConflictError, so every route answers 409), never a raw error.
 */
export class ScopeConflictError extends VersionConflictError {
  constructor(message: string) { super(); this.message = message; this.name = "ScopeConflictError"; }
}

/** Postgres's unique-violation code, for the indexes 0163 keys on scope. */
export const isUniqueViolation = (error: unknown): boolean => Boolean(error && typeof error === "object" && (error as { code?: string }).code === "23505");
