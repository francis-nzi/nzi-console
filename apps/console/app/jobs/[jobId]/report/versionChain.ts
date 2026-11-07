/**
 * Client-review loop S7, the version chain's pure parts: how a round is named and what the restore says. Kept out of the component so they
 * are tested without a browser; the server holds every rule again (`report.restoreVersion`).
 */
const STATUS_WORDS: Record<string, string> = {
  validated: "validated", in_client_review: "open for the client's review", client_approved: "approved by the client", published: "issued", superseded: "replaced by a later round",
};

export function chainLabel(entry: { revision: number; status: string; current: boolean }): string {
  return `Round ${entry.revision} · ${STATUS_WORDS[entry.status] ?? entry.status}${entry.current ? " (this version)" : ""}`;
}

/** Shown before a restore is sent: what changes and what does not. */
export const RESTORE_NOTE = (revision: number): string =>
  `This brings the wording of round ${revision} into this version, section by section. The sections and every figure stay as they are, and the change is recorded in the edit history.`;

export function restoredMessage(changedSections: readonly string[], fromRevision: number): string {
  if (changedSections.length === 0) return `Nothing to restore - this version already says what round ${fromRevision} said.`;
  return `Restored the wording of ${changedSections.length} section${changedSections.length === 1 ? "" : "s"} from round ${fromRevision}. The edit history shows what changed.`;
}
