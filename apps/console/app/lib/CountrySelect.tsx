"use client";

import { useId } from "react";
import { SmartSearch, type SmartSearchOption } from "@nzi/ui";
import { ISO_3166 } from "@nzi/contracts";

/** Every current ISO 3166-1 country, by name, with its code as the hint. */
const COUNTRIES: readonly SmartSearchOption[] = ISO_3166.map(([code, name]) => ({ id: code, label: name, hint: code }))
  .sort((a, b) => a.label.localeCompare(b.label, "en"));

/**
 * A country, chosen as you type (CLIENT-03): searches the ISO 3166-1 names and stores the canonical alpha-2 code. A held
 * value that is not a code (free text from an import) is not matched and shows as no selection, so it is chosen again
 * rather than silently kept.
 */
export function CountrySelect({ label, value, onChange, required }: { label: string; value: string | null; onChange: (code: string | null) => void; required?: boolean }) {
  const id = useId();
  return <div className="nz-fl">
    <label htmlFor={id}>{label}{required ? <span className="nz-req">*</span> : null}</label>
    <SmartSearch id={id} label={label} options={COUNTRIES} value={value ?? ""} placeholder="Type a country…" required={required}
      onChange={(code) => onChange(code || null)} />
  </div>;
}
