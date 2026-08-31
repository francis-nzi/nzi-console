// Per-adapter flags for the data-entry redesign rollout (docs/REDESIGN_ROLLOUT.md
// §"Feature-flag strategy"). Each adapter ships behind its own flag, OFF by
// default, with the current generic path as default until the adapter passes its
// acceptance. Resolved from one NEXT_PUBLIC_* variable so server and client agree
// across render boundaries.
//
//   NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2=spend
//   NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2=spend,commuting
//
// Flags gate UI only — the additive schema (Phase 0) is always present and inert
// until read.

export type DataEntryAdapter = "spend" | "spend-import" | "portal-spend" | "commuting" | "vehicle" | "manual" | "import";

const enabledAdapters = (): Set<string> =>
  new Set(
    (process.env.NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2 ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );

export function dataEntryAdapterEnabled(adapter: DataEntryAdapter): boolean {
  return enabledAdapters().has(adapter);
}
