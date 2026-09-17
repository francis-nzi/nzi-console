import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * One term, one meaning: a unit of delivery work is a **job** (redesign Part 1, Task A).
 *
 * The redesign brief lists the live platform's copy — "New engagement", "Active engagements",
 * "CRP engagements", "NEW GOVERNED ENGAGEMENT". None of those strings exist here; this console was
 * built saying "job" from the start, and the rename was almost entirely already true. What was left
 * was a single tile note reading "N total engagements" directly beneath a tile labelled "Open jobs",
 * which is the worst version of the problem: both words for one thing, side by side, in one glance.
 *
 * **The word is not banned — one of its two meanings is.** "Engagement" in the Spheres of Influence
 * sense is a different word that happens to be spelled the same: stakeholder engagement, the
 * qualitative participation data the portal action tracker carries. Sphere C is literally "Policy
 * and Public Engagement", with "Industry Engagement" and "Public Engagement and Empowerment" under
 * it, and the badge distinguishing engagement data from assured emissions is making exactly that
 * distinction. Renaming those to "job" would be nonsense.
 *
 * So this is an allowlist rather than a ban, and each entry carries its reason — otherwise the next
 * person to run the grep reads a legitimate term as a missed rename and "finishes" the job.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Where the word may still appear, and why. Anything else is a relapse. */
const KEPT: Record<string, string> = {
  "apps/console/app/portal/jobs/[jobId]/PortalActionTracker.tsx":
    "Spheres of Influence — stakeholder engagement, not a unit of work.",
  "packages/ui/src/styles.css":
    "`nz-engagement-badge` styles that tracker's badge; the surrounding comment names the same subsystem.",
};

const AREAS = ["apps/console/app", "packages/ui/src"];
const EXTENSIONS = [".ts", ".tsx", ".css"];

function surfaces(): string[] {
  return AREAS.flatMap((area) =>
    readdirSync(join(ROOT, area), { recursive: true, encoding: "utf8" })
      .filter((name) => EXTENSIONS.some((extension) => name.endsWith(extension)))
      .map((name) => `${area}/${name.split("\\").join("/")}`));
}

describe("a unit of delivery work is called a job", () => {
  it("scans the console and the design system", () => {
    // A scanner with nothing to scan finds nothing wrong, which reads as safety it never checked.
    assert.ok(surfaces().length > 50, `expected the console's screens, found ${surfaces().length}`);
  });

  it("says 'engagement' only where it means stakeholder engagement", () => {
    const relapses = surfaces().filter((path) =>
      !(path in KEPT) && readFileSync(join(ROOT, path), "utf8").toLowerCase().includes("engagement"));
    assert.deepEqual(relapses, [],
      `these call a job an engagement:\n  ${relapses.join("\n  ")}`);
  });

  it("keeps the allowlist honest — an entry that no longer applies is removed", () => {
    // An allowlist nobody prunes stops being a list of exceptions and becomes a list of permissions.
    for (const [path, reason] of Object.entries(KEPT)) {
      assert.ok(readFileSync(join(ROOT, path), "utf8").toLowerCase().includes("engagement"),
        `${path} no longer says 'engagement' — delete its entry (${reason})`);
    }
  });

  it("still calls the jobs list a jobs list in its own class names", () => {
    // Not user-facing, so not strictly Task A, but a reader landing in the Jobs page's markup and
    // finding `nz-engagement-table` learns the wrong word for the thing they are looking at.
    const jobs = readFileSync(join(ROOT, "apps/console/app/jobs/JobsIndex.tsx"), "utf8");
    assert.ok(jobs.includes("nz-job-table"), "the jobs table's class names the jobs table");
  });
});
