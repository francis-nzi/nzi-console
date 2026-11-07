// Client-review loop S8: is this issued report one the loop completed? `final_approved_at` (S1, D5) is stamped only by `report.finalApprove`
// - a report published by the direct path (J000663 and every report issued before the loop) has it NULL. The portal's issued-report view
// keys on that marker and nothing else. A read; it changes nothing.
import type { Queryable } from "./postgres";

export async function reportIsLoopFinal(db: Queryable, reportVersionId: string): Promise<boolean> {
  const row = (await db.query<{ done: boolean }>(
    `SELECT final_approved_at IS NOT NULL AS done FROM nzi_console.report_versions WHERE report_version_id = $1`, [reportVersionId])).rows[0];
  return row?.done === true;
}
