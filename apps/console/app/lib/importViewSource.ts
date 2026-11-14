import "server-only";
import { createV7ImportViewPool, v7ImportViewPoolConfig, v7ImportViewSource, type V7ImportRefreshSource } from "@nzi/isolated-backend";

/**
 * The import refresh's live source (BRIEF-v7-import-server-side-phase-c §1): the previous system's non-PII view set, read through
 * NZI_V7_VIEW_URL as cc_import_view. One pool per process, made on first use and remade only if the URL changes.
 *
 * Fail closed: `createV7ImportViewPool` refuses (V7ImportViewConnectionRefused) when the URL is unset, is not a Postgres URL,
 * names the console's own Supabase project (the project-ref compare), or has no verified TLS — before any connection is opened.
 * There is no fallback to any other URL.
 */
const holder = globalThis as typeof globalThis & { nziImportViewPool?: { url: string; pool: ReturnType<typeof createV7ImportViewPool> } };

export function liveImportViewPool(env: Readonly<Record<string, string | undefined>> = process.env): ReturnType<typeof createV7ImportViewPool> {
  // The guard runs on every call, not only when the pool is made: a cached pool never outlives a URL it would now refuse.
  v7ImportViewPoolConfig(env);
  const url = env.NZI_V7_VIEW_URL?.trim() ?? "";
  if (!holder.nziImportViewPool || holder.nziImportViewPool.url !== url) {
    const pool = createV7ImportViewPool(env);
    void holder.nziImportViewPool?.pool.end().catch(() => undefined);
    holder.nziImportViewPool = { url, pool };
  }
  return holder.nziImportViewPool.pool;
}

export function liveImportViewSource(env: Readonly<Record<string, string | undefined>> = process.env): V7ImportRefreshSource {
  return v7ImportViewSource(liveImportViewPool(env));
}
