import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The Jobs list chrome and the Create-job form (redesign Part 1, Tasks B and C).
 *
 * Asserted on the source, because two of the three acceptance criteria are **absences** — the dark
 * command band is gone, the ✓ trust pills are gone, the "official number is assigned only when
 * creation commits" line is gone — and an absence is what a rendering test is least likely to
 * notice. Exact strings rather than patterns wherever the subject contains `.`, `(` or `|`.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
/** Code lines only, one at a time — a comment explaining a removal is not the removal. */
const codeLines = (path: string) => read(path).split("\n").filter((line) => {
  const trimmed = line.trim();
  return trimmed !== "" && !trimmed.startsWith("//") && !trimmed.startsWith("*")
    && !trimmed.startsWith("/*") && !trimmed.startsWith("{/*");
});
const jobsCode = () => codeLines("apps/console/app/jobs/JobsIndex.tsx").join("\n");

describe("the jobs list opens on the work", () => {
  it("no longer renders the dark command band or its trust pills", () => {
    const code = jobsCode();
    assert.ok(!code.includes("nz-ops-hero"), "the NZI delivery command band is gone");
    assert.ok(!code.includes("nz-ops-trust"), "the ✓ pills are gone");
    assert.ok(!code.includes("Official numbering"), "and the claims they carried with them");
  });

  it("leaves the band on the boards that still use it", () => {
    // Part 1 removes it from Jobs only. Five other boards render the same pattern, and silently
    // deleting the shared style would take them with it.
    assert.ok(read("packages/ui/src/styles.css").includes("nz-ops-hero"), "the style stays for the others");
    assert.ok(read("apps/console/app/clients/ClientsBoard.tsx").includes("nz-ops-hero"), "Clients still uses it");
  });

  it("keeps all four stat tiles, which were never the problem", () => {
    const tiles = jobsCode().match(/<Metric label=/g) ?? [];
    assert.equal(tiles.length, 4, "four tiles, unchanged");
    for (const label of ["Active jobs", "Carbon reporting", "Average progress", "Due within 30 days"]) {
      assert.ok(jobsCode().includes(label), `${label} survives`);
    }
  });

  it("opens the editor with a button that says New job", () => {
    assert.ok(jobsCode().includes("+ New job"));
  });
});

describe("the create-job form asks about the job, then its dates", () => {
  it("is two blocks, each with a legend", () => {
    const code = jobsCode();
    assert.equal((code.match(/nz-job-block/g) ?? []).length, 2, "About the job, and Dates");
    assert.ok(code.includes("<legend>About the job</legend>"));
    assert.ok(code.includes("<legend>Dates</legend>"));
  });

  it("carries the four dates the brief names, in the words the consultant reads", () => {
    const code = jobsCode();
    for (const [field, label] of [["startDate", "Job start"], ["dueDate", "Job end"],
      ["reportingPeriodStart", "Reporting period start"], ["reportingPeriodEnd", "Reporting period end"]] as const) {
      assert.ok(code.includes(`dateField("${field}", "${label}")`), `${label} is on the form`);
    }
  });

  it("derives the reporting year and never offers it for typing", () => {
    const code = jobsCode();
    assert.ok(code.includes("reportingYearForPeriod(draft.reportingPeriodEnd)"), "derived from the period end");
    assert.ok(code.includes(`value={reportingYear ?? "—"}`), "and shown, with an honest blank before it can be known");
    assert.ok(!code.includes(`type="number"`), "no year input remains");
    // The old field was a number input bounded 2000–2200; its absence is the acceptance criterion.
    assert.ok(!code.includes(`max="2200"`));
  });

  it("picks the client manager from the roster, not from free text", () => {
    const code = jobsCode();
    assert.ok(code.includes(`<SmartSearch label="Client manager"`), "the same component Part 2 used");
    assert.ok(code.includes("useTeamOptions"), "and the same roster");
    assert.ok(!code.includes(">Owner<"), "Owner is no longer a field on this form");
  });

  it("defaults the manager from the client and then leaves it alone", () => {
    // Fill-blank-only, matching the Add-client owner default: choosing a manager and then changing
    // the client must not reach back and undo the choice.
    const code = jobsCode();
    assert.ok(code.includes("client.profile.clientManagerUserId"), "defaulted from the client's own");
    assert.ok(code.includes(`current.owner.trim() !== "" || current.clientManagerUserId`), "never overwrites a choice");
  });

  it("records the manager's id beside their name", () => {
    // The id is what a later rename on the roster reaches; the name is what survives if they leave.
    assert.ok(jobsCode().includes("clientManagerUserId: id || null, owner: option?.label ?? \"\""));
  });

  it("drops the numbering explainer while keeping the behaviour", () => {
    const code = jobsCode();
    assert.ok(!code.includes("abandoned drafts never create gaps"), "the copy is gone");
    assert.ok(code.includes("Number pending"), "the pending badge stays");
    assert.ok(code.includes("Create and assign number"), "assign-on-commit is unchanged");
  });
});

describe("the form checks the dates before it asks the server to", () => {
  it("calls the same shared rules the command runs", () => {
    assert.ok(jobsCode().includes("jobDateIssues(draft)"), "one implementation, both sides");
  });

  it("puts each complaint beside its own field", () => {
    const code = jobsCode();
    assert.ok(code.includes("aria-invalid"), "the invalid control says so");
    assert.ok(code.includes(`role="alert"`), "and the message is announced");
    assert.ok(code.includes("aria-describedby={describedBy}"), "and is tied to the input");
  });

  it("bounds the native picker to the same window, as a courtesy not a guard", () => {
    const code = jobsCode();
    assert.ok(code.includes("min={`${yearMin}-01-01`}"));
    assert.ok(code.includes("max={`${yearMax}-12-31`}"));
    assert.ok(code.includes("plausibleYearRange()"), "the bounds come from the shared rule");
  });

  it("shows the server's own issues per field when it refuses", () => {
    // The server is the real guard; when it disagrees the consultant should see where, not a
    // banner naming one of four problems.
    assert.ok(jobsCode().includes(`result.state === "validation_failed"`));
    assert.ok(jobsCode().includes("result.issues.map((issue) => [issue.field, issue.message])"));
  });
});
