// NZC-022, relaxed for now and reversibly (RULING-NZC022-relax-self-approval, 17 Oct 2026), and since 0215 switchable in the app.
//
// Whether independent approval is required is decided, in order, by:
//   1. the organisation's own policy (`organisation_approval_policy`, set by an Admin with `organisation.approvalPolicy.set`,
//      audited) — when it has one, it wins in either direction;
//   2. otherwise the server variable REPORT_REQUIRE_INDEPENDENT_APPROVAL (never NEXT_PUBLIC_*), the backstop: unset, it is
//      true, and only the word "false" relaxes it.
// Required means a snapshot's preparer may not approve, validate or publish it, and a row's preparer may not approve the
// row — NZC-022 as it has always stood. Relaxed means only a holder of SELF_APPROVAL_CAPABILITY may, and it is recorded.
//
// Fail-safe: a command that cannot read the policy fails (it never assumes "relaxed"), and the display read answers
// "required" when it cannot read.
import { maySelfApprove, type CommandContext } from "@nzi/contracts";
import type { ClientAccess } from "./access";
import type { Queryable } from "./postgres";

/** The server variable alone — the backstop when an organisation has set no policy. */
export function independentApprovalRequired(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.REPORT_REQUIRE_INDEPENDENT_APPROVAL?.trim().toLowerCase() !== "false";
}

export type ApprovalPolicy = {
  /** Whether independent approval is required right now: the organisation's policy, else the server variable. */
  required: boolean;
  /** Where that answer came from. `unreadable` is only ever returned with `required: true`. */
  source: "organisation" | "server" | "unreadable";
  /** The policy row's version (0 = none set); what `organisation.approvalPolicy.set` is pinned to. */
  version: number;
  updatedBy: string | null;
  updatedAt: string | null;
};

/** The effective policy, inside the caller's tenant transaction. Throws if it cannot be read — a command then fails closed. */
export async function readApprovalPolicy(db: Queryable, organisationId: string, env: Readonly<Record<string, string | undefined>> = process.env): Promise<ApprovalPolicy> {
  const { rows: [row] } = await db.query<{ require_independent_approval: boolean; version: number; updated_by: string; updated_at: Date | string }>(
    `SELECT require_independent_approval, version, updated_by, updated_at FROM nzi_console.organisation_approval_policy WHERE organisation_id = $1`, [organisationId]);
  if (!row) return { required: independentApprovalRequired(env), source: "server", version: 0, updatedBy: null, updatedAt: null };
  return { required: row.require_independent_approval, source: "organisation", version: row.version, updatedBy: row.updated_by,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at) };
}

/** The commands' question: is independent approval required for this organisation? */
export async function organisationRequiresIndependentApproval(db: Queryable, organisationId: string, env: Readonly<Record<string, string | undefined>> = process.env): Promise<boolean> {
  return (await readApprovalPolicy(db, organisationId, env)).required;
}

/** The display's question: never throws, and answers "required" (source `unreadable`) when the policy cannot be read. */
export async function readApprovalPolicySafely(db: Queryable, organisationId: string, env: Readonly<Record<string, string | undefined>> = process.env): Promise<ApprovalPolicy> {
  try { return await readApprovalPolicy(db, organisationId, env); }
  catch { return { required: true, source: "unreadable", version: 0, updatedBy: null, updatedAt: null }; }
}

/** Whether this actor may go on to act on what they prepared — read at the moment of the act, against the policy just read. */
export function preparerMayProceed(context: CommandContext, access: ClientAccess | null, required: boolean): boolean {
  return maySelfApprove(context.grant?.capabilities ?? [], required, access?.ownedByActor);
}
