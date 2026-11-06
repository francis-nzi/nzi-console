import type { ApprovalPolicy } from "@nzi/isolated-backend";

/** What the card says about the current policy — one sentence per state, so a relaxed policy is never read as the default. */
export function approvalPolicyStatement(policy: Pick<ApprovalPolicy, "required" | "source">): string {
  if (policy.required) return policy.source === "organisation"
    ? "Independent approval is required: whoever prepares a report's snapshot cannot approve or publish it."
    : "Independent approval is required (the default): whoever prepares a report's snapshot cannot approve or publish it.";
  return policy.source === "organisation"
    ? "Independent approval is off: a preparer who can release reports may approve, validate and publish their own work. It is recorded each time."
    : "Independent approval is off through the server setting: a preparer who can release reports may approve and publish their own work. Setting the policy here overrides it.";
}
