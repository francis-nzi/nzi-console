"use client";
// Data entry D2 (R5): an AI suggestion of the category for a spend line the client's map does not know — labelled "AI suggestion",
// never applied by itself. In the import preview a person confirms it into the map (or dismisses it); in a review move they use it
// to choose where the line goes, and the move confirms it. Only a person's decision writes the map.
import { useRef, useState } from "react";
import { postBrowserCommand } from "@nzi/api-client";
import { spendCategoryOf } from "@nzi/contracts";

export type SpendSuggestionShown = { suggestionId: string; categoryCode: string; reason: string; version: number; model: string };

type State =
  | { kind: "idle" } | { kind: "asking" } | { kind: "off"; message: string } | { kind: "none"; message: string }
  | { kind: "shown"; suggestion: SpendSuggestionShown } | { kind: "decided"; message: string };

export function SpendSuggestionCard({ jobId, line, mode, onUse, onConfirmed }: {
  jobId: string; line: { glCode: string | null; description: string | null };
  /** `confirm`: confirm into the map here (the import preview). `use`: hand the suggestion to the caller (a review move). */
  mode: "confirm" | "use";
  onUse?: (suggestion: SpendSuggestionShown) => void;
  onConfirmed?: () => void;
}) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const key = useRef<string | null>(null);

  async function ask() {
    setState({ kind: "asking" });
    const result = await postBrowserCommand<SpendSuggestionShown & { suggestion?: null; dropped?: string }>(`/api/isolated/jobs/${jobId}/spend-suggestions`, line, crypto.randomUUID());
    if (result.state !== "success") {
      setState(result.state === "validation_failed" ? { kind: "none", message: result.issues.map((issue) => issue.message).join(" ") }
        : { kind: "off", message: result.message || "AI suggestions are unavailable just now." });
      return;
    }
    const data = result.data as SpendSuggestionShown & { suggestion?: null };
    if (!data.suggestionId) { setState({ kind: "none", message: "No suggestion — the line can't be told from its GL code and description. Choose its category yourself." }); return; }
    setState({ kind: "shown", suggestion: data });
  }

  async function decide(action: "confirm" | "dismiss", suggestion: SpendSuggestionShown) {
    const result = await postBrowserCommand(`/api/isolated/jobs/${jobId}/spend-suggestions/${suggestion.suggestionId}/${action}`,
      action === "confirm" ? { expectedVersion: suggestion.version, categoryCode: suggestion.categoryCode } : { expectedVersion: suggestion.version },
      key.current ??= crypto.randomUUID());
    key.current = null;
    if (result.state !== "success") { setState({ kind: "none", message: result.state === "validation_failed" ? result.issues.map((issue) => issue.message).join(" ") : result.message }); return; }
    const name = spendCategoryOf(suggestion.categoryCode)?.name ?? suggestion.categoryCode;
    setState({ kind: "decided", message: action === "confirm" ? `Added to this client's map: lines like this now go to ${name}.` : "Dismissed. Nothing was added to the map." });
    if (action === "confirm") onConfirmed?.();
  }

  if (state.kind === "idle") return <button type="button" className="nz-btn nz-ai-ask" onClick={() => void ask()}>Ask AI for a category</button>;
  if (state.kind === "asking") return <span className="nz-hint" role="status">Asking…</span>;
  if (state.kind !== "shown") return <span className="nz-hint" role="status">{state.message}</span>;
  const { suggestion } = state;
  return <div className="nz-ai-suggestion" role="note" aria-label="AI suggestion">
    <span className="nz-ai-badge">AI suggestion · not applied</span>
    <div><b>{spendCategoryOf(suggestion.categoryCode)?.name ?? suggestion.categoryCode}</b> <span className="muted">({suggestion.categoryCode})</span></div>
    {suggestion.reason ? <div className="nz-hint">{suggestion.reason}</div> : null}
    <div className="nz-ai-actions">
      {mode === "use"
        ? <button type="button" className="nz-btn pri" onClick={() => onUse?.(suggestion)}>Use this</button>
        : <button type="button" className="nz-btn pri" onClick={() => void decide("confirm", suggestion)}>Add to the map</button>}
      <button type="button" className="nz-btn" onClick={() => void decide("dismiss", suggestion)}>Dismiss</button>
    </div>
  </div>;
}
