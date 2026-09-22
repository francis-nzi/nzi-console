import type { IndexedColumn } from "./subjectCrypto";

/**
 * Every datum in this system that belongs to a person, enumerated once (NZC-125).
 *
 * Three operations read this list and nothing else: the seal-coverage invariant, the DSAR export, and
 * erasure. One list, three consumers, so no column can be sealed and not exported, exported and not
 * erasable, or erasable and not covered. Completeness stops being something anybody has to remember.
 *
 * ## The axis that makes it honest
 *
 * {@link PiiAttribution} says whether a datum can be reached *from a subject*, and when it cannot, why.
 * That distinction is the difference between an export that is complete and one that is merely
 * confident: seventeen of the columns here hold personal data that no subject path reaches, and an
 * export which silently omitted them would tell somebody they had been shown everything.
 *
 * So nothing is left out. Non-attributable data is rendered to the person as *held, but not attributable
 * to you*, and recorded by erasure as *retained — not attributable*, with the reason. The failure mode
 * being designed against is silence, not incompleteness: incompleteness that says so is a fact somebody
 * can act on.
 *
 * ## What is derived from it
 *
 * `SEALED_COLUMNS` and `SEALABLE_ROWS` in `piiSealing` are views over this, not parallel lists. That is
 * the whole point of the restructure: the previous arrangement had two lists and asserted they agreed in
 * one direction only, and the direction it did not assert is where the gap was.
 */

/* ── How a datum is stored, which decides how it is read and how it is destroyed ──────── */

export type PiiStorage =
  /** Ciphertext under the subject's key. Erasure destroys the key. */
  | { kind: "sealed"; sealed: string }
  /** Ciphertext plus a keyed digest, because something matches on it. Erasure destroys both. */
  | { kind: "sealed-and-indexed"; sealed: string; index: string; indexedAs: IndexedColumn; linkageField: string }
  /** In the clear, with no ciphertext column to write. Erasure cannot shred what has no key. */
  | { kind: "plaintext" }
  /** Inside a JSON payload, so neither a column to seal nor a value to null. */
  | { kind: "json" }
  /** A derived digest with no plaintext beside it — the linkage family. Erasure nulls it. */
  | { kind: "digest" };

/* ── Whether a datum can be reached from a subject, and when not, why ────────────────── */

export type PiiAttribution =
  /** The row *is* the person, or is keyed by a column the registry links. */
  | { kind: "person-row"; subjectTable: SubjectTable; subjectIdColumn: string }
  /** A column on this row names the person. The datum is an association, not their identity. */
  | { kind: "pointer"; via: string; subjectTable: SubjectTable }
  /** The row is history of another table's row, and belongs to whoever that row belongs to. */
  | { kind: "history-of"; table: string }
  /**
   * Reached from the subject's links rather than from a column on the row.
   *
   * The linkage digests are keyed by `(source_table, source_id, field)`, so which person a row belongs
   * to depends on the row and not on the table. It is genuinely theirs — an export names it and an
   * erasure nulls it — but there is no single parent table to point at, and saying "history of" one
   * would be a convenient untruth.
   */
  | { kind: "via-links"; because: string }
  /** Reachable once a named change lands, and not before. */
  | { kind: "pending"; because: string }
  /** No subject path exists. The reason is part of the record, and is shown to the person. */
  | { kind: "none"; because: string };

/** The four tables `data_subject_links` may name. */
export type SubjectTable = "trainees" | "client_contacts" | "portal_users" | "memberships";

/* ── What erasure does ───────────────────────────────────────────────────────────────── */

export type PiiErasure =
  /** The subject's key is destroyed, and with it everything sealed under it. */
  | "shred-key"
  /** A digest is nulled, because a key-shred leaves a fingerprint a guess could still confirm. */
  | "null-digest"
  /** Inside a JSON payload: it cannot be key-shredded, so it is redacted or retained with a basis. */
  | "redact-or-retain"
  /**
   * Strip the subject's personal data out of the payload and keep the row.
   *
   * The resolved form of `redact-or-retain` where counsel answers "redact": the record of what
   * happened survives, the person inside it does not. Distinct from `shred-key` because there is no
   * key over a payload, and distinct from nulling the column because the column holds more than the
   * person.
   */
  | "redact-on-erasure"
  /**
   * Nobody has decided yet, and until somebody does this column blocks (NZC-142).
   *
   * The state exists so that waiting on a determination cannot be mistaken for a decision. Held as an
   * absence it would behave exactly like "retain nothing" or "retain everything" depending on which way
   * the code leaned, and the question would be answered by default. Held here it is enumerated, visible
   * to the coverage invariant, and refused by the erasure command — which is what makes it a gap
   * somebody still owes an answer for rather than a silent one.
   *
   * A column may not enter this state without a `pendingClassification` naming the decision it waits
   * on. A pending state with no question attached is just an untreated column.
   */
  | "pending-counsel"
  /** Kept deliberately, with a lawful basis recorded. Never a silent skip. */
  | "retain-with-basis"
  /** A pointer to a person whose identity is already shredded: it dangles to a tombstone. */
  | "association-to-tombstone"
  /** No subject path, so nothing to erase against this subject. Recorded, with the reason. */
  | "not-attributable"
  /**
   * A named change makes this erasable and it is not yet applied. Distinct from "not attributable":
   * the subject is known and the datum is theirs, and the only thing missing is the column to shred.
   * Saying so is the difference between a gap with a date on it and one nobody is tracking.
   */
  | "pending";

/* ── A table, and how a row of it reaches a person ───────────────────────────────────── */

export type PiiTable = {
  keyColumns: readonly string[];
  attribution: PiiAttribution;
  /** Where the digests for this table's rows are recorded, when it has any. */
  linkage?: { table: string; idColumn: string };
  /** Where this table's history lives. Sealed under the live record's key, so one shred covers both. */
  history?: string;
  /**
   * The runtime roles may insert but never update this table, so erasure cannot clear a plaintext
   * column on it.
   *
   * A shred still reaches the ciphertext, because the key lives elsewhere. What it cannot reach is the
   * plaintext column sitting beside it, which 0100 deliberately kept until those columns are dropped
   * wholesale. On an ordinary table erasure nulls that plaintext itself; here it cannot, so the column is
   * reported as still pending the plaintext-drop rather than counted as erased.
   *
   * Declared rather than discovered, so an erasure plan can be built without interrogating the database —
   * and asserted against the real grants by a test, because a declaration that drifts from the schema is
   * exactly how an erasure would start reporting a column as erased that it never touched.
   */
  appendOnly?: true;
};

/**
 * The open question behind a `pending-counsel` column.
 *
 * Candidates rather than a recommendation: the point of asking counsel is that we do not know, and a
 * shape that recorded our preference would invite it to be adopted by default. What each candidate would
 * *mean* is recorded, because the consequence is the part this system knows and counsel does not.
 */
export type PendingClassification = {
  /** The decision this waits on. Required — a pending column with no question is an untreated one. */
  nzc: string;
  candidates: ReadonlyArray<PiiErasure>;
  /** Per candidate, what follows here if counsel picks it. Keyed by the candidate. */
  consequenceByCandidate: Readonly<Record<string, string>>;
  note: string;
};

export type PiiColumn = {
  table: string;
  column: string;
  /** What this is called when a person is shown it. */
  label: string;
  storage: PiiStorage;
  /** How far the sealing rollout has reached. Independent of attribution. */
  stage: "sealed" | "awaiting-auth-bridge" | "deferred";
  erasure: PiiErasure;
  /**
   * How *this column* reaches a subject, when that differs from the rest of its table.
   *
   * `clients` is why this exists: `owner_name` is attributable through `owner_user_id`, and
   * `contact_name` and `contact_email` on the same row reach nobody. Attribution held only per table
   * would have called all three attributable and made an export claim to have gathered two columns it
   * cannot reach. Found by the invariant below rather than by reading.
   */
  attribution?: PiiAttribution;
  /** Why, wherever the answer is not the obvious one. Shown in an export or an erasure record. */
  because?: string;
  /** Required when `erasure` is `pending-counsel`, and meaningless otherwise. */
  pendingClassification?: PendingClassification;
};

/* ── The tables ──────────────────────────────────────────────────────────────────────── */

const personRow = (subjectTable: SubjectTable, subjectIdColumn: string): PiiAttribution =>
  ({ kind: "person-row", subjectTable, subjectIdColumn });

export const PII_TABLES: Readonly<Record<string, PiiTable>> = {
  // The four the registry names, plus the two that belong to one of them.
  trainees: {
    keyColumns: ["trainee_id"], attribution: personRow("trainees", "trainee_id"),
    linkage: { table: "trainees", idColumn: "trainee_id" },
  },
  client_contacts: {
    keyColumns: ["contact_id"], attribution: personRow("client_contacts", "contact_id"),
    linkage: { table: "client_contacts", idColumn: "contact_id" },
    history: "client_contact_versions",
  },
  portal_users: {
    keyColumns: ["portal_user_id"], attribution: personRow("portal_users", "portal_user_id"),
    linkage: { table: "portal_users", idColumn: "portal_user_id" },
  },
  memberships: {
    keyColumns: ["user_id"], attribution: personRow("memberships", "user_id"),
    linkage: { table: "memberships", idColumn: "user_id" },
  },
  staff_credentials: {
    // A credential exists only for a membership — the foreign key says so — so the subject is that
    // membership and the login address is recorded against it under its own field.
    keyColumns: ["user_id"], attribution: personRow("memberships", "user_id"),
    linkage: { table: "memberships", idColumn: "user_id" },
  },
  trainee_email_changes: {
    keyColumns: ["change_id"], attribution: personRow("trainees", "trainee_id"),
    linkage: { table: "trainee_email_changes", idColumn: "change_id" },
  },

  // History, which belongs to whoever the live row belongs to.
  client_contact_versions: {
    keyColumns: ["contact_id", "version"], attribution: { kind: "history-of", table: "client_contacts" },
    // 0067 revokes UPDATE from every runtime role: history that can be rewritten is not history.
    appendOnly: true,
  },

  // Associations: the row is about something else, and a column on it names a person.
  clients: {
    keyColumns: ["client_id"], attribution: { kind: "pointer", via: "owner_user_id", subjectTable: "memberships" },
  },
  report_versions: {
    keyColumns: ["report_version_id"],
    attribution: { kind: "pointer", via: "signee_contact_id", subjectTable: "client_contacts" },
  },
  portal_report_comments: {
    keyColumns: ["comment_id"], attribution: { kind: "pointer", via: "author_id", subjectTable: "portal_users" },
    // What a client said on their own report, which nobody may edit afterwards either.
    appendOnly: true,
  },

  // Reachable once a named change lands.
  training_bookings: {
    keyColumns: ["booking_id"],
    attribution: { kind: "pending", because: "a trainee is a subject and person_email auto-links by the registry's own rule, but data_subject_links.source_table cannot name training_bookings until the CHECK is widened" },
  },

  // No subject path.
  jobs: {
    keyColumns: ["job_id"],
    attribution: { kind: "none", because: "the owner is free text with no user id — the name-suggestion class, which by ruling has no index and no reliable subject" },
  },
  strategy_automation_log: {
    keyColumns: ["automation_log_id"],
    attribution: { kind: "none", because: "an address with no pointer to a person-row; it is also part of a unique constraint, so it is operational rather than display-only and wants a blind index before anything else" },
  },
  job_scope_rows: {
    keyColumns: ["scope_row_id"],
    attribution: { kind: "none", because: "a vehicle registration identifies a keeper who is not in our data at all" },
  },
  job_emission_sources: {
    keyColumns: ["source_id"],
    attribution: { kind: "none", because: "carries the asset identifier, and inherits its lack of a subject" },
  },
  client_sites: {
    keyColumns: ["site_id"],
    attribution: { kind: "none", because: "a site address belongs to the client, not to a person" },
  },
  lca_suppliers: {
    keyColumns: ["supplier_id"],
    attribution: { kind: "none", because: "no writer and no reader anywhere in the application, so the table is empty by construction; a drop candidate rather than a subject-model question" },
  },

  // Personal data inside JSON, which no key reaches.
  audit_events: {
    keyColumns: ["audit_event_id"],
    attribution: { kind: "none", because: "an audit row is about an act, not a person, and its payload names whoever the act was about" },
    appendOnly: true,
  },
  transactional_outbox: {
    keyColumns: ["outbox_id"],
    attribution: { kind: "none", because: "a dispatch payload; the address in it duplicates strategy_automation_log rather than belonging to the row" },
  },

  // The digests, which have no plaintext at all.
  data_subject_linkage: {
    keyColumns: ["source_table", "source_id", "field"],
    attribution: { kind: "via-links", because: "a digest is keyed by the source row it was computed from, so it is reached through the subject's links rather than by a column on this table" },
    appendOnly: true,
  },
};

/* ── The columns ─────────────────────────────────────────────────────────────────────── */

const sealed = (column: string): PiiStorage => ({ kind: "sealed", sealed: column });
const indexed = (sealedColumn: string, index: string, indexedAs: IndexedColumn, linkageField: string): PiiStorage =>
  ({ kind: "sealed-and-indexed", sealed: sealedColumn, index, indexedAs, linkageField });

export const PII_COLUMNS: ReadonlyArray<PiiColumn> = [
  // ── Sealed, dual-written, backfilled ────────────────────────────────────────────────
  { table: "client_contacts", column: "email", label: "Email address", stage: "sealed", erasure: "shred-key",
    storage: indexed("email_sealed", "email_bidx", "client_contacts.email", "email") },
  { table: "client_contacts", column: "full_name", label: "Name", stage: "sealed", erasure: "shred-key", storage: sealed("full_name_sealed") },
  { table: "client_contacts", column: "job_title", label: "Job title", stage: "sealed", erasure: "shred-key", storage: sealed("job_title_sealed") },
  { table: "client_contacts", column: "phone", label: "Phone number", stage: "sealed", erasure: "shred-key", storage: sealed("phone_sealed") },
  { table: "portal_users", column: "email_normalized", label: "Portal sign-in address", stage: "sealed", erasure: "shred-key",
    storage: indexed("email_sealed", "email_bidx", "portal_users.email_normalized", "email") },
  { table: "portal_users", column: "display_name", label: "Portal display name", stage: "sealed", erasure: "shred-key", storage: sealed("display_name_sealed") },
  { table: "memberships", column: "email", label: "Work email address", stage: "sealed", erasure: "shred-key",
    storage: indexed("email_sealed", "email_bidx", "memberships.email", "email") },
  { table: "memberships", column: "display_name", label: "Name", stage: "sealed", erasure: "shred-key", storage: sealed("display_name_sealed") },

  // ── Sealed by the backfill; their only writers run in the authentication context ─────
  { table: "trainees", column: "personal_email", label: "Sign-in address", stage: "awaiting-auth-bridge", erasure: "shred-key",
    storage: indexed("email_sealed", "email_bidx", "trainees.personal_email", "email") },
  { table: "trainees", column: "full_name", label: "Name", stage: "awaiting-auth-bridge", erasure: "shred-key", storage: sealed("full_name_sealed") },
  { table: "trainees", column: "phone", label: "Phone number", stage: "awaiting-auth-bridge", erasure: "shred-key", storage: sealed("phone_sealed") },
  { table: "trainees", column: "current_employer_name", label: "Current employer", stage: "awaiting-auth-bridge", erasure: "shred-key", storage: sealed("current_employer_name_sealed") },
  { table: "trainee_email_changes", column: "current_email", label: "Previous sign-in address", stage: "awaiting-auth-bridge", erasure: "shred-key",
    storage: indexed("current_email_sealed", "current_email_bidx", "trainee_email_changes.current_email", "current-email") },
  { table: "trainee_email_changes", column: "new_email", label: "Requested sign-in address", stage: "awaiting-auth-bridge", erasure: "shred-key",
    storage: indexed("new_email_sealed", "new_email_bidx", "trainee_email_changes.new_email", "new-email") },
  { table: "staff_credentials", column: "email_normalized", label: "Staff sign-in address", stage: "awaiting-auth-bridge", erasure: "shred-key",
    storage: indexed("email_sealed", "email_bidx", "staff_credentials.email_normalized", "login-email") },

  // ── The linkage digests, which a key-shred alone would leave behind ──────────────────
  { table: "data_subject_linkage", column: "linkage_bidx", label: "Internal matching digest", stage: "sealed",
    erasure: "null-digest", storage: { kind: "digest" },
    because: "shredding the key leaves this behind, and a digest is confirmable by guess — so an erased person would stay findable by anyone able to guess their address" },

  // ── History, which dies in the same shred as the record it is history of ─────────────
  { table: "client_contact_versions", column: "snapshot_json", label: "Previous versions of your contact record",
    stage: "sealed", erasure: "shred-key", storage: sealed("snapshot_sealed"),
    because: "sealed under the live contact's own key (0106), so one shred covers the record and every earlier version of it" },

  // ── Associations: attributed by pointer, erased with the identity they point at ──────
  { table: "clients", column: "owner_name", label: "A client you own", stage: "deferred", erasure: "association-to-tombstone",
    storage: sealed("owner_name_sealed"),
    because: "owner_user_id names the person, so this is an association rather than their identity; the identity is shredded at the membership and this dangles to a tombstone" },
  { table: "report_versions", column: "signee_name", label: "A report you signed", stage: "deferred", erasure: "association-to-tombstone",
    storage: sealed("signee_name_sealed"), because: "signee_contact_id names the contact" },
  { table: "report_versions", column: "signee_job_title", label: "Your job title as signee", stage: "deferred", erasure: "association-to-tombstone",
    storage: sealed("signee_job_title_sealed"), because: "as signee_name" },
  { table: "portal_report_comments", column: "author_display_name", label: "A comment you wrote", stage: "deferred", erasure: "association-to-tombstone",
    storage: sealed("author_display_name_sealed"),
    because: "author_id names the author; a staff author's display name is their role rather than their name. The comment *body* may itself contain personal data, which is a content-sealing question and not this one" },

  // ── Reachable once the registry can name the table ───────────────────────────────────
  { table: "training_bookings", column: "person_name", label: "Name on a training booking", stage: "deferred", erasure: "not-attributable",
    storage: sealed("person_name_sealed"), because: "pending the registry widening" },
  { table: "training_bookings", column: "person_email", label: "Email on a training booking", stage: "deferred", erasure: "not-attributable",
    storage: sealed("person_email_sealed"), because: "pending the registry widening; this address is what would auto-link it" },
  { table: "training_bookings", column: "person_phone", label: "Phone on a training booking", stage: "deferred", erasure: "not-attributable",
    storage: sealed("person_phone_sealed"), because: "pending the registry widening, and no writer sets it — a drop candidate" },

  // ── No subject path ──────────────────────────────────────────────────────────────────
  // The table is attributed through `owner_user_id`, and these two are not: a client's contact is not
  // the staff member who owns the client. Stated per column, because attribution held per table would
  // have made an export claim to have gathered them.
  { table: "clients", column: "contact_email", label: "Client contact address", stage: "deferred", erasure: "not-attributable",
    storage: sealed("contact_email_sealed"),
    attribution: { kind: "none", because: "an address on the client record with no pointer to a person-row" },
    because: "an address on the client record with no pointer to a person-row" },
  { table: "clients", column: "contact_name", label: "Client contact name", stage: "deferred", erasure: "not-attributable",
    storage: sealed("contact_name_sealed"),
    attribution: { kind: "none", because: "as contact_email" }, because: "as contact_email" },
  { table: "jobs", column: "owner_name", label: "Job owner", stage: "deferred", erasure: "not-attributable",
    storage: sealed("owner_name_sealed"), because: "free text with no user id" },
  { table: "strategy_automation_log", column: "recipient_email", label: "Reminder recipient", stage: "deferred", erasure: "not-attributable",
    storage: sealed("recipient_email_sealed"), because: "operational rather than display-only: part of a unique constraint, so its plaintext cannot be dropped until that moves to a digest" },
  { table: "job_scope_rows", column: "asset_identifier", label: "Asset identifier", stage: "deferred", erasure: "not-attributable",
    storage: sealed("asset_identifier_sealed"), because: "a vehicle registration identifies a keeper who is not in our data" },
  { table: "job_emission_sources", column: "detail_json", label: "Emission source detail", stage: "deferred", erasure: "not-attributable",
    storage: sealed("detail_sealed"), because: "carries the asset identifier" },
  { table: "client_sites", column: "postcode", label: "Site postcode", stage: "deferred", erasure: "not-attributable",
    storage: sealed("postcode_sealed"), because: "a site address belongs to the client" },
  { table: "client_sites", column: "address_lines_json", label: "Site address", stage: "deferred", erasure: "not-attributable",
    storage: sealed("address_lines_sealed"), because: "as postcode" },
  { table: "lca_suppliers", column: "contact_name", label: "Supplier contact name", stage: "deferred", erasure: "not-attributable",
    storage: sealed("contact_name_sealed"), because: "the table has no writer and no reader; empty by construction" },
  { table: "lca_suppliers", column: "contact_email", label: "Supplier contact address", stage: "deferred", erasure: "not-attributable",
    storage: sealed("contact_email_sealed"), because: "as contact_name" },

  // ── Personal data inside JSON, which no key reaches ──────────────────────────────────
  { table: "audit_events", column: "before_json", label: "The previous value an edit replaced", stage: "deferred",
    erasure: "pending-counsel", storage: { kind: "json" },
    because: "client.contact.update is the only command that puts a person field in a before-payload, and it is a name. An audit row plausibly has a lawful retention basis, so whether this is redacted or retained is a counsel question rather than a technical one (NZC-140)",
    pendingClassification: {
      nzc: "NZC-140",
      candidates: ["retain-with-basis", "redact-on-erasure"],
      consequenceByCandidate: {
        "retain-with-basis":
          "a carve-out in retentionCarveouts.ts on an accountability or audit-integrity basis, which is " +
          "then the single source of truth for it — the inventory points at the carve-out rather than " +
          "restating the ground",
        "redact-on-erasure":
          "a redaction mechanism, which does not exist yet: the payload has to lose the person and keep " +
          "the shape of what changed, or the audit row stops being evidence of anything",
      },
      note:
        "The sharp edge is that a before-image can re-state a value the erasure destroyed. Exposure is " +
        "already limited by the payload being structured rather than free text — one command writes a " +
        "person's field into one, and it is a name — so this is a question about basis rather than a " +
        "defect to fix.",
    } },
  { table: "transactional_outbox", column: "payload_json", label: "A reminder addressed to you", stage: "deferred",
    erasure: "pending-counsel", storage: { kind: "json" },
    because: "the strategy reminder payload carries recipientEmail and nothing drains the table; the address duplicates strategy_automation_log, so removing the copy is likely better than redacting it (NZC-140)",
    pendingClassification: {
      nzc: "NZC-140",
      candidates: ["redact-on-erasure", "retain-with-basis"],
      consequenceByCandidate: {
        "redact-on-erasure":
          "the expected answer: the row is in-flight work, so the address can go and the reminder still " +
          "knows what it was for. Redaction here is cheaper than for the audit payload because nothing " +
          "downstream verifies the payload's contents",
        "retain-with-basis":
          "a carve-out, which would be surprising for a transient queue and would need a reason the " +
          "duplicate in strategy_automation_log does not already satisfy",
      },
      note:
        "Transient by design and drained on a clock, so most rows age out before an erasure would reach " +
        "them. That makes the expected answer redact-or-expire rather than retain — but 'expected' is " +
        "not 'decided', and nothing drains the table today (NZC-129).",
    } },
];

/* ── Derivations ─────────────────────────────────────────────────────────────────────── */

/** The table record for a column, which must exist — the invariant test asserts it for every column. */
export const tableOf = (column: PiiColumn): PiiTable => PII_TABLES[column.table]!;

/** How this datum reaches a subject: its own answer if it has one, otherwise its table's. */
export const attributionOf = (column: PiiColumn): PiiAttribution =>
  column.attribution ?? tableOf(column).attribution;

/** Whether a datum can be reached from a subject today. `pending` is not yet; `none` is not at all. */
export const isAttributable = (column: PiiColumn): boolean => {
  const kind = attributionOf(column).kind;
  return kind === "person-row" || kind === "pointer" || kind === "history-of" || kind === "via-links";
};

/** Everything an export must gather for a subject, and everything it must declare it cannot. */
export const attributableColumns = (): PiiColumn[] => PII_COLUMNS.filter(isAttributable);
export const unattributableColumns = (): PiiColumn[] => PII_COLUMNS.filter((column) => !isAttributable(column));

/** The ciphertext column, for the storage kinds that have one. */
export const sealedColumnOf = (column: PiiColumn): string | null =>
  column.storage.kind === "sealed" || column.storage.kind === "sealed-and-indexed" ? column.storage.sealed : null;

/** The blind-index column, for the operational ones. */
export const indexColumnOf = (column: PiiColumn): string | null =>
  column.storage.kind === "sealed-and-indexed" ? column.storage.index : null;
