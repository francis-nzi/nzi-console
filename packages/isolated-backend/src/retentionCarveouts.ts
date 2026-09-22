import { PII_COLUMNS, PII_TABLES } from "./piiInventory";

/**
 * What is kept despite an erasure request, and on whose authority (NZC-139, NZC-142).
 *
 * This file is **scaffold**. Every entry in it is pending a determination from data-protection counsel,
 * and says so in its own fields rather than in a comment. Nothing here claims a carve-out is justified;
 * it claims that a carve-out has been *asked about*, and it makes the asking visible to the erasure
 * command, the coverage invariant and the go-live gate.
 *
 * ## Why an empty-but-shaped file rather than nothing
 *
 * "We are waiting on counsel" is a state this system has to hold safely for weeks. Held as an absence it
 * behaves exactly like a decision to retain nothing — the erasure command shreds, reports success, and
 * the question is answered by default in whichever direction the code happened to lean. Held as an
 * explicit, enumerated, *blocking* state it behaves like a gap somebody still owes an answer for, which
 * is what it is. Same discipline as `awaiting-auth-bridge` and `NOT_RUN_IN_CI`: enumerated, visible,
 * green-but-listed, and it stops a claim of completeness rather than being silently absent from one.
 *
 * ## The rule that keeps it one source of truth
 *
 * A column classified `retain-with-basis` in the inventory **must** be covered by a carve-out here, and a
 * carve-out must name real tables and real columns. A retained column with no carve-out is a retention
 * nobody stated a basis for, which is the thing this exists to prevent; it is a test failure rather than
 * a convention.
 */

/**
 * The lawful grounds on which an erasure request can be refused in part.
 *
 * The four families the brief expects are named first. The rest of Article 17(3) is here too, deliberately
 * — a menu shortened to what we anticipate would ask counsel to pick from our guesses, and the point of
 * asking is that we do not know. Adding a family counsel names is a one-line change; having to widen the
 * type mid-determination is the failure mode this avoids.
 */
export type LawfulBasis =
  /** Art. 17(3)(b) — compliance with a legal obligation. */
  | "legal-obligation"
  /** Art. 17(3)(b) — employment, social security and social protection law. */
  | "employment-law"
  /** Art. 17(3)(e) — establishment, exercise or defence of legal claims. */
  | "legal-claims"
  /** Art. 6(1)(f) held against an Art. 21 objection, rather than an Art. 17(3) exemption as such. */
  | "legitimate-interests"
  /** Art. 17(3)(a) — freedom of expression and information. */
  | "freedom-of-expression"
  /** Art. 17(3)(b) — a task carried out in the public interest or official authority. */
  | "public-interest-task"
  /** Art. 17(3)(c) — public health. */
  | "public-health"
  /** Art. 17(3)(d) — archiving, scientific or historical research, statistics. */
  | "archiving-research-statistics"
  /** Not yet determined. The only honest value until counsel answers, and it blocks. */
  | "PENDING_NZC_139";

/** How long the carve-out lasts, which is a separate question from why it exists. */
export type RetentionPeriod =
  /** Held until a stated event, which is what "not while they still work here" looks like. */
  | { kind: "until-trigger"; trigger: string }
  | { kind: "fixed-period"; months: number; from: string }
  /** Kept with a standing obligation to revisit, rather than kept for ever by omission. */
  | { kind: "indefinite-with-review"; reviewEvery: string }
  | { kind: "PENDING_NZC_139" };

/**
 * Which people a carve-out covers.
 *
 * Split out because the answer may differ for NZI's own staff and a client's staff, and that difference
 * turns on who controls the record — which is NZC-138 and not yet answered either.
 */
export type SubjectClass = "nzi-staff" | "client-staff" | "any";

export type CarveoutScope =
  | { table: string; columns: readonly string[] | "*"; subjectClass: SubjectClass }
  /**
   * A category counsel may well name, which maps to no column this system holds today.
   *
   * Kept rather than dropped: "we hold nothing of that kind" is a useful answer to give counsel, and a
   * category that silently disappeared would be re-raised by somebody later with no record of why it was
   * left out.
   */
  | { unmapped: "PENDING_NZC_139"; note: string };

export type RetentionCarveout = {
  key: string;
  appliesTo: CarveoutScope;
  basis: LawfulBasis;
  /** What the basis is claimed to rest on, in a sentence somebody can challenge. */
  basisNote: string;
  retention: RetentionPeriod;
  /** Where NZI staff and client staff would be treated differently (NZC-138). */
  scopeSplit?: { nziStaff: string; clientStaff: string };
  /** Retain for ever, or retain for the period and then destroy — a separate question from the basis. */
  onErasure: "retain" | "shred-after-retention" | "PENDING_NZC_139";
  /** What the erasure tombstone records, so a person is told a thing was kept and why. */
  auditLabel: string;
  /** The decision that settled it. Absent means still pending, and pending blocks. */
  resolvedBy?: string;
};

/**
 * The carve-outs asked about, none of them answered.
 *
 * Pre-stubbed rather than invented: each is a category the brief names or the system's own constraints
 * force, and each carries whatever *is* known — the shape of the retention where that follows from how
 * the system works — while leaving the basis to counsel.
 */
export const RETENTION_CARVEOUTS: ReadonlyArray<RetentionCarveout> = [
  {
    key: "staff-auth-credentials",
    appliesTo: { table: "staff_credentials", columns: "*", subjectClass: "any" },
    basis: "PENDING_NZC_139",
    basisNote:
      "Erasing an active employee's sign-in address does not forget them, it removes a working user's " +
      "ability to log in. So something is retained here whatever counsel decides; what is undetermined " +
      "is the ground for it and whether it survives the employment ending.",
    // The one thing already known, and it is a consequence of how authentication works rather than a
    // legal judgement — so it is stated even though the basis beside it is not.
    retention: { kind: "until-trigger", trigger: "employment_ended" },
    onErasure: "PENDING_NZC_139",
    auditLabel: "Sign-in details retained while the account is active",
  },
  {
    key: "staff-training-records",
    appliesTo: { table: "trainees", columns: "*", subjectClass: "any" },
    basis: "PENDING_NZC_139",
    basisNote:
      "A training record is evidence a person was trained, which plausibly carries retention of its own " +
      "— to the person, to their employer, and to whoever relies on the certificate. Whether that " +
      "outlives an erasure request, and for how long, is the determination.",
    retention: { kind: "PENDING_NZC_139" },
    scopeSplit: {
      nziStaff: "PENDING_NZC_139 — internal training records",
      clientStaff: "PENDING_NZC_139 — turns on who controls the record (NZC-138)",
    },
    onErasure: "PENDING_NZC_139",
    auditLabel: "Training history retained",
  },
  {
    key: "staff-training-bookings",
    appliesTo: { table: "training_bookings", columns: "*", subjectClass: "any" },
    basis: "PENDING_NZC_139",
    basisNote:
      "The booking freezes the employer and the funding at the time of the course, which is a commercial " +
      "record as well as a personal one. It is enumerated separately from the trainee record because the " +
      "answer may differ: a person's own history and a client's booking are not the same obligation.",
    retention: { kind: "PENDING_NZC_139" },
    onErasure: "PENDING_NZC_139",
    auditLabel: "Course booking retained",
  },
  {
    key: "person-financial-records",
    // Verified against the schema rather than assumed: there is no invoice, payment, quote or fee table
    // in this system, and no column in the PII inventory holds financial personal data. The category is
    // kept because counsel is likely to raise it and "we hold none" is the answer they need.
    appliesTo: {
      unmapped: "PENDING_NZC_139",
      note:
        "No financial personal data exists in this schema today — no invoice, payment, quote or fee " +
        "table, and no column in the inventory. If billing lands here later this carve-out is where its " +
        "retention goes, and it will need mapping before it can be applied.",
    },
    basis: "PENDING_NZC_139",
    basisNote:
      "Financial records ordinarily carry statutory retention. Recorded so the question is answered once " +
      "rather than rediscovered when billing arrives.",
    retention: { kind: "PENDING_NZC_139" },
    onErasure: "PENDING_NZC_139",
    auditLabel: "Financial records retained",
  },
];

/** Still waiting on counsel: an unstated basis, an unstated period, or no decision recorded against it. */
export const isPendingCarveout = (carveout: RetentionCarveout): boolean =>
  carveout.resolvedBy === undefined
  || carveout.basis === "PENDING_NZC_139"
  || carveout.retention.kind === "PENDING_NZC_139"
  || carveout.onErasure === "PENDING_NZC_139";

export const pendingCarveouts = (): readonly RetentionCarveout[] =>
  RETENTION_CARVEOUTS.filter(isPendingCarveout);

/** The carve-outs mapped to a real place in the schema, which are the ones erasure can act on. */
export const mappedCarveouts = (): ReadonlyArray<RetentionCarveout & { appliesTo: Extract<CarveoutScope, { table: string }> }> =>
  RETENTION_CARVEOUTS.filter(
    (carveout): carveout is RetentionCarveout & { appliesTo: Extract<CarveoutScope, { table: string }> } =>
      "table" in carveout.appliesTo);

/** Every carve-out covering one column, mapped or not. */
export const carveoutsFor = (table: string, column: string): readonly RetentionCarveout[] =>
  mappedCarveouts().filter((carveout) =>
    carveout.appliesTo.table === table
    && (carveout.appliesTo.columns === "*" || carveout.appliesTo.columns.includes(column)));

/** Whether erasure must hold off on a column because a carve-out over it is unresolved. */
export const pendingCarveoutFor = (table: string, column: string): RetentionCarveout | undefined =>
  carveoutsFor(table, column).find(isPendingCarveout);

/**
 * The carve-outs that name something this schema does not have.
 *
 * A carve-out pointing at a table or column that does not exist would be applied to nothing while
 * reading as coverage, which is the retention equivalent of a check over an empty set. Asserted by a
 * test rather than trusted.
 */
export const misdirectedCarveouts = (): readonly string[] =>
  mappedCarveouts().flatMap((carveout) => {
    const { table, columns } = carveout.appliesTo;
    if (!PII_TABLES[table]) return [`${carveout.key}: no inventory table '${table}'`];
    if (columns === "*") return [];
    return columns
      .filter((column) => !PII_COLUMNS.some((entry) => entry.table === table && entry.column === column))
      .map((column) => `${carveout.key}: no inventory column '${table}.${column}'`);
  });
