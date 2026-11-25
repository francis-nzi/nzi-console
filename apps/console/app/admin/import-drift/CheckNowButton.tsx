"use client";

import { useState } from "react";

/** "Check now": starts one paced run over every imported job (the route answers at once; the run carries on in the service). */
export function CheckNowButton({ enabled, reason }: { enabled: boolean; reason: string | null }) {
  const [state, setState] = useState<{ busy: boolean; line: string | null }>({ busy: false, line: null });
  async function start() {
    setState({ busy: true, line: null });
    try {
      const response = await fetch("/api/isolated/admin/import-drift", { method: "POST", headers: { "idempotency-key": crypto.randomUUID() } });
      const body = await response.json().catch(() => null) as { message?: string } | null;
      setState({ busy: false, line: response.ok ? "Checking every imported job against the previous system, one at a time. Reload the page to see the results as they land."
        : body?.message ?? "The check could not be started just now." });
    } catch { setState({ busy: false, line: "The check could not be started just now." }); }
  }
  return <div className="nz-a-head-actions">
    <button type="button" className="nz-btn pri" data-check-now disabled={!enabled || state.busy} title={reason ?? undefined} onClick={() => void start()}>Check now</button>
    {state.line ? <div className="nz-a-hint" role="status">{state.line}</div> : null}
  </div>;
}
