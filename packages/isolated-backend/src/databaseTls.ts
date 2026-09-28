import { readFileSync } from "node:fs";

/**
 * Verified TLS for the maintenance scripts that write the isolated database from outside Render — the v7 load and the
 * demo job-number retirement, run on Francis's laptop so the extract never leaves it (NZC-020).
 *
 * What those scripts send is sealed contacts and report particulars, and client company names that are not sealed:
 * personal and commercially sensitive data, over the public internet. So:
 *
 *   - **A non-local host needs verified TLS**, or the script refuses before connecting: the server's certificate chain is
 *     checked against the CA given (`rejectUnauthorized: true`), and its hostname against the host connected to (pg sets
 *     `servername` for a named host, and Node's default identity check applies) — libpq's verify-full.
 *   - **Never encrypt-without-verify.** `sslmode=no-verify` is refused outright, and so are `disable`, `allow` and
 *     `prefer`, which may not encrypt at all.
 *   - **The CA is Supabase's certificate**, given either as `sslrootcert=<path>` in the connection string or as
 *     `NZI_DATABASE_CA_CERT` — a path to the PEM file, or the PEM itself.
 *   - **The connection string cannot overrule this.** pg lets settings parsed from the URL override the ones passed
 *     beside it, so every `ssl*` parameter is removed from the URL and TLS is set here, in one place.
 *
 * A local host (a test or development database) connects as before unless a CA is given, in which case it too is
 * verified — which is also how the handshake itself is tested.
 */

export class InsecureDatabaseConnectionRefused extends Error {}

export type TlsPoolConfig = {
  connectionString: string;
  ssl: false | { ca: string; rejectUnauthorized: true };
  /** One line for the script to print, saying how it is connecting. */
  description: string;
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const UNVERIFIED_MODES = new Set(["disable", "allow", "prefer", "no-verify"]);
const SSL_PARAMETERS = ["sslmode", "sslrootcert", "sslcert", "sslkey", "sslcrl", "sslpassword", "ssl", "uselibpqcompat"];

export const isLocalHost = (host: string): boolean => LOCAL_HOSTS.has(host.toLowerCase());

export function verifiedTlsConfig(
  databaseUrl: URL | string,
  env: { caCert?: string | undefined } = {},
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): TlsPoolConfig {
  const url = new URL(databaseUrl.toString());
  const host = url.hostname;
  const local = isLocalHost(host);
  const mode = url.searchParams.get("sslmode")?.toLowerCase() ?? null;
  const rootCert = url.searchParams.get("sslrootcert");
  for (const parameter of SSL_PARAMETERS) url.searchParams.delete(parameter);
  const connectionString = url.toString();

  if (mode === "no-verify") {
    throw new InsecureDatabaseConnectionRefused(`sslmode=no-verify encrypts without checking who is on the other end; it is never used here (${host}).`);
  }
  if (!local && mode !== null && UNVERIFIED_MODES.has(mode)) {
    throw new InsecureDatabaseConnectionRefused(`sslmode=${mode} may not encrypt at all; ${host} needs verified TLS.`);
  }

  // A PEM given inline passes through byte for byte; only a path is trimmed.
  const fromEnv = env.caCert?.trim() ? (env.caCert.trim().startsWith("-----BEGIN") ? env.caCert : env.caCert.trim()) : null;
  const source = rootCert ? { from: `sslrootcert=${rootCert}`, value: rootCert } : fromEnv ? { from: "NZI_DATABASE_CA_CERT", value: fromEnv } : null;
  if (!source) {
    if (local) return { connectionString, ssl: false, description: `${host}: local database, no TLS` };
    throw new InsecureDatabaseConnectionRefused(
      `${host} is not local, and nothing here is sent to it unencrypted or unverified. Give Supabase's CA certificate — ` +
      "sslrootcert=<path to the .crt> in the connection string, or NZI_DATABASE_CA_CERT (the path, or the PEM itself).");
  }
  if (rootCert === "system") {
    throw new InsecureDatabaseConnectionRefused("sslrootcert=system is not supported: name Supabase's CA certificate file.");
  }
  let ca: string;
  try {
    ca = source.value.trimStart().startsWith("-----BEGIN") ? source.value : read(source.value);
  } catch (error) {
    throw new InsecureDatabaseConnectionRefused(`${source.from}: the CA certificate could not be read (${error instanceof Error ? error.message : String(error)}).`);
  }
  if (!ca.includes("-----BEGIN CERTIFICATE-----")) {
    throw new InsecureDatabaseConnectionRefused(`${source.from}: not a PEM certificate.`);
  }
  return {
    connectionString,
    ssl: { ca, rejectUnauthorized: true },
    description: `${host}: verified TLS — chain against ${source.from}, hostname checked`,
  };
}
