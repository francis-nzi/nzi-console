import type { BrowserCommandResult } from "@nzi/api-client";

/**
 * What a command's result means to the person who pressed the button (admin D1 fast-follow): a save must always say what
 * happened, beside the button — never a silent click that looks like nothing, or like a duplicate.
 */
export type ActionStatus = { kind: "saving" | "saved" | "nochange" | "conflict" | "error"; text: string };
type Refused = Exclude<BrowserCommandResult<unknown>, { state: "success" }>;

export function statusOf(result: Refused, what: string): ActionStatus {
  if (result.state === "validation_failed" && result.issues.some((issue) => issue.code === "NO_CHANGE")) return { kind: "nochange", text: "No changes to save." };
  if (result.state === "conflict") return { kind: "conflict", text: `The ${what} changed since you opened it. Reload to see the latest, then make your change again.` };
  if (result.state === "validation_failed") return { kind: "error", text: result.issues.map((issue) => issue.message)[0] ?? "Check the highlighted fields." };
  return { kind: "error", text: result.message };
}

/** Field-level messages for the form, leaving out "nothing to change", which is not about any one field. */
export const fieldIssues = (result: Refused): Record<string, string> =>
  result.state === "validation_failed" ? Object.fromEntries(result.issues.filter((issue) => issue.code !== "NO_CHANGE").map((issue) => [issue.field, issue.message])) : {};
