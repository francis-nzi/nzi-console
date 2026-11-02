import { PORTAL_FILE_MAX_BYTES, type PortalFileFlag, type PortalFileType } from "@nzi/contracts";

/**
 * What may be uploaded, decided from the bytes — never from the extension or the browser's declared type (BRIEF §2.3). Pure.
 *
 * Allowed: PDF, PNG, JPEG, CSV/plain text, and the three modern Office formats (docx, xlsx, pptx). Refused: executables of any kind,
 * anything that can carry a macro (the legacy OLE Office formats, and any Office file with a VBA project), scripts, archives and the
 * rest. Every client file is untrusted; this narrows what is accepted, and the quarantine gate is what guarantees nothing unscanned is served.
 */
export type SniffResult = { ok: true; contentType: PortalFileType } | { ok: false; flag: PortalFileFlag; detail: string };

const starts = (bytes: Uint8Array, ...sig: number[]) => sig.every((byte, index) => bytes[index] === byte);
const ascii = (bytes: Uint8Array, from: number, length: number) => String.fromCharCode(...bytes.subarray(from, from + length));
const refuse = (flag: PortalFileFlag, detail: string): SniffResult => ({ ok: false, flag, detail });

const EXECUTABLE_NAMES = /\.(exe|dll|bat|cmd|com|scr|msi|jar|js|jse|vbs|vbe|ps1|sh|app|apk|pif|lnk|hta|cpl)$/i;

/** Entry names from a ZIP's central directory (the authoritative list), or null if it is not a readable ZIP. */
export function zipEntryNames(bytes: Uint8Array): string[] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 22 - 65535); index -= 1) {
    if (view.getUint32(index, true) === 0x06054b50) { eocd = index; break; }
  }
  if (eocd < 0) return null;
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const names: string[] = [];
  for (let entry = 0; entry < count; entry += 1) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) return null;
    const nameLength = view.getUint16(offset + 28, true), extraLength = view.getUint16(offset + 30, true), commentLength = view.getUint16(offset + 32, true);
    if (offset + 46 + nameLength > bytes.length) return null;
    names.push(new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength)));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

function sniffOffice(bytes: Uint8Array): SniffResult {
  const names = zipEntryNames(bytes);
  if (!names) return refuse("type_not_allowed", "The file is a damaged or unreadable archive.");
  if (!names.includes("[Content_Types].xml")) return refuse("type_not_allowed", "Archives are not accepted; send the documents themselves.");
  if (names.some((name) => /vbaProject\.bin$/i.test(name) || /\.(xlsm|docm|pptm)$/i.test(name))) return refuse("macro", "The file contains macros.");
  if (names.some((name) => EXECUTABLE_NAMES.test(name))) return refuse("executable", "The file contains an executable.");
  if (names.some((name) => name.startsWith("word/"))) return { ok: true, contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
  if (names.some((name) => name.startsWith("xl/"))) return { ok: true, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
  if (names.some((name) => name.startsWith("ppt/"))) return { ok: true, contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" };
  return refuse("type_not_allowed", "That is not a Word, Excel or PowerPoint document.");
}

export function sniffUpload(bytes: Uint8Array, fileName: string, maxBytes = PORTAL_FILE_MAX_BYTES): SniffResult {
  if (bytes.length === 0) return refuse("empty", "The file is empty.");
  if (bytes.length > maxBytes) return refuse("oversize", `The file is larger than ${Math.floor(maxBytes / (1024 * 1024))} MB.`);
  if (starts(bytes, 0x4d, 0x5a) || starts(bytes, 0x7f, 0x45, 0x4c, 0x46) || starts(bytes, 0x23, 0x21) || starts(bytes, 0xca, 0xfe, 0xba, 0xbe)
    || starts(bytes, 0xcf, 0xfa, 0xed, 0xfe) || starts(bytes, 0xce, 0xfa, 0xed, 0xfe) || starts(bytes, 0xfe, 0xed, 0xfa, 0xce) || starts(bytes, 0xfe, 0xed, 0xfa, 0xcf)) {
    return refuse("executable", "Executable files are not accepted.");
  }
  if (ascii(bytes, 0, 1024).includes("%PDF-")) {
    const head = ascii(bytes, 0, Math.min(bytes.length, 5 * 1024 * 1024));
    if (/\/Launch\b/.test(head)) return refuse("executable", "The PDF can launch programs.");
    return { ok: true, contentType: "application/pdf" };
  }
  if (starts(bytes, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { ok: true, contentType: "image/png" };
  if (starts(bytes, 0xff, 0xd8, 0xff)) return { ok: true, contentType: "image/jpeg" };
  if (starts(bytes, 0x50, 0x4b, 0x03, 0x04) || starts(bytes, 0x50, 0x4b, 0x05, 0x06)) return sniffOffice(bytes);
  if (starts(bytes, 0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) return refuse("macro", "Older Office files can carry macros; save it as .docx, .xlsx or .pptx.");
  // Text: no NUL, valid UTF-8, and not markup that a browser would run.
  const sample = bytes.subarray(0, 64 * 1024);
  if (!sample.includes(0)) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(sample);
      if (/^\s*(<!doctype|<html|<script|<svg|<\?php|<\?xml)/i.test(text)) return refuse("type_not_allowed", "Web and markup files are not accepted.");
      return { ok: true, contentType: /\.csv$/i.test(fileName) ? "text/csv" : "text/plain" };
    } catch { /* not text */ }
  }
  return refuse("type_not_allowed", "That file type is not accepted. Send a PDF, image, spreadsheet, document or CSV.");
}
