// Portal bulk import — a refused import names the row. The command reports a refused row as `rows[<index>].<field>`; the file's
// rows are shown by their number, so the message says which one ("Row 7: …"), and nothing was saved.
import type { BrowserCommandResult } from "@nzi/api-client";

export function importErrorText(result: BrowserCommandResult<unknown>, rowNumbers: readonly number[]): string {
  if (result.state === "success") return "";
  if (result.state !== "validation_failed") return result.message;
  const issue = result.issues[0];
  if (!issue) return result.message;
  const at = /^rows\[(\d+)\]\./.exec(issue.field);
  const row = at ? rowNumbers[Number(at[1])] : undefined;
  return row !== undefined ? `Row ${row}: ${issue.message} Nothing was saved.` : issue.message;
}
