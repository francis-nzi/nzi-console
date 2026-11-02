import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { PORTAL_FILE_MAX_BYTES, safeFileName } from "@nzi/contracts";
import {
  configuredStorageAdapter, eicarTestSignature, FileStorageUnavailableError, ingestFile, LocalStorageAdapter, rescanFile, sha256Hex, sniffUpload, SharePointStorageAdapter,
  zipEntryNames, type ScanVerdict,
} from "../src/fileStorage";

/**
 * Portal files: the policy, the quarantine-until-clean gate, and the storage seam (BRIEF-portal-files-secure-upload-storage). No database.
 */
const bytes = (text: string) => new TextEncoder().encode(text);
const PDF = bytes("%PDF-1.7\n1 0 obj<<>>endobj\n%%EOF");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

/** A stored (uncompressed) ZIP with the named entries — enough of the format for the central directory to be read. */
function zip(names: string[]): Uint8Array {
  const parts: number[] = [], central: number[] = [];
  const u16 = (n: number) => [n & 255, (n >> 8) & 255], u32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
  for (const name of names) {
    const raw = [...bytes(name)], offset = parts.length;
    parts.push(...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(0), ...u32(0), ...u16(raw.length), ...u16(0), ...raw);
    central.push(...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(0), ...u32(0), ...u16(raw.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...raw);
  }
  const end = [...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(names.length), ...u16(names.length), ...u32(central.length), ...u32(parts.length), ...u16(0)];
  return new Uint8Array([...parts, ...central, ...end]);
}
const DOCX = zip(["[Content_Types].xml", "word/document.xml"]);
const XLSX = zip(["[Content_Types].xml", "xl/workbook.xml"]);

describe("the upload policy decides from the bytes, never the name", () => {
  it("accepts PDF, PNG, JPEG, docx, xlsx, pptx, CSV and plain text", () => {
    assert.deepEqual(sniffUpload(PDF, "invoice.pdf"), { ok: true, contentType: "application/pdf" });
    assert.deepEqual(sniffUpload(PNG, "logo.png"), { ok: true, contentType: "image/png" });
    assert.deepEqual(sniffUpload(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0]), "p.jpg"), { ok: true, contentType: "image/jpeg" });
    assert.equal((sniffUpload(DOCX, "a.docx") as { contentType: string }).contentType, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    assert.equal((sniffUpload(XLSX, "a.xlsx") as { contentType: string }).contentType, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    assert.equal((sniffUpload(zip(["[Content_Types].xml", "ppt/presentation.xml"]), "a.pptx") as { contentType: string }).contentType, "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    assert.deepEqual(sniffUpload(bytes("a,b\n1,2\n"), "data.csv"), { ok: true, contentType: "text/csv" });
    assert.deepEqual(sniffUpload(bytes("notes"), "notes.txt"), { ok: true, contentType: "text/plain" });
  });

  it("is not fooled by an extension: an executable named .pdf is an executable, a PDF named .exe is a PDF", () => {
    assert.deepEqual(sniffUpload(new Uint8Array([0x4d, 0x5a, 0x90, 0, 3]), "invoice.pdf"), { ok: false, flag: "executable", detail: "Executable files are not accepted." });
    assert.equal(sniffUpload(PDF, "thing.exe").ok, true);
    for (const head of [[0x7f, 0x45, 0x4c, 0x46], [0x23, 0x21, 0x2f, 0x62], [0xca, 0xfe, 0xba, 0xbe], [0xcf, 0xfa, 0xed, 0xfe]]) {
      const result = sniffUpload(new Uint8Array([...head, 0, 0, 0]), "x.pdf");
      assert.equal(result.ok === false && result.flag, "executable");
    }
  });

  it("refuses macro-bearing Office files — legacy OLE, and any OOXML with a VBA project — and executables inside an archive", () => {
    assert.equal((sniffUpload(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]), "old.doc") as { flag: string }).flag, "macro");
    assert.equal((sniffUpload(zip(["[Content_Types].xml", "xl/workbook.xml", "xl/vbaProject.bin"]), "m.xlsx") as { flag: string }).flag, "macro");
    assert.equal((sniffUpload(zip(["[Content_Types].xml", "word/document.xml", "payload.exe"]), "d.docx") as { flag: string }).flag, "executable");
    assert.equal((sniffUpload(bytes("%PDF-1.4 /Launch /Action"), "p.pdf") as { flag: string }).flag, "executable");
  });

  it("refuses plain archives, markup, unknown binaries, empty and oversize files, each with a flag", () => {
    assert.equal((sniffUpload(zip(["a.txt"]), "travel.zip") as { flag: string }).flag, "type_not_allowed");
    assert.equal((sniffUpload(bytes("<html><script>alert(1)</script>"), "x.txt") as { flag: string }).flag, "type_not_allowed");
    assert.equal((sniffUpload(new Uint8Array([1, 2, 0, 4, 5]), "x.dat") as { flag: string }).flag, "type_not_allowed");
    assert.equal((sniffUpload(new Uint8Array(0), "x.pdf") as { flag: string }).flag, "empty");
    assert.equal((sniffUpload(PDF, "big.pdf", 10) as { flag: string }).flag, "oversize");
    assert.equal(PORTAL_FILE_MAX_BYTES, 25 * 1024 * 1024);
  });

  it("reads a ZIP's central directory, and a name is only ever a leaf", () => {
    assert.deepEqual(zipEntryNames(DOCX), ["[Content_Types].xml", "word/document.xml"]);
    assert.equal(zipEntryNames(new Uint8Array([1, 2, 3])), null);
    assert.equal(safeFileName("..\\..\\etc/passwd\u0000.pdf"), "passwd.pdf");
    assert.equal(safeFileName("   "), "file");
  });
});

describe("the gate: quarantine until clean, and a quarantined file is never served", () => {
  const input = (adapter: LocalStorageAdapter, data: Uint8Array, name = "evidence.pdf") => ({ adapter, organisationId: "org-1", clientId: "c-1", jobId: "j-1", fileName: name, bytes: data });

  it("releases a clean file: stored, scanned, promoted, hashed, and served only through a signed, time-limited URL", async () => {
    let now = 1_000_000;
    const adapter = new LocalStorageAdapter({ now: () => now });
    const file = await ingestFile(input(adapter, PDF));
    assert.deepEqual([file.status, file.flag, file.contentType, file.sha256, file.storageProvider], ["released", null, "application/pdf", sha256Hex(PDF), "local"]);
    assert.equal(adapter.areaOf(file.externalItemId!), "released");
    const signed = await adapter.signedUrl(file.externalItemId!, 60);
    assert.deepEqual(adapter.fetchSigned(signed.url), PDF);
    now += 61_000;
    assert.equal(adapter.fetchSigned(signed.url), null, "the URL lapses");
    assert.equal(adapter.fetchSigned("local://download/forged"), null);
  });

  it("refuses and flags an infected file: withdrawn from quarantine, never released, never served", async () => {
    const adapter = new LocalStorageAdapter();
    const file = await ingestFile(input(adapter, bytes(`%PDF-1.4 ${eicarTestSignature()}`)));
    assert.deepEqual([file.status, file.flag], ["rejected", "infected"]);
    assert.equal(adapter.areaOf(file.externalItemId!), "deactivated");
    await assert.rejects(adapter.signedUrl(file.externalItemId!, 60), /not available to serve/);
  });

  it("refuses oversize, disallowed and executable files before they are stored, and flags each", async () => {
    const adapter = new LocalStorageAdapter();
    const exe = await ingestFile(input(adapter, new Uint8Array([0x4d, 0x5a, 0, 0]), "setup.exe"));
    const archive = await ingestFile(input(adapter, zip(["a.txt"]), "all.zip"));
    for (const [file, flag] of [[exe, "executable"], [archive, "type_not_allowed"]] as const) {
      assert.deepEqual([file.status, file.flag, file.externalItemId], ["rejected", flag, null]);
      assert.match(file.sha256, /^[0-9a-f]{64}$/, "a refused file is still evidenced by its hash");
    }
  });

  it("holds a file the scanner cannot decide: quarantined, non-servable, then released by a re-scan once it can", async () => {
    let verdict: ScanVerdict = { state: "unknown", detail: "Waiting for the scan." };
    const adapter = new LocalStorageAdapter({ scanner: () => verdict });
    const held = await ingestFile(input(adapter, PDF));
    assert.deepEqual([held.status, held.flag], ["quarantined", "scan_inconclusive"]);
    assert.equal(adapter.areaOf(held.externalItemId!), "quarantine");
    await assert.rejects(adapter.signedUrl(held.externalItemId!, 60), /not available to serve/, "a quarantined file is never served");
    verdict = { state: "clean" };
    const released = await rescanFile(adapter, { ...held, externalItemId: held.externalItemId! });
    assert.deepEqual([released.status, released.flag], ["released", null]);
    assert.ok(await adapter.signedUrl(released.externalItemId!, 60));
  });

  it("holds, rather than releases, when the scan fails or the release cannot be made", async () => {
    const broken = new LocalStorageAdapter({ scanner: () => { throw new Error("scanner down"); } });
    const failed = await ingestFile(input(broken, PDF));
    assert.deepEqual([failed.status, failed.flag], ["quarantined", "scan_failed"]);
    const adapter = new LocalStorageAdapter();
    adapter.promote = async () => { throw new Error("move failed"); };
    const stuck = await ingestFile(input(adapter, PDF));
    assert.deepEqual([stuck.status, stuck.flag], ["quarantined", "scan_failed"]);
    await assert.rejects(adapter.signedUrl(stuck.externalItemId!, 60));
  });
});

describe("the SharePoint adapter, against a fake Graph", () => {
  function fakeGraph(items: Map<string, { path: string; created: string; malware?: boolean }>, calls: string[] = []) {
    const respond = (body: unknown, ok = true) => new Response(JSON.stringify(body), { status: ok ? 200 : 500 });
    const graphFetch = (async (url: string, init: RequestInit = {}) => {
      const u = new URL(url), method = init.method ?? "GET";
      calls.push(`${method} ${u.pathname}`);
      if (method === "PUT") { const id = `item-${items.size + 1}`; items.set(id, { path: "/drive/root:/quarantine", created: new Date(0).toISOString() }); return respond({ id }); }
      const id = decodeURIComponent(u.pathname.split("/items/")[1]!);
      const item = items.get(id);
      if (!item) return respond({}, false);
      if (method === "PATCH") { item.path = JSON.parse(String(init.body)).parentReference.path; return respond({ id }); }
      return respond({ id, createdDateTime: item.created, ...(item.malware ? { malware: { description: "Win.Test" } } : {}), parentReference: { path: item.path }, "@microsoft.graph.downloadUrl": `https://dl.example/${id}?sig=1` });
    }) as unknown as typeof fetch;
    return graphFetch;
  }
  const adapterWith = (items: Map<string, { path: string; created: string; malware?: boolean }>, nowMs: number) =>
    new SharePointStorageAdapter({ driveId: "d1", scanDwellSeconds: 120 }, { fetch: fakeGraph(items), token: async () => "t", now: () => nowMs });

  it("runs the same lifecycle: quarantine, an unknown verdict inside the dwell, clean after it, promote, then a signed URL", async () => {
    const items = new Map<string, { path: string; created: string }>();
    const early = adapterWith(items, 30_000), late = adapterWith(items, 300_000);
    const { externalItemId } = await early.putQuarantined({ key: "org/c/f", bytes: PDF, contentType: "application/pdf" });
    assert.equal((await early.scan(externalItemId)).state, "unknown", "absence of a flag inside the dwell is not proof");
    await assert.rejects(late.signedUrl(externalItemId, 60), /not available to serve/, "never from quarantine");
    assert.equal((await late.scan(externalItemId)).state, "clean");
    await late.promote(externalItemId);
    const signed = await late.signedUrl(externalItemId, 60);
    assert.match(signed.url, /^https:\/\/dl\.example\//);
    await late.deactivate(externalItemId);
    await assert.rejects(late.signedUrl(externalItemId, 60), /not available to serve/, "nor once withdrawn");
  });

  it("reads Microsoft 365's malware flag as infected, and a Graph failure as the store being unavailable", async () => {
    const items = new Map([["bad", { path: "/drive/root:/quarantine", created: new Date(0).toISOString(), malware: true }]]);
    assert.deepEqual(await adapterWith(items, 10_000_000).scan("bad"), { state: "infected", detail: "Win.Test" });
    await assert.rejects(adapterWith(new Map(), 0).scan("missing"), FileStorageUnavailableError);
  });

  it("is chosen by configuration and fails closed without it", () => {
    assert.throws(() => configuredStorageAdapter({}), FileStorageUnavailableError);
    assert.throws(() => configuredStorageAdapter({ NZI_FILE_STORAGE: "sharepoint" }), FileStorageUnavailableError);
    assert.throws(() => configuredStorageAdapter({ NZI_FILE_STORAGE: "local", NEXT_PUBLIC_APP_ENV: "production" }), FileStorageUnavailableError);
    assert.equal(configuredStorageAdapter({ NZI_FILE_STORAGE: "local" }).provider, "local");
    const sp = configuredStorageAdapter({ NZI_FILE_STORAGE: "sharepoint", NZI_SHAREPOINT_DRIVE_ID: "d", NZI_GRAPH_TENANT_ID: "t", NZI_GRAPH_CLIENT_ID: "c", NZI_GRAPH_CLIENT_SECRET: "s" });
    assert.equal(sp.provider, "sharepoint");
  });
});

describe("SharePoint / Graph / 365 are touched only inside their adapter", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, "../../..");
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    if (["node_modules", ".next", ".git", "tests", "migrations", "public"].includes(name)) return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
  // What only an adapter may say: Graph's host, its token host, the drive/item vocabulary and the Graph facets.
  const GRAPH = /graph\.microsoft\.com|login\.microsoftonline|@microsoft\.graph|driveId|\/drives\/|NZI_SHAREPOINT|NZI_GRAPH/;
  it("no file outside the SharePoint adapter (and the one factory that reads its config) names Graph", () => {
    const allowed = new Set(["packages/isolated-backend/src/fileStorage/sharepointAdapter.ts", "packages/isolated-backend/src/fileStorage/index.ts"]);
    const offenders = [...walk(join(root, "packages")), ...walk(join(root, "apps/console/app"))]
      .map((path) => relative(root, path).replaceAll("\\", "/"))
      .filter((path) => !allowed.has(path) && GRAPH.test(readFileSync(join(root, path), "utf8")));
    assert.deepEqual(offenders, []);
  });
});
