# Handoff brief — Migration/deploy gate + resilient hot-path reads

Prevents the class of failure that took staging down on 15 Sep 2026, and makes a peripheral read
unable to down a core record. Two parts: **(A)** code and schema can no longer ship apart; **(B)** a
non-essential read failing degrades its own piece instead of the whole page.

**What happened (root cause):** #176 merged, auto-deploy shipped code that queried the `0084`
`client_contact_consent_events` table, which had not been applied to the staging DB. `render.yaml` has
no migration step (schema is applied out of band, by hand), so `getClientWorkspace` — the hottest read
path — threw and **every** client workspace returned 503. Two independent faults: schema/code shipped
apart, and a peripheral read (consent) cascaded into the core record.

**Decisions (Francis, 15 Sep 2026; Claude to record as an NZC entry):**
- **Staging pre-deploy = AUTO-APPLY** via the runner. Non-production, isolated, optimise for velocity.
- **Production pre-deploy = HARD CHECK, not auto-apply.** The deploy **fails closed if any migration is
  pending**, forcing a deliberate human apply-via-runner first, then deploy. Prod schema changes stay a
  human act; drift becomes impossible either way.
- **The live service is NOT touched by this work.** Only the staging config changes now. The production
  posture is written down as a go-live procedure and wired to the live service only at go-live — a
  separate, deliberate step.

---

## Part A — Pre-deploy migration gate

### A1. Staging (build + apply now)
- Add a **pre-deploy step** to the staging service in `render.yaml` that runs the runner
  (`npm run migrate -w @nzi/isolated-backend`) **before** the new release serves traffic.
- The runner is safe for this: idempotent, ledger-based, refuses gaps/checksum-mismatch, and
  real-Postgres CI already proves each migration applies. Pending migrations apply in order; an
  up-to-date DB is a no-op.
- **Fail closed:** if migrate exits non-zero, the release must **abort** and the previous (working)
  version stays up — new code must never serve against a DB the migration didn't complete on. Confirm
  Render's pre-deploy semantics abort the deploy on non-zero exit; if they don't, the step must be
  written so a failure prevents cutover.
- `render.yaml` is a deployment-surface change → **propose the diff for Francis to review and apply.**
  Staging service only. Do **not** add or modify anything for the live service.

### A2. Production (document now, wire at go-live — do NOT touch the live service)
- Write the production go-live procedure into `DEPLOYMENT.md`:
  - Production uses a **hard pre-deploy check**: run `migrate:status`; **if anything is pending, the
    deploy fails** and refuses to cut over. It does **not** auto-apply.
  - The go-live sequence for a migration-carrying release to production:
    1. Apply the migration to the production DB via the runner, in the live service's Render Shell
       (secrets stay in env — never pasted), as a deliberate, verified step (`migrate:status` clean
       after).
    2. Deploy the code. The hard check confirms schema is current and lets cutover proceed; if step 1
       was skipped, the deploy fails closed instead of serving broken code.
  - This is prepared config + written procedure only. It is applied to the live service **at go-live**,
    not now.

### A3. Interim discipline (until A1 lands)
- For any migration-carrying PR to staging in the meantime: **apply the migration to the target DB
  before merging the code** (as #142/#145 did). The gate is what makes this discipline unnecessary;
  until it's in, the discipline is the safeguard.

## Part B — Resilient hot-path reads (degrade, don't cascade)

- **Principle:** on a hot read path, an *adjunct* read that fails must degrade to omitting its own
  piece — never take down the *essential* record. A peripheral card failing costs that card, not the page.
- **Immediate:** wrap the consent read in `getClientWorkspace` so an absent/failing consent history
  yields an **honest degraded consent line** ("consent history unavailable"), not a 503. Had this
  existed, 15 Sep would have been a missing consent card, not every workspace down.
- **Audit the hot path:** review `getClientWorkspace` (and peers) for other adjunct sub-reads that could
  throw and cascade; each fails soft to an honest degraded state.
- **Do not over-apply:** essential reads (the client record itself, the footprint) **should** still
  fail loudly — a silent-degraded core record would hide real breakage. The judgment is essential vs
  adjunct; only adjunct reads degrade.
- **Honesty:** a degraded line says "unavailable", never a fabricated value — the same
  honest-degraded-states discipline (never failed-as-zero) applied to resilience.
- Consider a `DESIGN_CONVENTIONS` note: hot read models compose essential + adjunct reads; adjunct reads
  fail soft to honest degraded states.

## Testing
- **A:** render.yaml isn't unit-testable; validate by a deliberate dry-run — a migration-carrying PR to
  staging with the gate in place applies cleanly pre-deploy, and a simulated failing migration aborts
  the release. Document the expected behaviour in `DEPLOYMENT.md`.
- **B:** a behavioural test (headless) that `getClientWorkspace` with the consent sub-read throwing
  still returns the workspace with a degraded consent line, not an error; and that an essential read
  failing still surfaces the failure.

## Sequencing / rules
- **Part A1 first** (stops recurrence), Part B alongside (the seatbelt for the next surprise), A2 is
  docs. A1 stops for review (deployment surface); B is a hot-path read change → PR + review.
- Branch + PR; typecheck AND build green; theme-aware where UI; honest degraded states. Record the NZC
  decision (staging auto-apply / prod hard-check / live untouched-until-go-live). NZC-069 stays held.
