export class TenantContextError extends Error {
  constructor(message = "Tenant context is required.") { super(message); this.name = "TenantContextError"; }
}

export class VersionConflictError extends Error {
  constructor() { super("Record version conflict."); this.name = "VersionConflictError"; }
}
