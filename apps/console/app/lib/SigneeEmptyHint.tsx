import React from "react";
import { SIGNEE_EMPTY_HOW, SIGNEE_EMPTY_LEAD, signeeContactsHref } from "./signeeHint";

/**
 * Shown by the report-signee picker only when the client genuinely has no report-signee contact (a failed or pending read says its own thing):
 * what is missing and where to add it. The contact form and its Report signee role already exist (contact.manage); this just points to them.
 */
export function SigneeEmptyHint({ clientId }: { clientId: string | null }) {
  return <span className="nz-hint" data-signee-empty-hint>{SIGNEE_EMPTY_LEAD} {SIGNEE_EMPTY_HOW}{clientId ? <> <a href={signeeContactsHref(clientId)}>Open the client&rsquo;s contacts</a></> : null}</span>;
}
