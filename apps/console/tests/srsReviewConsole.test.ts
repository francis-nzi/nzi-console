import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * The SRS review loop (Phase A) in the console and the worker's service: the review date is changed only through the gated,
 * audited command; the SRS area says when the next review is and what its reminder will do; the worker reports the scan as
 * counts, never people.
 */
const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(join(here, "..", path), "utf8");
const repo = (path: string) => readFileSync(join(here, "..", "..", "..", path), "utf8");
const route = read("app/api/isolated/srs-assessments/[assessmentId]/review/route.ts");
const line = read("app/clients/[clientId]/SrsReviewLine.tsx");
const area = read("app/clients/[clientId]/SrsArea.tsx");
const worker = repo("packages/isolated-backend/scripts/reminder-worker.ts");

describe("the review date in the SRS area", () => {
  it("is written only through srs.assessment.review.set, carrying the assessment's version", () => {
    assert.match(route, /requireCommandPrincipal\(request, "srs\.assessment\.review\.set"\)/);
    assert.match(route, /setSrsReviewSchedule\(isolatedPool\(\)/);
    assert.match(line, /putBrowserCommand<[^>]*>\(`\/api\/isolated\/srs-assessments\/\$\{encodeURIComponent\(review\.assessmentId\)\}\/review`/);
    assert.match(line, /expectedVersion: review\.version/);
    assert.match(line, /GatedButton/);
  });

  it("shows the next review and what the reminder will do, on the latest completed assessment only", () => {
    assert.match(area, /workspace\.srs\.review && workspace\.srs\.review\.assessmentId === current\.assessmentId/);
    assert.match(line, /srsReviewReminderLabel\(review\.reminder\)/);
  });

  it("reviewing is the existing reopen and reassess — the line adds no edit path to the assessment", () => {
    assert.doesNotMatch(line, /srs-assessments\/\$\{[^}]+\}`/);
    assert.match(area, /Reopen to correct/);
  });
});

describe("the worker", () => {
  it("logs the SRS review scan as counts beside the other parts", () => {
    assert.match(worker, /srsReviewReminders: srsReviewReminders\.ok \? srsReviewReminders\.summary : \{ failed: srsReviewReminders\.error \}/);
  });
});
