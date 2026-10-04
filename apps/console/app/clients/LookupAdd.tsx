"use client";

import { useRef, useState } from "react";
import type { SmartSearchOption } from "@nzi/ui";
import { postBrowserCommand, type BrowserCommandResult } from "@nzi/api-client";
import { useHasCapability } from "../lib/useEditAccess";

/**
 * "Where do we add to the selections?" (CLIENT-06). A lookup-backed field draws its options from Admin → Lookups; a
 * holder of admin.lookups can add the missing value in place — the same reference.value.create command the Lookups
 * screen uses, audited the same way — and it is chosen at once. Anyone else is told where values are managed.
 */
const errorText = (result: BrowserCommandResult<unknown>) =>
  result.state === "validation_failed" ? (result.issues[0]?.message ?? result.message) : result.state === "success" ? "" : result.message;

export function LookupAdd({ categoryKey, noun, onAdded }: { categoryKey: string; noun: string; onAdded: (option: SmartSearchOption) => void }) {
  const canAdd = useHasCapability("admin.lookups");
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef<string | null>(null);

  if (!canAdd) return <small className="nz-hint">Missing {/^[aeiou]/i.test(noun) ? "an" : "a"} {noun}? This list is managed in Admin → Lookups.</small>;
  if (!open) return <button type="button" className="nz-editlink nz-lookup-add" onClick={() => setOpen(true)}>＋ Add a new {noun}</button>;

  async function add() {
    const value = label.trim();
    if (!value) { setError(`Give the new ${noun} a name.`); return; }
    setPending(true);
    setError(null);
    key.current ??= crypto.randomUUID();
    const result = await postBrowserCommand<{ valueId: string }>("/api/isolated/reference-values", { categoryKey, label: value }, key.current);
    setPending(false);
    if (result.state !== "success") { key.current = null; setError(errorText(result)); return; }
    key.current = null;
    onAdded({ id: result.data.valueId, label: value });
    setLabel("");
    setOpen(false);
  }

  return <div className="nz-lookup-add-row">
    <input className="nz-inp" value={label} placeholder={`New ${noun}`} aria-label={`New ${noun}`} autoFocus
      onChange={(event) => setLabel(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void add(); } }} />
    <button type="button" className="nz-btn" disabled={pending} onClick={() => void add()}>{pending ? "Adding…" : "Add"}</button>
    <button type="button" className="nz-editlink" onClick={() => { setOpen(false); setError(null); }}>Cancel</button>
    {error ? <small className="nz-hint nz-field-error" role="alert">{error}</small> : null}
    <small className="nz-hint">Added to Admin → Lookups for everyone, and chosen here.</small>
  </div>;
}
