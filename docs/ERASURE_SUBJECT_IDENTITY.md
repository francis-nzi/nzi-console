# NZI Console — Subject identity (erasure / DSAR, PR 0)

> **Status: confirmed and built (NZC-116).** The registry, linker and review queue are migration
> 0098; the reviewing capability is permission-matrix version 6 (0099). What follows is the design
> as it was ruled on, kept because it explains the reasoning the code assumes.
>
> **Still open, and deliberately not settled here:** the legal fork on legacy snapshots, phasing,
> and retention windows. This document is what those decisions key off.

**Why this comes first.** The reconciliation for erasure is crypto-shred: personal data is encrypted
under a per-subject key, and erasure destroys the key. That requires a subject. The PII inventory
found there isn't one — `trainees`, `client_contacts`, `portal_users` and `memberships` each key a
person their own way, with no foreign key between them, so the same human can exist three times
under three unrelated identifiers. "Destroy the key" would otherwise destroy one facet of a person
and leave the others intact.

The linkage probe then answered whether an identity could be *derived* rather than declared. It can,
mostly: the population is mostly singletons, with deterministic cross-table links where an address
is shared, and a residue that genuinely needs a person to decide. That shape — **registry +
deterministic auto-link + human review queue** — is what this designs.

---

## 1. The principle the whole design turns on

**The erasure machinery must not itself accumulate personal data.**

A registry that copied names and addresses in order to match them would become one more place to
erase from — and the worst kind, because it would be the place erasure is run *from*. So:

- The registry holds **no personal data**. A subject is an identifier and a status, nothing else.
- Links hold **pointers**, never copies: `(source_table, source_id)`, resolved at read time under
  the existing tenant rules.
- The review queue holds pointers too. A reviewer's screen reads the name and address from the
  source row when it renders them, and stores neither.

This is the same instinct as `verify_certificate_attempts`, which counts rate-limit attempts against
a salted hash precisely so that verifying a certificate does not leave an address in the database.

## 2. Shape

Three tables, all tenant-scoped with RLS forced, all deactivate-never-delete, all audited through
the existing command spine.

**`data_subjects`** — the identity itself. `(organisation_id, subject_id)`, a status, and the usual
who/when. No name, no address, no email, not even a hash of one. A subject id is pseudonymous and is
safe to reference from anywhere, which is the point: the future key store keys on it.

**`data_subject_links`** — which source rows are this person. `(organisation_id, subject_id,
source_table, source_id)`, plus `link_method` (`deterministic-email` | `reviewed` | `unlinked-no-key`)
and who linked it when. **Unique on `(organisation_id, source_table, source_id)`**: a person-row
belongs to at most one subject, which is what makes "erase this subject" a well-defined act.

**`data_subject_review`** — what a person must decide, with `reason` (below) and a member list of
pointers. Outcomes are recorded, including *"these are different people"*, because a decision that
is not remembered is a decision that gets asked again on every run.

## 3. The linker

Re-runnable by construction: it proposes and records, never un-links, and a recorded decision is
sticky. Running it twice changes nothing.

1. **Normalise.** One function — lower-case, trim — used everywhere, so `A@x.test ` and `a@x.test`
   are one address. **Kept even though the probe found nothing it collapsed.** It costs nothing, and
   the day it matters it matters silently: a single mixed-case address would otherwise split one
   person into two subjects, and nothing would report it. Cheap insurance against an invisible
   failure is the same argument as the shared date helpers.
2. **Auto-link** a group of rows sharing a normalised address **only when no two of them sit in the
   same source table.** One trainee + one contact + one portal user is one person. Two contacts on
   one address is a shared mailbox, not a person, and fusing them would be worse than leaving them
   apart — so it queues instead.
3. **Everything else queues.** Never a guess, never a name match.

### The four reasons a row reaches a human

| Reason | What it is | Why not automatic |
|---|---|---|
| `shared-key` | One address, several rows in the same table | `info@`, `accounts@` — different people behind one mailbox |
| `history-match` | A trainee's **superseded** address matches a live row elsewhere | An old address may have been reassigned, or was never theirs alone |
| `name-suggestion` | Same name, different addresses | A name is not a key. Offered as a suggestion, never a link |
| `no-key` | A person-row with no address at all | Nothing to match on |

## 4. The no-email path, defined

The probe found **two person-rows with no address**. They cannot be email-keyed, and leaving them
unlinked would leave two people **unerasable** — a DSAR with no handle to pull.

So: **every person-row gets a subject immediately, including these.** A row with no address becomes
its own singleton subject with `link_method = 'unlinked-no-key'`, and is queued as `no-key` so a
human *may* merge it later. Erasure has a handle from day one; the queue entry is an improvement
opportunity, not a blocker.

The same rule covers singletons generally: a person who appears in exactly one table is a subject of
one row. That is not a failure to link — it is the correct answer for most of the population.

## 5. What PR 0 does not do

No encryption. No key store. No erasure, deletion or redaction of anything. No change to any
existing table. No new PII anywhere.

It produces an identity and the means to curate it, so the decisions that follow — the legal fork on
legacy snapshots, phasing, retention windows — have something concrete to attach to.

## 6. Carried to go-live, not solved here

**Ambiguity C is untested against real data.** `trainees` was empty when the probe ran, so
`history-match` — the class where a link exists *only* through a superseded address — has never been
exercised against a real population. The queue logic must handle it and will be tested
synthetically, but **a production-representative check is required before the erasure path is relied
on.** A class that has only ever been tested against data we invented is a class we have assumed,
not verified.

Two smaller notes for whoever reads the counts:

- **The ambiguity classes overlap.** One person can be ambiguous in more than one way at once — a
  renamed address and a duplicated name are the same row seen twice. The counts must not be summed.
- **A subject is per organisation**, because everything else is. A DSAR is answered within a tenant,
  and the same human at two firms is two subjects. That follows from RLS rather than contradicting
  it, but it should be a stated answer rather than a discovered one.

## 7. Open questions this design deliberately leaves

1. **Are staff data subjects for this purpose?** `memberships` and `staff_credentials` describe
   employees, and the design treats them as subjects. Confirm.
2. **Who reviews the queue** — any consultant for their own clients, or an admin-only act? It is a
   judgement about a person's identity, which argues for the narrower grant.
3. **Does a review decision expire?** A "these are different people" ruling made before someone
   changes their address may need revisiting; a decision that never expires is simpler and may be
   wrong later.

---

**Related.** `docs/DECISIONS.md` NZC-103 and NZC-104 (the asset identifier, persisted deliberately
and kept out of published reports), NZC-072 (`trainees` as a person-centric record independent of
employer), NZC-022 (the permission matrix a review capability would join).
