/**
 * Deciding which rows are one person — and, more often, declining to (NZC-116).
 *
 * The erasure workstream needs a subject to key a per-subject encryption key on, and the four
 * person-shaped tables have no common identifier. This is the rule that derives one: exact equality
 * of a normalised email address, and nothing else. Every other resemblance is a question for a
 * human, because a wrong link here fuses two people into one erasure.
 *
 * Pure and pointer-only. It is handed rows, not personal records, and returns decisions about
 * `(sourceTable, sourceId)` pairs. Nothing here stores anything, and nothing here holds a name.
 */

/** The four tables that describe a person. Named, because they share no key — hence this file. */
export const SUBJECT_SOURCES = ["trainees", "client_contacts", "portal_users", "memberships"] as const;
export type SubjectSource = (typeof SUBJECT_SOURCES)[number];

/** A pointer to one person-row. The unit this entire subsystem deals in. */
export type SourceRef = { sourceTable: SubjectSource; sourceId: string };

/** What the linker is given: a pointer, plus the two fields it is allowed to look at. */
export type LinkableRow = SourceRef & {
  /** As stored. Normalised here rather than by the caller, so one rule applies everywhere. */
  email: string | null;
  /** Used only to *suggest* a review. Never to link: a name is not a key. */
  name: string | null;
};

/** A superseded address, and the row it belonged to. */
export type SupersededEmail = { sourceTable: SubjectSource; sourceId: string; oldEmail: string; newEmail: string };

export type ReviewReason = "shared-key" | "history-match" | "name-suggestion" | "no-key";

/** Rows the linker will join without asking. */
export type AutoLink = { members: SourceRef[]; method: "deterministic-email" | "unlinked-no-key" };

/** Rows a human must rule on, and why. */
export type ReviewCandidate = { reason: ReviewReason; members: SourceRef[] };

export type LinkPlan = { links: AutoLink[]; reviews: ReviewCandidate[] };

/**
 * One normalisation, used everywhere.
 *
 * Kept even where a population contains nothing it would collapse. It costs nothing, and the day it
 * matters it matters silently: a single mixed-case address would split one person into two subjects
 * and nothing would report it. The same argument as the shared date helpers — insurance against a
 * failure that produces no error.
 */
export const normaliseSubjectEmail = (email: string | null | undefined): string | null => {
  const trimmed = String(email ?? "").trim().toLowerCase();
  return trimmed === "" ? null : trimmed;
};

const key = (ref: SourceRef) => `${ref.sourceTable}:${ref.sourceId}`;
const asRef = (row: LinkableRow): SourceRef => ({ sourceTable: row.sourceTable, sourceId: row.sourceId });
const byRef = (a: SourceRef, b: SourceRef) => key(a).localeCompare(key(b));

/**
 * The plan for one organisation's rows.
 *
 * Deterministic and order-independent: the same population produces the same plan whichever order
 * the rows arrive in, so a re-run proposes exactly what the last run proposed.
 */
export function planSubjectLinks(rows: readonly LinkableRow[], superseded: readonly SupersededEmail[] = []): LinkPlan {
  const links: AutoLink[] = [];
  const reviews: ReviewCandidate[] = [];

  // ── Rows with no address: a subject each, immediately ──────────────────────────────
  //
  // They cannot be matched on anything, and leaving them unlinked would leave those people
  // *unerasable* — a request with no handle to pull. So each becomes its own subject now, and is
  // raised as a question a human may answer later. Erasure works from the first run; merging is an
  // improvement, not a precondition.
  const withEmail: LinkableRow[] = [];
  for (const row of [...rows].sort(byRef)) {
    if (normaliseSubjectEmail(row.email) === null) {
      links.push({ members: [asRef(row)], method: "unlinked-no-key" });
      reviews.push({ reason: "no-key", members: [asRef(row)] });
    } else {
      withEmail.push(row);
    }
  }

  // ── Group by normalised address ────────────────────────────────────────────────────
  const groups = new Map<string, LinkableRow[]>();
  for (const row of withEmail) {
    const email = normaliseSubjectEmail(row.email)!;
    groups.set(email, [...(groups.get(email) ?? []), row]);
  }

  for (const [, members] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const perTable = new Map<SubjectSource, number>();
    for (const member of members) perTable.set(member.sourceTable, (perTable.get(member.sourceTable) ?? 0) + 1);
    const collides = [...perTable.values()].some((count) => count > 1);

    if (collides) {
      // A shared mailbox — `info@`, `accounts@` — with several people behind it. Fusing them would
      // be worse than leaving them apart, because one erasure would take all of them.
      reviews.push({ reason: "shared-key", members: members.map(asRef).sort(byRef) });
      continue;
    }
    links.push({ members: members.map(asRef).sort(byRef), method: "deterministic-email" });
  }

  // ── A link that exists only through an address somebody used to have ───────────────
  //
  // Never automatic. An address that has been given up may have been reassigned, or may never have
  // been that person's alone, and the row it matches is live.
  const liveByEmail = new Map<string, LinkableRow[]>();
  for (const row of withEmail) {
    const email = normaliseSubjectEmail(row.email)!;
    liveByEmail.set(email, [...(liveByEmail.get(email) ?? []), row]);
  }
  for (const change of [...superseded].sort((a, b) => a.oldEmail.localeCompare(b.oldEmail))) {
    const old = normaliseSubjectEmail(change.oldEmail);
    const current = normaliseSubjectEmail(change.newEmail);
    if (old === null || old === current) continue;
    const matches = (liveByEmail.get(old) ?? []).filter((row) => key(row) !== `${change.sourceTable}:${change.sourceId}`);
    if (matches.length === 0) continue;
    reviews.push({
      reason: "history-match",
      members: [{ sourceTable: change.sourceTable, sourceId: change.sourceId }, ...matches.map(asRef)].sort(byRef),
    });
  }

  // ── One name, several addresses ────────────────────────────────────────────────────
  //
  // A suggestion only, and it never becomes a link on its own: one person with a work and a home
  // address looks exactly like two people who share a common name.
  const byName = new Map<string, LinkableRow[]>();
  for (const row of withEmail) {
    const name = String(row.name ?? "").trim().toLowerCase();
    if (name === "") continue;
    byName.set(name, [...(byName.get(name) ?? []), row]);
  }
  for (const [, members] of [...byName].sort(([a], [b]) => a.localeCompare(b))) {
    const addresses = new Set(members.map((member) => normaliseSubjectEmail(member.email)));
    if (addresses.size > 1) {
      reviews.push({ reason: "name-suggestion", members: members.map(asRef).sort(byRef) });
    }
  }

  return { links, reviews };
}

/** A review's identity, so the same question is recognised rather than re-asked on every run. */
export const reviewFingerprint = (reason: ReviewReason, members: readonly SourceRef[]): string =>
  `${reason}|${[...members].sort(byRef).map(key).join(",")}`;
