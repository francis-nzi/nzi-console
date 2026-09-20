import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normaliseSubjectEmail, planSubjectLinks, reviewFingerprint,
  type LinkableRow, type SupersededEmail,
} from "../src/dataSubjects";

/**
 * The linking rules (NZC-116).
 *
 * The population here mirrors the one the linkage probe found on staging — mostly singletons, one
 * deterministic cross-table link, one genuinely ambiguous name, and rows with no address at all —
 * plus the history-only case, which the probe could **not** exercise because `trainees` was empty
 * when it ran. That class is therefore tested only here, against data we invented, and is carried
 * as a go-live caveat rather than treated as verified.
 */

const row = (sourceTable: LinkableRow["sourceTable"], sourceId: string, email: string | null, name: string | null): LinkableRow =>
  ({ sourceTable, sourceId, email, name });

const fingerprints = (plan: ReturnType<typeof planSubjectLinks>) =>
  plan.reviews.map((review) => reviewFingerprint(review.reason, review.members)).sort();

test("one address across three tables is one person, no question asked", () => {
  const plan = planSubjectLinks([
    row("trainees", "t-1", "ada@example.test", "Ada Lovelace"),
    row("client_contacts", "c-1", " Ada@Example.test ", "Ada Lovelace"),
    row("portal_users", "p-1", "ada@example.test", "Ada Lovelace"),
  ]);
  assert.equal(plan.links.length, 1);
  assert.equal(plan.links[0]!.method, "deterministic-email");
  assert.deepEqual(plan.links[0]!.members.map((m) => m.sourceId).sort(), ["c-1", "p-1", "t-1"]);
  assert.deepEqual(plan.reviews, [], "nothing to ask");
});

test("casing and padding do not split a person in two", () => {
  // The reason normalisation is kept even where a population contains nothing it collapses: the
  // failure it prevents produces no error, just two subjects where there should be one.
  assert.equal(normaliseSubjectEmail(" A@X.test "), "a@x.test");
  assert.equal(normaliseSubjectEmail(""), null);
  assert.equal(normaliseSubjectEmail("   "), null);
  assert.equal(normaliseSubjectEmail(null), null);
});

test("a singleton is a subject, not a failure to link", () => {
  const plan = planSubjectLinks([row("trainees", "t-9", "solo@example.test", "Solo Person")]);
  assert.equal(plan.links.length, 1);
  assert.deepEqual(plan.links[0]!.members, [{ sourceTable: "trainees", sourceId: "t-9" }]);
  assert.deepEqual(plan.reviews, []);
});

test("a shared mailbox is a question, never a link", () => {
  // Two contacts behind `info@`. Fusing them would make one erasure take both people.
  const plan = planSubjectLinks([
    row("client_contacts", "c-2", "info@example.test", "Reception One"),
    row("client_contacts", "c-3", "info@example.test", "Reception Two"),
  ]);
  assert.deepEqual(plan.links, []);
  assert.equal(plan.reviews.length, 1);
  assert.equal(plan.reviews[0]!.reason, "shared-key");
  assert.equal(plan.reviews[0]!.members.length, 2);
});

test("a shared mailbox does not drag an unrelated table's row in with it", () => {
  // The whole group queues, including the portal user on the same address — deciding which of the
  // three people that portal login belongs to is exactly the judgement being asked for.
  const plan = planSubjectLinks([
    row("client_contacts", "c-2", "info@example.test", "Reception One"),
    row("client_contacts", "c-3", "info@example.test", "Reception Two"),
    row("portal_users", "p-2", "info@example.test", "Reception"),
  ]);
  assert.deepEqual(plan.links, []);
  assert.equal(plan.reviews[0]!.members.length, 3);
});

test("a row with no address gets a subject immediately, and a question for later", () => {
  // Without this it would be unerasable — a request with no handle to pull.
  const plan = planSubjectLinks([row("client_contacts", "c-6", "", "No Address")]);
  assert.equal(plan.links.length, 1);
  assert.equal(plan.links[0]!.method, "unlinked-no-key");
  assert.equal(plan.reviews.length, 1);
  assert.equal(plan.reviews[0]!.reason, "no-key");
});

test("one name under two addresses is suggested, never linked", () => {
  const plan = planSubjectLinks([
    row("trainees", "t-2", "grace@home.test", "Grace Hopper"),
    row("client_contacts", "c-4", "grace@work.test", "Grace Hopper"),
  ]);
  // Two subjects — one per address — and a question about whether they are one person.
  assert.equal(plan.links.length, 2);
  assert.ok(plan.links.every((link) => link.method === "deterministic-email"));
  assert.equal(plan.reviews.filter((review) => review.reason === "name-suggestion").length, 1);
});

test("a link that exists only through a superseded address is a question", () => {
  // Untested against real data: `trainees` was empty when the probe ran. Carried as a go-live
  // caveat — a production-representative check is required before the erasure path is relied on.
  const superseded: SupersededEmail[] = [
    { sourceTable: "trainees", sourceId: "t-3", oldEmail: "alan.old@example.test", newEmail: "alan.new@example.test" },
  ];
  const plan = planSubjectLinks([
    row("trainees", "t-3", "alan.new@example.test", "Alan Turing"),
    row("client_contacts", "c-5", "alan.old@example.test", "Alan Turing"),
  ], superseded);

  const history = plan.reviews.filter((review) => review.reason === "history-match");
  assert.equal(history.length, 1);
  assert.deepEqual(history[0]!.members.map((m) => m.sourceId).sort(), ["c-5", "t-3"]);
  // And it was not linked on the strength of the old address.
  assert.ok(plan.links.every((link) => link.members.length === 1), "two subjects until a human says otherwise");
});

test("a superseded address nobody else uses raises nothing", () => {
  const plan = planSubjectLinks(
    [row("trainees", "t-3", "alan.new@example.test", "Alan Turing")],
    [{ sourceTable: "trainees", sourceId: "t-3", oldEmail: "gone@example.test", newEmail: "alan.new@example.test" }],
  );
  assert.deepEqual(plan.reviews.filter((review) => review.reason === "history-match"), []);
});

test("the ambiguity classes overlap, and the plan reflects that rather than hiding it", () => {
  // Alan is both a history match and a repeated name. One row, two reasons — which is why the
  // counts must never be summed.
  const plan = planSubjectLinks(
    [row("trainees", "t-3", "alan.new@example.test", "Alan Turing"), row("client_contacts", "c-5", "alan.old@example.test", "Alan Turing")],
    [{ sourceTable: "trainees", sourceId: "t-3", oldEmail: "alan.old@example.test", newEmail: "alan.new@example.test" }],
  );
  assert.deepEqual([...new Set(plan.reviews.map((review) => review.reason))].sort(), ["history-match", "name-suggestion"]);
});

test("the plan does not depend on the order rows arrive in", () => {
  // A re-run proposes exactly what the last run proposed, which is what makes the linker safe to
  // run repeatedly and what lets a decision be recognised rather than re-asked.
  const rows = [
    row("trainees", "t-1", "ada@example.test", "Ada Lovelace"),
    row("client_contacts", "c-1", "ada@example.test", "Ada Lovelace"),
    row("client_contacts", "c-2", "info@example.test", "Reception One"),
    row("client_contacts", "c-3", "info@example.test", "Reception Two"),
    row("memberships", "m-1", "", "No Address"),
  ];
  const forwards = planSubjectLinks(rows);
  const backwards = planSubjectLinks([...rows].reverse());
  assert.deepEqual(fingerprints(backwards), fingerprints(forwards));
  assert.deepEqual(
    backwards.links.map((link) => link.members.map((m) => m.sourceId).join("+")).sort(),
    forwards.links.map((link) => link.members.map((m) => m.sourceId).join("+")).sort());
});

test("a fingerprint identifies the question, not the moment it was asked", () => {
  const a = reviewFingerprint("shared-key", [
    { sourceTable: "client_contacts", sourceId: "c-3" },
    { sourceTable: "client_contacts", sourceId: "c-2" },
  ]);
  const b = reviewFingerprint("shared-key", [
    { sourceTable: "client_contacts", sourceId: "c-2" },
    { sourceTable: "client_contacts", sourceId: "c-3" },
  ]);
  assert.equal(a, b, "member order is not part of the question");
  assert.notEqual(a, reviewFingerprint("name-suggestion", [
    { sourceTable: "client_contacts", sourceId: "c-2" },
    { sourceTable: "client_contacts", sourceId: "c-3" },
  ]), "the same rows for a different reason is a different question");
});

test("staff are subjects like anyone else", () => {
  // Confirmed by ruling: memberships describe employees, and an employee is a data subject.
  const plan = planSubjectLinks([
    row("memberships", "m-1", "someone@firm.test", "A Consultant"),
    row("trainees", "t-4", "someone@firm.test", "A Consultant"),
  ]);
  assert.equal(plan.links.length, 1);
  assert.deepEqual(plan.links[0]!.members.map((m) => m.sourceTable).sort(), ["memberships", "trainees"]);
});
