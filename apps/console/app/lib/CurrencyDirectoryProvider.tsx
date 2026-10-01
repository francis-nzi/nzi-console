"use client";
import { setCurrencyDirectory, type CurrencyDirectoryEntry } from "@nzi/contracts";

/**
 * Registers the organisation's currencies for `currencySymbol(code)` (admin E1) — during render, before its children
 * render, so every unit below reads in the organisation's own symbols, on the server render and in the browser alike.
 * The console serves one organisation (`NZI_DEMO_ORGANISATION_ID`), so every render registers the same set.
 * `null` (the set could not be read) leaves the symbols D3c shipped standing in.
 */
export function CurrencyDirectoryProvider({ entries, children }: { entries: CurrencyDirectoryEntry[] | null; children: React.ReactNode }) {
  if (entries !== null) setCurrencyDirectory(entries);
  return <>{children}</>;
}
