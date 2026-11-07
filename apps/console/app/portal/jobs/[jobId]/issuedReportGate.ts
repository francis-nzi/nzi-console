/**
 * Client-review loop S8, the portal's issued-report presentation gate. A report the loop completed (its version carries `final_approved_at`,
 * so the route says `finalApproved: true`) is shown read-only as the issued document with a way to save it as a PDF, and none of the review
 * controls (the old approval card, the review thread). Anything else - `false`, absent, malformed - is the view as it has always been:
 * a report published by the direct path (J000663) is untouched. The gate reads the marker and nothing else.
 */
export type IssuedFinal = { printHref: string };

export const issuedFinalOf = (body: object, printHref: string): IssuedFinal | null =>
  (body as { finalApproved?: unknown }).finalApproved === true ? { printHref } : null;

export const ISSUED_FINAL_TITLE = "Issued report";
export const ISSUED_FINAL_NOTE = "This report has been approved and issued, so it is locked. Save it as a PDF to keep a copy; message the team if you need anything changed.";
export const DOWNLOAD_PDF_LABEL = "Download PDF";
