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
    // The component and its name, not the order its props happen to be written in — adding an
    // `id` before `label` is not a change this test is about.
    assert.ok(code.includes("<SmartSearch"), "the same component Part 2 used");
    assert.match(code, /<SmartSearch[^>]*label="Client manager"/, "and it is the client manager");
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
  it("calls the same shared rules the command runs, told the same family", () => {
    // The family decides which dates are required, so passing it is what keeps the form and the
    // command agreeing about a training job — not just about what a plausible date is.
    assert.ok(jobsCode().includes("jobDateIssues(draft, { family: draft.family })"), "one implementation, both sides");
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

describe("only a reporting family is asked for a period", () => {
  it("gates the period fields on the shared predicate, not a literal", () => {
    // A `family === "crp"` here would be a fourth place to change the day a second family starts
    // reporting, and the one most likely to be missed because it looks like presentation.
    const code = jobsCode();
    assert.ok(code.includes("familyHasReportingPeriod(draft.family)"), "the form asks the predicate");
    assert.ok(code.includes("{hasPeriod ? <>"), "and hides the block when it says no");
    // Exactly one literal may remain, and it must be the stat tile — a count of CRP jobs is
    // genuinely about CRP, not about whether a family reports on a period. Identified by what it
    // is rather than by a character offset, so reformatting the line does not fail this.
    const literal = code.split("\n").filter((line) => line.includes(`family === "crp"`));
    assert.equal(literal.length, 1, `expected one remaining literal, found:\n  ${literal.join("\n  ")}`);
    assert.ok(literal[0]!.includes("activeCrp"), `the survivor must be the stat tile, not: ${literal[0]!.trim()}`);
  });

  it("clears a period already typed when the family stops needing one", () => {
    // Otherwise a consultant who fills in a CRP period and then switches to Training submits a
    // period the job does not have, and the row carries a window nothing reports against.
    assert.ok(jobsCode().includes("reportingPeriodStart: null, reportingPeriodEnd: null"),
      "switching away from a reporting family drops the period");
  });

  it("keeps the derived year beside the period it is derived from", () => {
    // The label belongs to the period; when there is no period there is no label to show.
    const code = jobsCode();
    const block = code.slice(code.indexOf("{hasPeriod ? <>"), code.indexOf("</> : null}"));
    assert.ok(block.includes("Reporting year"), "the year sits inside the gated block");
    assert.ok(block.includes("reportingPeriodEnd"), "beside the date it comes from");
  });
});
