import assert from "node:assert/strict";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { after, describe, it } from "node:test";
import { PORTAL_FILE_MAX_BYTES } from "@nzi/contracts";
import { ClamAvScanner, configuredScanner, EicarDevScanner, eicarTestSignature, encodeInstream, ingestFile, LocalStorageAdapter, parseReply, ScannerUnavailableError } from "../src/fileStorage";

/**
 * ClamAV as the files gate's positive scanner (BRIEF-clamav-scanner), against a fake clamd that speaks the INSTREAM protocol — no live
 * daemon is needed or used. The fake checks the framing the real one requires and answers as clamd does.
 */
type Behaviour = "ok" | "hang" | "reset" | "error-reply" | "garbage" | "silent-close";
type Seen = { command: string; chunks: number[]; terminated: boolean; bytes: Buffer };

function fakeClamd(behaviour: Behaviour = "ok", seen: Seen[] = []): Promise<{ server: Server; port: number; seen: Seen[] }> {
  const server = createServer((socket: Socket) => {
    let buffer = Buffer.alloc(0);
    let state: { command: string; chunks: number[]; parts: Buffer[]; terminated: boolean } | null = null;
    socket.on("error", () => undefined);
    socket.on("data", (data) => {
      buffer = Buffer.concat([buffer, data]);
      if (!state) {
        const end = buffer.indexOf(0);
        if (end < 0) return;
        const command = buffer.subarray(0, end).toString();
        buffer = buffer.subarray(end + 1);
        if (command === "zPING") { socket.end(behaviour === "ok" ? "PONG\0" : ""); return; }
        state = { command, chunks: [], parts: [], terminated: false };
        if (behaviour === "reset") { socket.destroy(); return; }
        if (behaviour === "hang") return;
      }
      if (state.command !== "zINSTREAM" || behaviour === "hang") return;
      while (buffer.length >= 4 && !state.terminated) {
        const length = buffer.readUInt32BE(0);
        if (length === 0) { state.terminated = true; buffer = buffer.subarray(4); break; }
        if (buffer.length < 4 + length) return;
        state.chunks.push(length);
        state.parts.push(buffer.subarray(4, 4 + length));
        buffer = buffer.subarray(4 + length);
      }
      if (!state.terminated) return;
      const bytes = Buffer.concat(state.parts);
      seen.push({ command: state.command, chunks: state.chunks, terminated: true, bytes });
      if (behaviour === "error-reply") socket.end("INSTREAM size limit exceeded. ERROR\0");
      else if (behaviour === "garbage") socket.end("what\0");
      else if (behaviour === "silent-close") socket.end();
      else socket.end(bytes.toString("latin1").includes(eicarTestSignature()) ? "stream: Eicar-Test-Signature FOUND\0" : "stream: OK\0");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port, seen })));
}

const servers: Server[] = [];
after(() => { for (const server of servers) server.close(); });
const clamd = async (behaviour: Behaviour = "ok") => { const made = await fakeClamd(behaviour); servers.push(made.server); return made; };
const scannerFor = (port: number, over: Partial<ConstructorParameters<typeof ClamAvScanner>[0]> = {}) => new ClamAvScanner({ host: "127.0.0.1", port, timeoutMs: 400, ...over });
const bytes = (text: string) => new TextEncoder().encode(text);

describe("INSTREAM framing and clamd's replies", () => {
  it("frames the command, length-prefixed chunks and the zero terminator", () => {
    const frames = encodeInstream(new Uint8Array(10), 4, true);
    assert.equal(frames[0]!.toString(), "zINSTREAM\0");
    assert.deepEqual([1, 3, 5].map((index) => frames[index]!.readUInt32BE(0)), [4, 4, 2], "each chunk is prefixed by its length, big-endian");
    assert.deepEqual([2, 4, 6].map((index) => frames[index]!.length), [4, 4, 2]);
    assert.deepEqual(frames.at(-1), Buffer.alloc(4), "a zero-length chunk ends the stream");
    assert.deepEqual(encodeInstream(new Uint8Array(0), 4, true).length, 2, "an empty stream is the command and the terminator");
  });

  it("reads stream: OK as clean, … FOUND as infected, and everything else as no verdict", () => {
    assert.deepEqual(parseReply("stream: OK"), { state: "clean" });
    assert.deepEqual(parseReply("stream: Win.Test.EICAR_HDB-1 FOUND"), { state: "infected", detail: "Win.Test.EICAR_HDB-1" });
    for (const reply of ["INSTREAM size limit exceeded. ERROR", "stream: lstat() failed. ERROR", "", "OK", "stream: OKAY", "stream:  FOUND"]) assert.equal(parseReply(reply).state, "unknown", reply);
  });
});

describe("ClamAvScanner against a fake clamd", () => {
  it("streams the bytes and returns clean for stream: OK — the daemon sees exactly the bytes, in order, terminated", async () => {
    const { port, seen } = await clamd();
    const payload = new Uint8Array(200_000).map((_, index) => index % 251);
    assert.deepEqual(await scannerFor(port, { chunkBytes: 64 * 1024 }).scan(payload), { state: "clean" });
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0]!.chunks, [65536, 65536, 65536, 3392]);
    assert.ok(seen[0]!.terminated);
    assert.ok(Buffer.from(payload).equals(seen[0]!.bytes));
  });

  it("returns infected, with the signature, for the EICAR test file", async () => {
    const { port } = await clamd();
    assert.deepEqual(await scannerFor(port).scan(bytes(eicarTestSignature())), { state: "infected", detail: "Eicar-Test-Signature" });
  });

  it("returns unknown — never clean — when the daemon is unreachable, hangs, resets, errors, babbles or closes silently", async () => {
    const closed = await clamd();
    const closedPort = closed.port;
    closed.server.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const refused = await scannerFor(closedPort).scan(bytes("hello"));
    assert.equal(refused.state, "unknown");
    assert.match((refused as { detail: string }).detail, /could not be reached/);

    const started = Date.now();
    const hung = await scannerFor((await clamd("hang")).port, { timeoutMs: 150 }).scan(bytes("hello"));
    assert.equal(hung.state, "unknown");
    assert.match((hung as { detail: string }).detail, /did not answer within 150 ms/);
    assert.ok(Date.now() - started < 2000, "the timeout bounds the wait");

    for (const behaviour of ["reset", "error-reply", "garbage", "silent-close"] as const) {
      assert.equal((await scannerFor((await clamd(behaviour)).port).scan(bytes("hello"))).state, "unknown", behaviour);
    }
  });

  it("refuses to send a stream larger than the cap — unknown, without connecting — aligned to the 25 MB upload limit", async () => {
    const { port, seen } = await clamd();
    const scanner = scannerFor(port, { maxStreamBytes: 1000 });
    const verdict = await scanner.scan(new Uint8Array(1001));
    assert.equal(verdict.state, "unknown");
    assert.match((verdict as { detail: string }).detail, /larger than the scanner will accept/);
    assert.equal(seen.length, 0, "nothing was sent");
    assert.equal(new ClamAvScanner({ host: "x" })["o"].maxStreamBytes, PORTAL_FILE_MAX_BYTES);
    assert.equal(new ClamAvScanner({ host: "x" })["o"].port, 3310);
  });

  it("answers a readiness ping, and is false when the daemon is down", async () => {
    assert.equal(await scannerFor((await clamd()).port).ping(), true);
    const down = await clamd();
    down.server.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(await scannerFor(down.port).ping(), false);
  });
});

describe("the whole path: gate + ClamAvScanner + fake clamd", () => {
  const run = async (port: number, data: Uint8Array) => {
    const adapter = new LocalStorageAdapter();
    const file = await ingestFile({ adapter, scanner: scannerFor(port), organisationId: "o", clientId: "c", jobId: "j", fileName: "evidence.pdf", bytes: data });
    return { adapter, file };
  };
  const PDF = bytes("%PDF-1.7\n1 0 obj<<>>endobj\n%%EOF");

  it("EICAR is refused and flagged; a clean file is released and served by a signed URL", async () => {
    const { port } = await clamd();
    const bad = await run(port, bytes(`%PDF-1.4 ${eicarTestSignature()}`));
    assert.deepEqual([bad.file.status, bad.file.flag, bad.file.flagDetail], ["rejected", "infected", "Eicar-Test-Signature"]);
    await assert.rejects(bad.adapter.signedUrl(bad.file.externalItemId!, 60), /not available to serve/);
    const good = await run(port, PDF);
    assert.deepEqual([good.file.status, good.file.flag], ["released", null]);
    assert.deepEqual(good.adapter.fetchSigned((await good.adapter.signedUrl(good.file.externalItemId!, 60)).url), PDF);
  });

  it("scanner down, timing out or erroring holds the file: never released, never served", async () => {
    const closed = await clamd();
    closed.server.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (const port of [closed.port, (await clamd("hang")).port, (await clamd("error-reply")).port]) {
      const { adapter, file } = await run(port, PDF);
      assert.deepEqual([file.status, file.flag], ["quarantined", "scan_inconclusive"]);
      assert.equal(adapter.areaOf(file.externalItemId!), "quarantine");
      await assert.rejects(adapter.signedUrl(file.externalItemId!, 60), /not available to serve/);
    }
  });
});

describe("the scanner is configured, and fails closed when it is not", () => {
  it("is ClamAV from CLAMAV_HOST, with the port and timeout defaulted or read", () => {
    const scanner = configuredScanner({ CLAMAV_HOST: "clamd.internal", CLAMAV_PORT: "3311", CLAMAV_TIMEOUT_MS: "5000" }) as ClamAvScanner;
    assert.ok(scanner instanceof ClamAvScanner);
    assert.deepEqual([scanner["o"].host, scanner["o"].port, scanner["o"].timeoutMs], ["clamd.internal", 3311, 5000]);
    const defaults = configuredScanner({ CLAMAV_HOST: "h" }) as ClamAvScanner;
    assert.deepEqual([defaults["o"].port, defaults["o"].timeoutMs], [3310, 30000]);
  });

  it("refuses to run with no scanner, or a nonsensical one: unavailable, so nothing is accepted or released", () => {
    for (const env of [{}, { CLAMAV_HOST: " " }, { CLAMAV_HOST: "h", CLAMAV_PORT: "nope" }, { CLAMAV_HOST: "h", CLAMAV_PORT: "70000" }, { CLAMAV_HOST: "h", CLAMAV_TIMEOUT_MS: "5" }, { NZI_SCANNER: "none" }]) {
      assert.throws(() => configuredScanner(env), ScannerUnavailableError, JSON.stringify(env));
    }
  });

  it("allows the EICAR-only development scanner only outside production", () => {
    assert.ok(configuredScanner({ NZI_SCANNER: "eicar-dev" }) instanceof EicarDevScanner);
    assert.throws(() => configuredScanner({ NZI_SCANNER: "eicar-dev", NEXT_PUBLIC_APP_ENV: "production" }), ScannerUnavailableError);
  });
});
