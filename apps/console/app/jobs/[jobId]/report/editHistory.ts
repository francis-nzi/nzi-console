/**
 * The report studio's edit-history view (client-review loop S3), as pure functions: a section's narrative HTML as a line of plain text
 * (a figure token shows as its key in braces - the history stores no figure), and a one-line label for who did what.
 */
const ENTITIES: Array<[RegExp, string]> = [[/&nbsp;/g, " "], [/&lt;/g, "<"], [/&gt;/g, ">"], [/&quot;/g, "\""], [/&#0*39;|&apos;/g, "'"], [/&amp;/g, "&"]];

export function historyText(html: string): string {
  let text = html.replace(/<span\b[^>]*\bdata-token="([^"]*)"[^>]*>[\s\S]*?<\/span>/g, (_match, key: string) => `{${key}}`).replace(/<\/(p|li|h[1-6])>/g, " ").replace(/<[^>]*>/g, "");
  for (const [pattern, replacement] of ENTITIES) text = text.replace(pattern, replacement);
  return text.replace(/\s+/g, " ").trim();
}

export const EDIT_ACTION_LABEL: Record<"edit" | "amend" | "restore", string> = { edit: "edited", amend: "amended", restore: "restored" };

export function editHeadline(edit: { actorName: string | null; actorId: string; principal: "staff" | "portal"; action: "edit" | "amend" | "restore"; sectionKey: string }): string {
  const who = edit.actorName ?? edit.actorId;
  return `${who} (${edit.principal === "portal" ? "client" : "staff"}) ${EDIT_ACTION_LABEL[edit.action]} ${edit.sectionKey}`;
}
