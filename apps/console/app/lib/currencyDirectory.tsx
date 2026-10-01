import "server-only";
import { cache } from "react";
import { connection } from "next/server";
import type { CurrencyDirectoryEntry } from "@nzi/contracts";
import { readCurrencyDirectory, withTenantRead } from "@nzi/isolated-backend";
import { isolatedPool } from "./isolatedDatabase";
import { CurrencyDirectoryProvider } from "./CurrencyDirectoryProvider";

/**
 * The deployment organisation's currencies (admin E1, 0145) — what `currencySymbol(code)` reads for every unit on the
 * page. Read per request (`connection()` keeps it out of the build), once per request (`cache`). Null when it cannot be
 * read (fixture mode, or the database is unavailable): the symbols D3c shipped then stand in.
 */
export const deploymentCurrencyDirectory = cache(async (): Promise<CurrencyDirectoryEntry[] | null> => {
  await connection();
  const organisationId = process.env.NZI_DEMO_ORGANISATION_ID?.trim();
  if (process.env.NZI_DATA_MODE !== "isolated-api" || !organisationId) return null;
  try {
    return await withTenantRead(isolatedPool(), organisationId, (db) => readCurrencyDirectory(db, organisationId));
  } catch (error) {
    console.error("[currency-directory] the organisation's currencies could not be read", error);
    return null;
  }
});

/** Wraps a subtree whose units read in the organisation's currencies (client workspace, job, portal, organisation). */
export async function WithCurrencyDirectory({ children }: { children: React.ReactNode }) {
  return <CurrencyDirectoryProvider entries={await deploymentCurrencyDirectory()}>{children}</CurrencyDirectoryProvider>;
}
