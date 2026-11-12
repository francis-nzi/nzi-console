"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { postBrowserCommand, type BrowserCommandResult } from "@nzi/api-client";
import { V7_IMPORT_CARRY_LABEL, V7_IMPORT_SOURCE_SYSTEM } from "@nzi/contracts";
import { errorText } from "./ImportResolution";

/**
 * One linked pair group's carry (RULING-v7-import-pair-carry): the one ruled option, A — carry both, unlinked: the members become
 * independent rows, each resolved under its own status. The other way out is to hold — fix it in the previous system and
 * re-extract — which records nothing. One click writes the carry for every member; a clear takes it off every member.
 */
export function ImportPairCarry({ jobId, firstMember, carried, carryDecisionId }: {
  jobId: string; firstMember: string; carried: boolean; carryDecisionId: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef<string | null>(null);
  const identity = { jobId, sourceSystem: V7_IMPORT_SOURCE_SYSTEM, legacyDbId: firstMember };
  async function run(action: () => Promise<BrowserCommandResult<unknown>>) {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const result = await action();
      if (result.state === "validation_failed" || result.state === "conflict") key.current = null;
      if (result.state !== "success") { setError(errorText(result)); return; }
      key.current = null; router.refresh();
    } finally { setBusy(false); }
  }
  return <div data-carry={carried ? "carried" : "awaiting"}>
    {carried ? <>
      <span className="nz-a-badge ok">{V7_IMPORT_CARRY_LABEL.A}</span> {carryDecisionId ? <button type="button" className="nz-a-btn" disabled={busy}
        onClick={() => void run(() => postBrowserCommand("/api/isolated/import/decisions/clear", { ...identity, expectedDecisionId: carryDecisionId }, key.current ??= crypto.randomUUID()))}>Clear</button> : null}
    </> : <>
      <button type="button" className="nz-a-btn pri" disabled={busy}
        onClick={() => void run(() => postBrowserCommand("/api/isolated/import/decisions", { ...identity, kind: "carry", carryOption: "A", expectedDecisionId: carryDecisionId }, key.current ??= crypto.randomUUID()))}>{V7_IMPORT_CARRY_LABEL.A}</button>
      <div className="nz-a-hint">Or hold: leave the job blocked, fix the pair in the previous system and re-extract.</div>
    </>}
    {error ? <div className="nz-a-error" role="alert">{error}</div> : null}
  </div>;
}
