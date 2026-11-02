import { FILE_STORAGE_PROVIDERS, type FileStorageProvider } from "@nzi/contracts";
import { FileStorageUnavailableError, type StorageAdapter } from "./adapter";
import { LocalStorageAdapter } from "./localAdapter";
import { graphTokenSource, SharePointStorageAdapter } from "./sharepointAdapter";

export * from "./adapter";
export * from "./fileGate";
export * from "./localAdapter";
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

/** The adapter that holds an existing record's bytes — by the record's own `storage_provider`, so a later provider coexists with older files. */
export function adapterForProvider(provider: FileStorageProvider, env: Record<string, string | undefined> = process.env): StorageAdapter {
  if (!FILE_STORAGE_PROVIDERS.includes(provider)) throw new FileStorageUnavailableError();
  const adapter = configuredStorageAdapter(env);
  if (adapter.provider !== provider) throw new FileStorageUnavailableError("This file is held by a store that is not configured.");
  return adapter;
}
