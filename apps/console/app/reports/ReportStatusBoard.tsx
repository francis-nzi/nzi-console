"use client";

import { ReportRegisterView } from "./ReportRegisterView";

/**
 * R-ST1 (ruled): the report pipeline across the portfolio — every live CRP job at its derived stage, including the ones with no
 * report version yet, which show as their stage and never as zero. Read-only oversight: nothing here edits; each row links to
 * where the work is done.
 *
 * Track A: the register view the preparation picker shares — the same row, filters and link logic (`ReportRegisterView`).
 */
export function ReportStatusBoard() {
  return <ReportRegisterView mode="pipeline" />;
}
