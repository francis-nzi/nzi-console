/**
 * Client-review loop S4, the portal review page's pure parts: which edits an "Update" sends, and how a save's outcome reads. Kept out of
 * the component so they are tested without a browser. The server holds every rule again (`portal.report.update`).
 */
export type ReviewEdit = { sectionKey: string; bodyHtml: string };

/** The drafts that differ from what the round holds - an unchanged section is not sent, and writes nothing. */
export function editsToSend(drafts: Readonly<Record<string, string>>, current: ReadonlyArray<{ key: string; bodyHtml: string }>): ReviewEdit[] {
  const held = new Map(current.map((element) => [element.key, element.bodyHtml]));
  return Object.entries(drafts).filter(([key, html]) => held.has(key) && html.trim() !== held.get(key)).map(([sectionKey, bodyHtml]) => ({ sectionKey, bodyHtml: bodyHtml.trim() }));
}

/** The confirmation after an Update: what was saved, by section title. */
export function savedMessage(changedSections: readonly string[], titleOf: (key: string) => string): string {
  if (changedSections.length === 0) return "Nothing had changed, so nothing was saved.";
  const names = changedSections.map(titleOf);
  return `Saved your changes to ${names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`}. The team can see what changed.`;
}

/** S5: shown before the client's Approve is sent - what the click does. */
export const APPROVE_NOTE = "This issues your sign-off to the team; the report is then locked for your edits.";

/** S5: Approve is pinned to the version on screen, so words changed but not yet sent (Update) would be left out of what is approved. */
export function approveBlockedReason(unsentSections: number): string | null {
  return unsentSections > 0 ? "Press Update to send your changes first, or discard them, then approve." : null;
}

/** S5: the message to the team - trimmed, 1 to 4,000 characters, the same bound the command holds. */
export function messageToSend(text: string): string | null {
  const body = text.trim();
  return body && body.length <= 4000 ? body : null;
}
