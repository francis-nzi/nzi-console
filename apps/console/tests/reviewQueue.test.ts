import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { reportStageLabels } from "@nzi/contracts";

// Client-review loop S6: the CRM's queue on the Control Room panel and the inbox's action filter - staff-side, derived, read-only.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("the CRM's review queue (S6)", () => {
  it("the Control Room's Client review inbox panel shows a real count, from the register - not a static line", () => {
    const page = read("../app/page.tsx");
    assert.match(page, /<ReviewQueueCount\/>/);
    assert.doesNotMatch(page, /Review client questions, approvals and published report status from one place\./, "the static copy is gone");
    const panel = read("../app/ReviewQueueCount.tsx");
    assert.match(panel, /\/api\/isolated\/report-status/, "the same read the Reports page uses");
    assert.match(panel, /crmQueue\(/);
    assert.match(panel, /data-review-queue="failed"/, "a failed read says so");
    assert.match(panel, /queue === null/, "and shows no number");
    assert.doesNotMatch(panel, /method:\s*["'](POST|PUT|PATCH|DELETE)|postBrowserCommand/, "read-only: no write");
  });
  it("the new stages are labelled for the team and styled on the register", () => {
    assert.equal(reportStageLabels["client-responded"], "Client responded — review needed");
    assert.equal(reportStageLabels["awaiting-final-approval"], "Awaiting final approval");
    const register = read("../app/reports/ReportRegisterView.tsx");
    assert.match(register, /"client-responded": "nof"/);
    assert.match(register, /"awaiting-final-approval": "need"/);
  });
  it("the inbox's Action needed filter is the team's turn - a client who responded, an approved round, a message to answer - not a round awaiting the client", () => {
    const inbox = read("../app/reports/ReportReviewInbox.tsx");
    assert.match(inbox, /filter==="action"&&\(thread\.crmTurn\|\|thread\.needsReply\|\|\(thread\.status==="published"&&thread\.awaitingApproval\)\)/);
  });
});
