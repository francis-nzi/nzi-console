"use client";

import { useEffect, useState } from "react";

/** One usage type a record may carry (dedup slice 2, 0171): an `emission_usage_type` value of this organisation's vocabulary. */
export type UsageTypeOption = { id: string; label: string };

/**
 * The organisation's active usage types — Car, Van, HGV, Generator… — read once from the staff lookups route.
 *
 * `undefined` until read, and stays `undefined` if the read fails: the field is optional, so a form that could not read the
 * vocabulary draws no usage field rather than an empty or misleading list. Withdrawn values are not offered; a record that
 * already holds one keeps it (the form shows it as withdrawn).
 */
export function useUsageTypes(): UsageTypeOption[] | undefined {
  const [options, setOptions] = useState<UsageTypeOption[] | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void fetch("/api/isolated/lookups/emission_usage_type", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() as Promise<{ values?: Array<{ valueId: string; label: string }> }> : null))
      .then((body) => { if (live && body?.values) setOptions(body.values.map((value) => ({ id: value.valueId, label: value.label }))); })
      .catch(() => undefined);
    return () => { live = false; };
  }, []);
  return options;
}
