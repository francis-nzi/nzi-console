import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { hoursLabel, lastMonthOf, monthOf, periodLabel, quarterOf, weekOf } from "../app/time/timePeriods";

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

/**
 * Time (the approved mockup). PR A: three entry points (nav, per-job button, Job → Time), the Add entry form over My
 * time, and the activity's billable default in Admin → Lookups. PR B: Oversight, Payroll and Utilisation as reads for
 * the chosen period; money only where the read carries it; the capacity, budget and fee editors.
 */
describe("the Time surfaces", () => {
  it("judges periods as London days from the server's today — Monday weeks, calendar months and quarters, the month before", () => {
    assert.deepEqual(weekOf("2026-10-04"), { from: "2026-09-28", to: "2026-10-04" });
    assert.deepEqual(weekOf("2026-09-28"), { from: "2026-09-28", to: "2026-10-04" });
    assert.deepEqual(monthOf("2024-02-10"), { from: "2024-02-01", to: "2024-02-29" });
    assert.deepEqual(lastMonthOf("2026-01-15"), { from: "2025-12-01", to: "2025-12-31" });
    assert.deepEqual([quarterOf("2026-10-04"), quarterOf("2026-03-31"), quarterOf("2026-07-01")],
      [{ from: "2026-10-01", to: "2026-12-31" }, { from: "2026-01-01", to: "2026-03-31" }, { from: "2026-07-01", to: "2026-09-30" }]);
    assert.equal(periodLabel({ from: "2026-08-01", to: "2026-08-31" }), "1 Aug – 31 Aug 2026");
    assert.deepEqual([90, 45, 0, 465].map(hoursLabel), ["1.5", "0.75", "0", "7.75"]);
  });

  it("reaches Log time from the nav, from every job header, and from Job → Time", () => {
    assert.match(read("apps/console/app/lib/nav.ts"), /\{ id: "time", label: "Time", icon: "clock", href: "\/time" \}/);
    for (const workspace of ["CrpScopeWorkspace.tsx", "FamilyWorkspace.tsx", "lca/LcaWorkspace.tsx", "training/TrainingWorkspace.tsx"]) {
      assert.match(read(`apps/console/app/jobs/${workspace}`), /<LogTimeButton jobId=\{(job\.)?header\.id\} \/>/, workspace);
    }
    assert.match(read("apps/console/app/jobs/JobTimePanel.tsx"), /href=\{`\/time\?job=\$\{encodeURIComponent\(jobId\)\}`\}/);
    const page = read("apps/console/app/jobs/[jobId]/page.tsx");
    // The Time panel is built once and carried by every family's panels (and, behind `job-shell`, by the Time drawer).
    assert.match(page, /const timePanel = <JobTimePanel jobId=\{job\.header\.id\} writeEnabled=\{process\.env\.NZI_WRITE_API_ENABLED === "true"\} \/>;/);
    assert.match(page, /const panels = <>\{milestones\}\{timePanel\}<\/>;/);
    assert.equal(page.match(/milestones=\{panels\}/g)?.length, 4, "every family's page carries Job → Time");
  });

  it("logs through the command route, defaults billable from the activity until the person sets it, and states every read failure", () => {
    const board = read("apps/console/app/time/TimeBoard.tsx");
    assert.match(board, /postBrowserCommand\("\/api\/isolated\/time\/entries"/);
    assert.match(board, /billable: draft\.billableTouched \|\| !activity \? draft\.billable : activity\.billableDefault/);
    assert.match(board, /this is not "no time logged"/);
    assert.match(board, /Billed · locked/);
    // Ruled on review: no day still to come — the date pickers stop at the server's London today.
    assert.match(board, /type="date" value=\{draft\.workDate\} max=\{today\} required/);
    assert.match(board, /aria-label="Date" value=\{draft\.workDate\} max=\{today\}/);
    // My time is one's own hours: no money field is read or rendered there.
    assert.doesNotMatch(board, /costRate|chargeRate|cost_rate|charge_rate|fee_amount|feeAmount|sellPerHour|costPerHour|£/, "My time shows hours, never money");
  });

  it("puts Oversight, Payroll and Utilisation behind tabs that read the chosen period — and says when a read is refused", () => {
    const board = read("apps/console/app/time/TimeBoard.tsx");
    assert.match(board, /\["log", "Log time"\], \["oversight", "Oversight"\], \["payroll", "Payroll"\], \["utilisation", "Utilisation"\]/);
    assert.match(board, /\["quarter", "This quarter"\]/);
    for (const tab of ["<OversightTab period=\\{period\\} />", "<PayrollTab period=\\{period\\} />", "<UtilisationTab period=\\{period\\} writeEnabled=\\{writeEnabled\\} />"]) assert.match(board, new RegExp(tab));
    assert.doesNotMatch(board, /arrives with the next Time release/, "the PR A placeholders are gone");
    const reports = read("apps/console/app/time/TimeReports.tsx");
    assert.match(reports, /fetch\(`\/api\/isolated\/time\/\$\{path\}\?from=\$\{period\.from\}&to=\$\{period\.to\}`/);
    assert.match(reports, /if \(response\.status === 403\) return setLoad\(\{ state: "refused"/, "a refused read is said — never an empty team");
    assert.match(reports, /could not be read, so nothing is shown — this is not "no time"/);
    // Money only where the read carries it (finance.view); otherwise a column is absent, never a zero.
    assert.match(reports, /\{money \? <th className="num">Cost \/ fee<\/th> : null\}/);
    assert.match(reports, /\{moneyVisible \? <th className="num">Cost<\/th> : null\}/);
    assert.match(reports, /Rates in more than one currency are not summed into one figure/);
    // ⚑8: utilisation is capacity; the job measure is budget used.
    assert.match(reports, /Utilisation is logged hours against capacity/);
    assert.match(reports, /Budget used compares everything logged on a job to date/);
  });

  it("edits capacity, a job's budget and its fee only where the read says the reader may", () => {
    const reports = read("apps/console/app/time/TimeReports.tsx");
    assert.match(reports, /capacityEditable && writeEnabled \? <button/);
    assert.match(reports, /postBrowserCommand\(`\/api\/isolated\/staff\/\$\{encodeURIComponent\(person\.userId\)\}\/capacity`, \{ expectedVersion: person\.version, weeklyCapacityHours: hours \}/);
    const panel = read("apps/console/app/jobs/JobTimePanel.tsx");
    assert.match(panel, /summary\.editable\.budget && writeEnabled/);
    assert.match(panel, /canEditFee=\{summary\.editable\.fee && writeEnabled\}/);
    assert.match(panel, /path=\{`\/api\/isolated\/jobs\/\$\{encodeURIComponent\(summary\.jobId\)\}\/budget`\} field="budgetedHours" expectedVersion=\{summary\.jobVersion\}/);
    assert.match(panel, /path=\{`\/api\/isolated\/jobs\/\$\{encodeURIComponent\(summary\.jobId\)\}\/fee`\} field="feeAmount" expectedVersion=\{summary\.jobVersion\}/);
    // The job's money appears only when the read carries it.
    assert.match(panel, /\{summary\.money \? <JobMoney money=\{summary\.money\}/);
    assert.doesNotMatch(panel, /costRate|chargeRate|cost_rate|charge_rate|sellPerHour|costPerHour/, "no rate is read on the panel");
  });

  it("carries the billable default in Admin → Lookups: a toggle on the add form and the edit, and a column beside each activity", () => {
    const lookups = read("apps/console/app/admin/lookups/LookupsBoard.tsx");
    assert.match(lookups, /<Switch label="Billable by default"/);
    assert.match(lookups, /\.\.\.\(activity \? \{ billableDefault: draft\.billableDefault \} : \{\}\) \}, key\("create"\)\)/);
    assert.match(lookups, /\.\.\.\(activity \? \{ billableDefault: draft\.billableDefault \} : \{\}\) \}, key\("update"\)\)/);
    assert.match(lookups, /header: "Billable by default"/);
  });

  it("serves each read with the caller's own principal and no cache, and each write through its command", () => {
    const routes: Array<[string, RegExp]> = [
      ["time/entries/route.ts", /requireCommandPrincipal\(request, "time\.entry\.log"\)/],
      ["time/entries/[entryId]/route.ts", /requireCommandPrincipal\(request, "time\.entry\.edit"\)/],
      ["time/entries/[entryId]/void/route.ts", /requireCommandPrincipal\(request, "time\.entry\.void"\)/],
      ["time/entries/[entryId]/bill/route.ts", /requireCommandPrincipal\(request, "time\.entry\.bill"\)/],
      ["time/jobs/route.ts", /readLoggableJobs\(db, principal\)/],
      ["time/activities/route.ts", /readTimeActivities\(db, principal\)/],
      ["jobs/[jobId]/time/route.ts", /readJobTimeSummary\(db, principal, decodeURIComponent\(jobId\)\)/],
      ["time/oversight/route.ts", /readTimeOversight\(db, principal, parsed\.period\)/],
      ["time/payroll/route.ts", /readTimePayroll\(db, principal, parsed\.period\)/],
      ["time/utilisation/route.ts", /readTimeUtilisation\(db, principal, parsed\.period\)/],
      ["staff/[userId]/capacity/route.ts", /requireCommandPrincipal\(request, "staff\.capacity\.set"\)/],
      ["jobs/[jobId]/budget/route.ts", /requireCommandPrincipal\(request, "job\.budget\.set"\)/],
      ["jobs/[jobId]/fee/route.ts", /requireCommandPrincipal\(request, "job\.fee\.set"\)/],
    ];
    for (const [path, pattern] of routes) assert.match(read(`apps/console/app/api/isolated/${path}`), pattern, path);
    for (const path of ["time/oversight/route.ts", "time/payroll/route.ts", "time/utilisation/route.ts"]) {
      assert.match(read(`apps/console/app/api/isolated/${path}`), /"Cache-Control": "private, no-store"/, path);
    }
  });
});
