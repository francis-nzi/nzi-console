// Which pull requests the auto-merge enabler leaves for a human (see .github/workflows/auto-merge.yml).
//
// Auto-merge only waits for the required checks. The ruling gate turns a check red for a migration or a hold/ branch, but it
// does not look at CI config, the gates themselves or the decision register — so a change to those would go green and merge itself.
// They are the files that decide what "green" means, so the enabler does not switch auto-merge on for a pull request that touches
// one: it is merged by hand, as before. Fail-safe: this narrows what merges itself, never widens it.
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const GOVERNED_PATHS = [
  ".github/",                       // workflows, including this one and the gates
  "scripts/ruling-",                // the ruling gate, verify and lock
  "scripts/auto-merge",             // this enabler
  "scripts/check-",                 // the checks CI requires
  "docs/DECISIONS.md",              // governance records are Francis's call
  "render.yaml",                    // what deploys, and with which flags
];

export const governedFiles = (changedFiles) => changedFiles.filter((file) => GOVERNED_PATHS.some((prefix) => file.startsWith(prefix)));

/** Enable auto-merge unless the pull request is a draft, from a fork, or touches a governed path. */
export function decide({ draft, fromFork, changedFiles }) {
  if (draft) return { enable: false, reason: "Draft: auto-merge waits until it is marked ready." };
  if (fromFork) return { enable: false, reason: "From a fork: never auto-merged." };
  const governed = governedFiles(changedFiles);
  if (governed.length) return { enable: false, reason: `Touches governed file(s) — merged by hand: ${governed.slice(0, 5).join(", ")}${governed.length > 5 ? ", …" : ""}.` };
  return { enable: true, reason: "Ungoverned and ready: auto-merge (squash) enabled; GitHub merges it when every required check passes." };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const env = process.env;
  const result = decide({ draft: env.DRAFT === "true", fromFork: env.HEAD_REPO !== env.BASE_REPO, changedFiles: (env.CHANGED_FILES ?? "").split("\n").filter(Boolean) });
  console.log(result.reason);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `enable=${result.enable}\n`);
}
