// ── NZC-022 · the permission matrix (docs/PERMISSION_MATRIX.md) ──
//
// The capability names below are the matrix's enumerated list, verbatim and
// exhaustive: a capability is added to PERMISSION_MATRIX.md first, then here —
// never invented in code. The backend's command layer checks these; the UI reads
// the same set to gate controls (convenience only — the server is authoritative).
//
// The role→capability mapping is migration-owned config (0066_permission_matrix.sql,
// `staff_role_capabilities`, versioned). `ROLE_CAPABILITY_MATRIX` is the code copy a
// test holds byte-for-byte equal to that migration, so the two cannot drift.

export const capabilities = [
  "client.view",
  "client.create",
  "client.edit",
  "client.deactivate",
  "contact.manage",
  "site.manage",
  "target.edit",
  "baseline.rebaseline",
  "job.manage",
  "scoperow.edit",
  "snapshot.review",
  "report.edit",
  "report.publish",
  "report.view",
  "strategy.manage",
  "srs.manage",
  "training.manage",
  "training.entitlement.manage",
  "finance.view",
  "finance.manage",
  "portal.admin",
  // ── Client-facing disclosure (NZC-110) ──
  // Its own capability rather than a stretch of portal.admin: deciding what a client sees of the
  // category list is a disclosure decision about that client's report, not administration of their
  // portal users. Holding one has never implied the other, and a consultant who may invite a portal
  // user is not thereby entitled to decide what the client is shown.
  "category.visibility",
  // ── Erasure / DSAR (NZC-116) ──
  // Deciding who two rows are is an identity judgement, and the questions span organisations
  // because a person is not confined to one. Admin alone, and the tenant-crossing read behind it
  // is a SECURITY DEFINER function returning pointers and counts — never a name.
  "subject.review",
  "clientfactor.manage",
  "dataset.manage",
  "factor.manage",
  "admin.users",
  "admin.lookups",
  "admin.templates",
  "admin.settings",
  "audit.view",
  "support.portal_impersonate",
  // ── Knowledge library (NZC-081) ──
  // Three, not two: writing to the library is its own act and must not ride an unrelated
  // gate. `capture` is held by every role — anyone who answers a question can offer it to
  // the library — while approval and publication are the two tiers that make an entry
  // citable and then client-facing.
  "knowledge.capture",
  "knowledge.approve",
  "knowledge.publish",
] as const;
export type Capability = (typeof capabilities)[number];

export const staffRoles = ["admin", "consultant", "reviewer", "finance", "viewer"] as const;
export type StaffRole = (typeof staffRoles)[number];

/** Least privilege: a new staff user starts read-only. */
export const DEFAULT_STAFF_ROLE: StaffRole = "viewer";

/** `own_clients` = only clients the user owns (`clients.owner_user_id`); `all` = any client in the organisation. */
export type CapabilityScope = "all" | "own_clients";
export type CapabilityGrant = { capability: Capability; scope: CapabilityScope };

/** The version of the matrix this code copy mirrors; bump with a new migration row set. */
export const PERMISSION_MATRIX_VERSION = 6;

const all = (...names: Capability[]) => Object.fromEntries(names.map((name) => [name, "all" as const]));

/**
 * ✓ and R are both "holds the capability" (R marks a read capability held read-only);
 * ⚑ own is `own_clients`. Anything absent is —.
 */
export const ROLE_CAPABILITY_MATRIX: Record<StaffRole, Partial<Record<Capability, CapabilityScope>>> = {
  admin: all(...capabilities),
  consultant: {
    ...all("client.view", "client.create", "client.edit", "contact.manage", "site.manage", "target.edit", "job.manage",
      "scoperow.edit", "report.edit", "report.view", "strategy.manage", "srs.manage", "training.manage", "training.entitlement.manage", "finance.view", "clientfactor.manage",
      "support.portal_impersonate",
      // Writes most of the knowledge and approves it to internal; publication to the
      // client-facing tier stays with Admin, which is what gives the two tiers teeth.
      "knowledge.capture", "knowledge.approve"),
    "baseline.rebaseline": "own_clients",
    "portal.admin": "own_clients",
    // Own clients only, like the other two decisions a consultant makes *about* a client rather
    // than within one.
    "category.visibility": "own_clients",
    "audit.view": "own_clients",
  },
  reviewer: all("client.view", "snapshot.review", "report.publish", "report.view", "audit.view", "knowledge.capture"),
  finance: { ...all("client.view", "report.view", "finance.view", "finance.manage", "knowledge.capture"), "audit.view": "own_clients" },
  viewer: all("client.view", "report.view", "knowledge.capture"),
};

export const roleLabels: Record<StaffRole, string> = {
  admin: "Admin", consultant: "Consultant", reviewer: "Reviewer", finance: "Finance", viewer: "Viewer",
};

export function isCapability(value: unknown): value is Capability {
  return typeof value === "string" && (capabilities as readonly string[]).includes(value);
}
export function isStaffRole(value: unknown): value is StaffRole {
  return typeof value === "string" && (staffRoles as readonly string[]).includes(value);
}

/** The code copy's grants for a role, in enum order. */
export function roleCapabilityGrants(role: StaffRole): CapabilityGrant[] {
  const row = ROLE_CAPABILITY_MATRIX[role];
  return capabilities.filter((name) => row[name]).map((name) => ({ capability: name, scope: row[name]! }));
}

export function grantFor(grants: readonly CapabilityGrant[], capability: Capability): CapabilityGrant | null {
  return grants.find((grant) => grant.capability === capability) ?? null;
}

/**
 * Whether the grants allow `capability` on a record. `clientOwnedByActor` is only
 * consulted for an `own_clients` grant; pass `undefined` for a check that is not
 * about one client (an `own_clients` grant then does not satisfy it).
 */
export function grantsAllow(grants: readonly CapabilityGrant[], capability: Capability, clientOwnedByActor?: boolean): boolean {
  const grant = grantFor(grants, capability);
  if (!grant) return false;
  return grant.scope === "all" || clientOwnedByActor === true;
}

/**
 * Who a command runs as, stamped from the resolved staff principal. The command
 * runner refuses a command whose grant is missing, belongs to another user or
 * tenant, or lacks the command's capability.
 */
export type CommandGrant = {
  organisationId: string;
  userId: string;
  role: StaffRole;
  matrixVersion: number;
  capabilities: readonly CapabilityGrant[];
};

/** A grant from the code copy of the matrix — for tests and fixtures; the live grant is read from the database. */
export function commandGrantForRole(role: StaffRole, organisationId: string, userId: string): CommandGrant {
  return { organisationId, userId, role, matrixVersion: PERMISSION_MATRIX_VERSION, capabilities: roleCapabilityGrants(role) };
}

/** Separation of duties: neither may be exercised by the user who prepared the snapshot. */
export const separationOfDutiesCapabilities = ["snapshot.review", "report.publish"] as const satisfies readonly Capability[];
