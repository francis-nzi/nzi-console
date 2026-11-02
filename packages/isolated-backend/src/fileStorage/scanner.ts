import { createConnection, type Socket } from "node:net";
import { PORTAL_FILE_MAX_BYTES } from "@nzi/contracts";
import { FileStorageUnavailableError, type ScanVerdict } from "./adapter";

/**
 * The positive scanner (BRIEF-clamav-scanner). **Separate from the storage adapter**: the gate holds the bytes at ingest, so a virus
 * verdict does not depend on where they are stored, and moving the store never moves the scanner.
 *
 * `scan(bytes)` answers `clean`, `infected` or `unknown`. `clean` is a positive statement by the scanner — silence, an error, a timeout
 * or an unreachable service is `unknown`, never `clean`, and the gate holds a file on `unknown`. The scanner's verdict is the one release
 * is gated on.
 */
export interface Scanner {
  scan(bytes: Uint8Array): Promise<ScanVerdict>;
}

/** No scanner is configured. Fails closed (503 on upload) — the same discipline as an unconfigured store. */
export class ScannerUnavailableError extends FileStorageUnavailableError {
  constructor(message = "File scanning is not available just now.") { super(message); this.name = "ScannerUnavailableError"; }
}

export type ClamAvOptions = {
  host: string; port?: number;
  /** For the whole conversation (connect, stream, verdict). Past it the verdict is `unknown`. */
  timeoutMs?: number;
  /** clamd's own StreamMaxLength should be at least this; a stream longer than it is not sent (`unknown`). Aligned to the upload cap. */
  maxStreamBytes?: number;
  chunkBytes?: number;
};

const DEFAULTS = { port: 3310, timeoutMs: 30_000, maxStreamBytes: PORTAL_FILE_MAX_BYTES, chunkBytes: 64 * 1024 };

/**
 * ClamAV over clamd's `INSTREAM` (TCP): `zINSTREAM\0`, then the bytes in chunks each prefixed by its length as 4 bytes big-endian, then a
 * zero-length chunk. clamd answers `stream: OK`, `stream: <signature> FOUND`, or `… ERROR` (for example when its StreamMaxLength is
 * exceeded) — a null-terminated line. Only `OK` is clean; `FOUND` is infected; anything else — an ERROR, a reset, a hang, no answer — is
 * `unknown`.
 */
export class ClamAvScanner implements Scanner {
  private readonly o: Required<ClamAvOptions>;
  constructor(options: ClamAvOptions) { this.o = { ...DEFAULTS, ...options }; }

  async scan(bytes: Uint8Array): Promise<ScanVerdict> {
    if (bytes.length > this.o.maxStreamBytes) return { state: "unknown", detail: "The file is larger than the scanner will accept." };
    try { return parseReply(await this.converse(encodeInstream(bytes, this.o.chunkBytes, true))); }
    catch (error) { return { state: "unknown", detail: error instanceof Error ? error.message : "The scanner could not be reached." }; }
  }

  /** Whether clamd answers `PONG` — for a readiness check; the gate does not depend on it (a scan that cannot be made is `unknown`). */
  async ping(): Promise<boolean> {
    try { return (await this.converse([Buffer.from("zPING\0")])).trim() === "PONG"; } catch { return false; }
  }

  private converse(frames: Buffer[]): Promise<string> {
    return new Promise((resolve, reject) => {
      let socket: Socket;
      let done = false;
      const received: Buffer[] = [];
      const finish = (error: Error | null, reply?: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket?.destroy();
        if (error) reject(error); else resolve(reply!);
      };
      const timer = setTimeout(() => finish(new Error(`The scanner did not answer within ${this.o.timeoutMs} ms.`)), this.o.timeoutMs);
      socket = createConnection({ host: this.o.host, port: this.o.port });
      socket.on("error", (error) => finish(new Error(`The scanner could not be reached (${(error as NodeJS.ErrnoException).code ?? "error"}).`)));
      socket.on("close", () => finish(new Error("The scanner closed the connection without an answer.")));
      socket.on("data", (chunk) => {
        received.push(chunk);
        const text = Buffer.concat(received);
        const end = text.indexOf(0);
        if (end >= 0) finish(null, text.subarray(0, end).toString("utf8"));
      });
      socket.on("connect", () => {
        const send = (index: number): void => {
          if (done) return;
          if (index === frames.length) return;
          if (socket.write(frames[index]!)) send(index + 1); else socket.once("drain", () => send(index + 1));
        };
        send(0);
      });
      socket.setNoDelay(true);
    });
  }
}

/** The INSTREAM frames: the command, the length-prefixed chunks, and the zero-length terminator. */
export function encodeInstream(bytes: Uint8Array, chunkBytes: number, withCommand: boolean): Buffer[] {
  const frames: Buffer[] = withCommand ? [Buffer.from("zINSTREAM\0")] : [];
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.length));
    const length = Buffer.alloc(4);
    length.writeUInt32BE(chunk.length);
    frames.push(length, Buffer.from(chunk));
  }
  frames.push(Buffer.alloc(4));
  return frames;
}

/** clamd's one-line answer → a verdict. Anything that is not exactly `OK` or `… FOUND` is not a verdict. */
export function parseReply(reply: string): ScanVerdict {
  const line = reply.trim();
  if (line === "stream: OK") return { state: "clean" };
  const found = /^stream: (.+) FOUND$/.exec(line);
  if (found) return { state: "infected", detail: found[1]! };
  return { state: "unknown", detail: line ? `The scanner said: ${line.slice(0, 160)}` : "The scanner gave no answer." };
}

/** Development only (never production): flags the standard EICAR test file and passes everything else, so the flow can be exercised without clamd. */
export class EicarDevScanner implements Scanner {
  async scan(bytes: Uint8Array): Promise<ScanVerdict> {
    const eicar = ["X5O!P%@AP[4\\PZX54(P^)7CC)7}$", "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"].join("");
    return new TextDecoder("latin1").decode(bytes).includes(eicar) ? { state: "infected", detail: "EICAR test signature" } : { state: "clean" };
  }
}
