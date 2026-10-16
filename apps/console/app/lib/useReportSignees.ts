"use client";

import { useEffect, useState } from "react";
import type { ClientContactReadModel } from "@nzi/contracts";

/**
 * The client's report-signee contacts for a job — the people `report.validate` may freeze onto a version as its signee. A read
 * only (the same `GET jobs/{id}/report-signees` the job page's release panel reads): `undefined` while it is read, `null` if it
 * could not be (the caller then offers no signee rather than guessing), else the list (possibly empty).
 */
export function useReportSignees(jobId: string, enabled = true): ClientContactReadModel[] | null | undefined {
  const [signees, setSignees] = useState<ClientContactReadModel[] | null | undefined>(undefined);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetch(`/api/isolated/jobs/${encodeURIComponent(jobId)}/report-signees`, { cache: "no-store" })
      .then(async (response) => { if (!response.ok) throw new Error(); const body = await response.json() as { signees?: ClientContactReadModel[] }; if (!cancelled) setSignees(Array.isArray(body.signees) ? body.signees : []); })
      .catch(() => { if (!cancelled) setSignees(null); });
    return () => { cancelled = true; };
  }, [jobId, enabled]);
  return signees;
}
