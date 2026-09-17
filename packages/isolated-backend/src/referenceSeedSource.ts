import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReferenceValueInput, TeamMemberInput } from "./referenceData";

/**
 * The seed lists, read from `docs/_seed_reference_data.md` (NZC-089).
 *
 * The live Import/Export routine does not exist, so the curated lists were transcribed from the
 * live admin by hand. That document **is** the source — this parses it rather than restating it in
 * TypeScript, because two copies of a hand-transcribed list is exactly the drift the project's
 * "don't leave two divergent copies" rule is about: Francis corrects the document, the importer
 * follows, and nothing has to be kept in step by memory.
 *
 * The parse is deliberately narrow. It reads the fenced `csv` blocks in document order and fails
 * loudly on anything it does not recognise, because a silently mis-parsed list would seed a
 * plausible-looking half of the firm's reference data.
 */

const SEED_DOC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs", "_seed_reference_data.md");

/**
 * A live test account, excluded from the roster by default.
 *
 * Named here rather than filtered by a guess at what a test account looks like: a rule matching
 * "test" in an address would one day exclude a real person, and a list of one is honest about how
 * much judgement is being applied.
 */
export const EXCLUDED_TEAM_EMAILS = ["teastadmin@netzero.international"] as const;

export type SeedLists = {
  industries: ReferenceValueInput[];
  referrals: ReferenceValueInput[];
  /** Everyone legible in the live admin, before exclusions. */
  team: Array<TeamMemberInput & { role: string; position: string; status: string }>;
  /** Those held back, and why — reported rather than quietly dropped. */
  excluded: Array<{ displayName: string; email: string; reason: string }>;
};

function csvBlocks(text: string): string[][] {
  return [...text.matchAll(/```csv\n([\s\S]*?)```/g)]
    .map((match) => match[1]!.trim().split("\n").map((line) => line.trim()).filter((line) => line !== ""));
}

/** Split on commas, tolerating the trailing empty fields the transcription leaves for `nan`. */
const cells = (line: string) => line.split(",").map((cell) => cell.trim());

export function readSeedLists(path: string = SEED_DOC): SeedLists {
  const blocks = csvBlocks(readFileSync(path, "utf8"));
  if (blocks.length !== 3) {
    throw new Error(`Expected three csv blocks in ${path} (industries, referrals, team); found ${blocks.length}.`);
  }
  const [industryBlock, referralBlock, teamBlock] = blocks as [string[], string[], string[]];

  const names = (block: string[], what: string): ReferenceValueInput[] => {
    if (block[0] !== "name") throw new Error(`Expected a "name" header on the ${what} block, found "${block[0]}".`);
    return block.slice(1).map((label, index) => ({
      label,
      // The live list carries no identity of its own, so the name is the reconcile key. A rename
      // in the document therefore reads as a new value — correct, because there is nothing else
      // to recognise it by, and safer than guessing at an identity live never gave us.
      sourceRef: null,
      // **No SIC codes exist in live.** Seeding a null is the honest answer; inventing one would
      // put a wrong code on a client's record, which is the class of reporting error this
      // redesign exists to remove. The industry→SIC auto-fill stays off until they are curated.
      code: null,
      sortOrder: index,
    }));
  };

  if (teamBlock[0] !== "display_name,email,role,position,status") {
    throw new Error(`Unexpected team header: "${teamBlock[0]}".`);
  }

  const team: SeedLists["team"] = [];
  const excluded: SeedLists["excluded"] = [];
  for (const line of teamBlock.slice(1)) {
    const [displayName, email, role, position, status] = cells(line);
    if (!displayName || !email) throw new Error(`Team row is missing a name or email: "${line}".`);
    const normalisedEmail = email.toLowerCase();
    if ((EXCLUDED_TEAM_EMAILS as readonly string[]).includes(normalisedEmail)) {
      excluded.push({ displayName, email: normalisedEmail, reason: "live test account" });
      continue;
    }
    team.push({
      // Derived from the address, which is the only stable identity the transcription carries.
      userId: normalisedEmail.split("@")[0]!,
      displayName,
      email: normalisedEmail,
      role: role ?? "",
      // "nan" in the live UI means not set; the transcription leaves it blank.
      position: position ?? "",
      status: status ?? "",
    });
  }

  return { industries: names(industryBlock, "industries"), referrals: names(referralBlock, "referrals"), team, excluded };
}
