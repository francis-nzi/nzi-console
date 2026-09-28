import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type AddressInfo, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TLSSocket } from "node:tls";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { InsecureDatabaseConnectionRefused, verifiedTlsConfig } from "../src/databaseTls";

/**
 * Verified TLS for the scripts that write the isolated database from a laptop. The rules are checked directly; the
 * verification itself is checked with real handshakes against a stand-in Postgres TLS endpoint and a throwaway CA, so
 * "rejectUnauthorized: true" is shown to reject — a wrong CA, and a certificate for another host.
 */

const SUPABASE = "postgres://user:secret@aws-0-eu-west-2.pooler.supabase.com:5432/postgres";
const PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
const refused = (fn: () => unknown, pattern: RegExp) => assert.throws(fn, (error: unknown) =>
  error instanceof InsecureDatabaseConnectionRefused && pattern.test(error.message));

describe("which connections the laptop scripts will make", () => {
  it("refuses a remote database with no CA, and never offers encrypt-without-verify", () => {
    refused(() => verifiedTlsConfig(SUPABASE), /not local.*Supabase's CA certificate/);
    refused(() => verifiedTlsConfig(`${SUPABASE}?sslmode=require`), /not local/);
    refused(() => verifiedTlsConfig(`${SUPABASE}?sslmode=no-verify`, { caCert: PEM }), /no-verify/);
    refused(() => verifiedTlsConfig("postgres://u:p@localhost/db?sslmode=no-verify"), /no-verify/);
    for (const mode of ["disable", "allow", "prefer"]) refused(() => verifiedTlsConfig(`${SUPABASE}?sslmode=${mode}`, { caCert: PEM }), /may not encrypt/);
  });

  it("verifies a remote database against the CA, from the URL or the environment, and strips every ssl parameter", () => {
    const fromUrl = verifiedTlsConfig(`${SUPABASE}?sslmode=verify-full&sslrootcert=C:/certs/supabase.crt`, {}, (path) => {
      assert.equal(path, "C:/certs/supabase.crt");
      return PEM;
    });
    assert.deepEqual(fromUrl.ssl, { ca: PEM, rejectUnauthorized: true });
    assert.doesNotMatch(fromUrl.connectionString, /ssl/, "pg lets URL ssl settings override ours, so none survive");
    assert.match(fromUrl.description, /verified TLS — chain against sslrootcert=C:\/certs\/supabase\.crt, hostname checked/);

    assert.deepEqual(verifiedTlsConfig(SUPABASE, { caCert: PEM }).ssl, { ca: PEM, rejectUnauthorized: true }, "the PEM itself");
    assert.deepEqual(verifiedTlsConfig(SUPABASE, { caCert: "/etc/supabase.crt" }, () => PEM).ssl, { ca: PEM, rejectUnauthorized: true }, "a path");
    refused(() => verifiedTlsConfig(SUPABASE, { caCert: "/nowhere.crt" }, () => { throw new Error("ENOENT"); }), /could not be read.*ENOENT/);
    refused(() => verifiedTlsConfig(SUPABASE, { caCert: "/etc/not-a-cert" }, () => "hello"), /not a PEM certificate/);
    refused(() => verifiedTlsConfig(`${SUPABASE}?sslrootcert=system`), /system is not supported/);
  });

  it("leaves a local test database as it was, unless a CA is given", () => {
    assert.equal(verifiedTlsConfig("postgres://u:p@localhost:54339/db").ssl, false);
    assert.equal(verifiedTlsConfig("postgres://u:p@127.0.0.1:5432/db?sslmode=disable").ssl, false);
    assert.deepEqual(verifiedTlsConfig("postgres://u:p@localhost:54339/db", { caCert: PEM }).ssl, { ca: PEM, rejectUnauthorized: true });
  });
});

// ── Real handshakes ───────────────────────────────────────────────────────────────────────────────────────────

const openssl = spawnSync("openssl", ["version"], { encoding: "utf8" });
describe("the verification, over a real TLS handshake", { skip: openssl.status === 0 ? false : "openssl is not on the PATH" }, () => {
  let dir: string;
  let server: Server;
  let port = 0;
  let certificate: { key: string; cert: string };
  const handshakes: string[] = [];

  const run = (args: string[]) => {
    const result = spawnSync("openssl", args, { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  const serverCertificate = (name: string, host: string) => {
    run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.crt`, "-days", "2",
      "-subj", `/CN=${host}`, "-CA", "ca.crt", "-CAkey", "ca.key",
      "-addext", `subjectAltName=DNS:${host}`, "-addext", "basicConstraints=critical,CA:FALSE"]);
    return { key: readFileSync(join(dir, `${name}.key`), "utf8"), cert: readFileSync(join(dir, `${name}.crt`), "utf8") };
  };
  const attempt = async (ca: string) => {
    const tls = verifiedTlsConfig(`postgres://u:p@localhost:${port}/db`, { caCert: ca });
    const client = new pg.Client({ connectionString: tls.connectionString, ssl: tls.ssl, connectionTimeoutMillis: 5000 });
    client.on("error", () => undefined);
    const before = handshakes.length;
    const outcome = await client.connect().then(() => "connected", (error: Error & { code?: string }) => `${error.code ?? ""} ${error.message}`);
    await client.end().catch(() => undefined);
    return { outcome, handshook: handshakes.length > before };
  };

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "tls-"));
    run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "2", "-subj", "/CN=Throwaway test CA"]);
    run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "other-ca.key", "-out", "other-ca.crt", "-days", "2", "-subj", "/CN=Another CA"]);
    certificate = serverCertificate("localhost", "localhost");
    // A stand-in for Postgres: answer the SSLRequest with 'S', complete the handshake, then hang up.
    server = createServer((socket) => {
      socket.once("data", () => {
        socket.write("S");
        const secure = new TLSSocket(socket, { isServer: true, key: certificate.key, cert: certificate.cert });
        secure.on("secure", () => { handshakes.push("ok"); secure.destroy(); });
        secure.on("error", () => secure.destroy());
      });
      socket.on("error", () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it("completes the handshake when the chain and the hostname both check out", async () => {
    const result = await attempt(readFileSync(join(dir, "ca.crt"), "utf8"));
    assert.equal(result.handshook, true, `no handshake: ${result.outcome}`);
  });

  it("refuses a server whose certificate another CA signed", async () => {
    const result = await attempt(readFileSync(join(dir, "other-ca.crt"), "utf8"));
    assert.equal(result.handshook, false);
    assert.match(result.outcome, /self[- ]signed|unable to verify|UNABLE_TO_VERIFY|SELF_SIGNED/i);
  });

  it("refuses a server whose certificate names another host, even from the right CA", async () => {
    certificate = serverCertificate("elsewhere", "db.elsewhere.test");
    try {
      const result = await attempt(readFileSync(join(dir, "ca.crt"), "utf8"));
      assert.equal(result.handshook, false);
      assert.match(result.outcome, /ERR_TLS_CERT_ALTNAME_INVALID|does not match/);
    } finally {
      certificate = serverCertificate("localhost-again", "localhost");
    }
  });
});

