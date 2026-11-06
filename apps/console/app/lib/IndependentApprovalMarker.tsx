"use client";

import { useEffect, useState } from "react";

/** The organisation's approval policy as the report studio shows it (0213). Null = not known; the marker then says nothing false. */
export type ApprovalPolicyView = { required: boolean; source: "organisation" | "server" | "unreadable" };

export const INDEPENDENT_APPROVAL_OFF_TEXT = "Independent approval is off for this organisation: a preparer who can release reports may approve and publish their own work. Each such release is recorded as a self-approval.";

/** Reads GET /api/isolated/organisation/approval-policy once. Any failure is null — never mistaken for "off". */
export function useApprovalPolicy(enabled = true): ApprovalPolicyView | null | undefined {
  const [policy, setPolicy] = useState<ApprovalPolicyView | null | undefined>(undefined);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    fetch("/api/isolated/organisation/approval-policy", { cache: "no-store", credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) return null;
        const body = await response.json() as Partial<ApprovalPolicyView>;
        return typeof body.required === "boolean" ? { required: body.required, source: body.source ?? "server" } as ApprovalPolicyView : null;
      })
      .catch(() => null)
      .then((value) => { if (live) setPolicy(value); });
    return () => { live = false; };
  }, [enabled]);
  return policy;
}

/** Drawn only when independent approval is off — so it is never silently disabled. Nothing is drawn when it is on or unknown. */
export function IndependentApprovalMarker({ policy }: { policy: ApprovalPolicyView | null | undefined }) {
  if (!policy || policy.required) return null;
  return <div className="nz-hint" role="note" data-independent-approval-off style={{ margin: "8px 16px 0" }}>{INDEPENDENT_APPROVAL_OFF_TEXT}</div>;
}
