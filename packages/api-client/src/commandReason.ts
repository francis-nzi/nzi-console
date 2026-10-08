/**
 * A command's reason travels in a header (`x-command-reason`), and HTTP headers carry ISO-8859-1 only: a browser's `fetch`
 * throws before sending a reason with a curly quote, an em dash, `€`, a non-Latin name or an emoji. So the reason travels
 * percent-encoded and says so (`x-command-reason-encoding: uri`), and the server decodes it with the one reader below —
 * the same reason, byte for byte, in the audit (RULING-command-reason-encoding, 8 Oct 2026).
 *
 * Both halves live here so the encoding has one definition. A request without the marker is read as it always was, so a
 * caller still sending a raw (Latin-1) reason keeps working.
 */
export const COMMAND_REASON_HEADER = "x-command-reason";
export const COMMAND_REASON_ENCODING_HEADER = "x-command-reason-encoding";

/** The headers that carry a reason: none for an empty one. Trimmed first, as the reason always has been. */
export function commandReasonHeaders(reason: string | undefined): Record<string, string> {
  const trimmed = reason?.trim();
  return trimmed ? { [COMMAND_REASON_HEADER]: encodeURIComponent(trimmed), [COMMAND_REASON_ENCODING_HEADER]: "uri" } : {};
}

/** A reason header marked as encoded that does not decode — sent malformed, not a reason to store. */
export class CommandReasonEncodingError extends Error {
  constructor() { super("The reason could not be read — send it again."); this.name = "CommandReasonEncodingError"; }
}

/** The reason a request carries, decoded when it says it is encoded, trimmed; undefined when there is none. */
export function commandReason(headers: { get(name: string): string | null }): string | undefined {
  const raw = headers.get(COMMAND_REASON_HEADER);
  if (raw == null) return undefined;
  let value = raw;
  if (headers.get(COMMAND_REASON_ENCODING_HEADER)?.trim().toLowerCase() === "uri") {
    try { value = decodeURIComponent(raw); } catch { throw new CommandReasonEncodingError(); }
  }
  return value.trim() || undefined;
}
