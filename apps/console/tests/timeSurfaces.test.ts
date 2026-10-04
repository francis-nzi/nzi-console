import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { hoursLabel, lastMonthOf, monthOf, periodLabel, weekOf } from "../app/time/timePeriods";

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

/**
 * Time, PR A (the approved mockup): three entry points (nav, per-job button, Job → Time), the Add entry form over My
 * time, honest PR B states for Oversight and Payroll, hours only on every surface, and the activity's billable
 * default beside it in Admin → Lookups.
 */
describe("the Time surfaces", () => {
  it("judges periods as London days from the server's today — Monday weeks, calendar months, the month before", () => {
    assert.deepEqual(weekOf("2026-10-04"), { from: "2026-09-28", to: "2026-10-04" });
    assert.deepEqual(weekOf("2026-09-28"), { from: "2026-09-28", to: "2026-10-04" });
    assert.deepEqual(monthOf("2024-02-10"), { from: "2024-02-01", to: "2024-02-29" });
    assert.deepEqual(lastMonthOf("2026-01-15"), { from: "2025-12-01", to: "2025-12-31" });
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
    assert.match(page, /const panels = <>\{milestones\}<JobTimePanel jobId=\{job\.header\.id\} \/><\/>;/);
    assert.equal(page.match(/milestones=\{panels\}/g)?.length, 4, "every family's page carries Job → Time");
  });

  it("logs through the command route, defaults billable from the activity until the person sets it, and states every read failure", () => {
    const board = read("apps/console/app/time/TimeBoard.tsx");
    assert.match(board, /postBrowserCommand\("\/api\/isolated\/time\/entries"/);
    assert.match(board, /billable: draft\.billableTouched \|\| !activity \? draft\.billable : activity\.billableDefault/);
    assert.match(board, /this is not "no time logged"/);
    assert.match(board, /Oversight arrives with the next Time release/);
    assert.match(board, /Billed · locked/);
    // Ruled on review: no day still to come — the date pickers stop at the server's London today.
    assert.match(board, /type="date" value=\{draft\.workDate\} max=\{today\} required/);
    assert.match(board, /aria-label="Date" value=\{draft\.workDate\} max=\{today\}/);
    for (const surface of ["apps/console/app/time/TimeBoard.tsx", "apps/console/app/jobs/JobTimePanel.tsx"]) {
      // No money field is read or rendered: the reads don't carry one, and nothing here asks for one.
      assert.doesNotMatch(read(surface), /costRate|chargeRate|cost_rate|charge_rate|fee_amount|feeAmount|sellPerHour|costPerHour|£/, `${surface} shows hours, never money`);
    }
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
    ];
    for (const [path, pattern] of routes) assert.match(read(`apps/console/app/api/isolated/${path}`), pattern, path);
  });
});
