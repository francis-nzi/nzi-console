import { FILE_STORAGE_PROVIDERS, type FileStorageProvider } from "@nzi/contracts";
import { FileStorageUnavailableError, type StorageAdapter } from "./adapter";
import { LocalStorageAdapter } from "./localAdapter";
import { ClamAvScanner, EicarDevScanner, ScannerUnavailableError, type Scanner } from "./scanner";
import { graphTokenSource, SharePointStorageAdapter } from "./sharepointAdapter";

export * from "./adapter";
export * from "./fileGate";
export * from "./localAdapter";
export * from "./scanner";
export * from "./sharepointAdapter";
export * from "./uploadPolicy";

/**
 * The deployed adapter, from configuration only (BRIEF §4: a later move is config + one adapter). Unset or incomplete fails closed —
 * `FileStorageUnavailableError` — so a service with no store accepts no upload and serves no file. `local` is for development and tests.
 *
 *   NZI_FILE_STORAGE=sharepoint  NZI_SHAREPOINT_DRIVE_ID  NZI_GRAPH_TENANT_ID  NZI_GRAPH_CLIENT_ID  NZI_GRAPH_CLIENT_SECRET
 */
let local: LocalStorageAdapter | null = null;
export function configuredStorageAdapter(env: Record<string, string | undefined> = process.env): StorageAdapter {
  const provider = env.NZI_FILE_STORAGE?.trim().toLowerCase();
  if (provider === "sharepoint") {
    const { NZI_SHAREPOINT_DRIVE_ID: driveId, NZI_GRAPH_TENANT_ID: tenantId, NZI_GRAPH_CLIENT_ID: clientId, NZI_GRAPH_CLIENT_SECRET: clientSecret } = env;
    if (!driveId || !tenantId || !clientId || !clientSecret) throw new FileStorageUnavailableError();
    return new SharePointStorageAdapter({ driveId }, { fetch, token: graphTokenSource({ tenantId, clientId, clientSecret }) });
  }
  if (provider === "local" && env.NEXT_PUBLIC_APP_ENV !== "production") return (local ??= new LocalStorageAdapter());
  throw new FileStorageUnavailableError();
}

/**
 * The scanner, from configuration only — the same discipline as the store: unset fails closed (`ScannerUnavailableError`, 503), so a
 * service with no scanner accepts no upload and releases nothing. An unreachable one is a per-file `unknown` (held), not a throw.
 *
 *   CLAMAV_HOST  CLAMAV_PORT (default 3310)  CLAMAV_TIMEOUT_MS (default 30000)
 *
 * `NZI_SCANNER=eicar-dev` selects a development scanner that only flags the EICAR test file; it is refused when the app is production.
 */
export function configuredScanner(env: Record<string, string | undefined> = process.env): Scanner {
  const host = env.CLAMAV_HOST?.trim();
  if (host) {
    const port = env.CLAMAV_PORT?.trim() ? Number(env.CLAMAV_PORT) : 3310;
    const timeoutMs = env.CLAMAV_TIMEOUT_MS?.trim() ? Number(env.CLAMAV_TIMEOUT_MS) : 30_000;
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isFinite(timeoutMs) || timeoutMs < 100) throw new ScannerUnavailableError();
    return new ClamAvScanner({ host, port, timeoutMs });
  }
  if (env.NZI_SCANNER?.trim().toLowerCase() === "eicar-dev" && env.NEXT_PUBLIC_APP_ENV !== "production") return new EicarDevScanner();
  throw new ScannerUnavailableError();
}

/** The adapter that holds an existing record's bytes — by the record's own `storage_provider`, so a later provider coexists with older files. */
export function adapterForProvider(provider: FileStorageProvider, env: Record<string, string | undefined> = process.env): StorageAdapter {
  if (!FILE_STORAGE_PROVIDERS.includes(provider)) throw new FileStorageUnavailableError();
  const adapter = configuredStorageAdapter(env);
  if (adapter.provider !== provider) throw new FileStorageUnavailableError("This file is held by a store that is not configured.");
  return adapter;
}
