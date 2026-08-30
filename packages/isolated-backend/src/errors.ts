export class TenantContextError extends Error {
  constructor(message = "Tenant context is required.") { super(message); this.name = "TenantContextError"; }
}

export class VersionConflictError extends Error {
  constructor(expected?:number,actual?:number) { super(expected===undefined||actual===undefined?"Record version conflict.":`Record version conflict: expected v${expected}, found v${actual}.`); this.name = "VersionConflictError"; }
}
