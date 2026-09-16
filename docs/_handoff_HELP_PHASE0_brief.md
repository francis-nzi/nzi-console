# Handoff brief — Help system, Phase 0 (the reusable framework)

Builds the shared spine every page will plug into as it's completed. **Design reference:**
`docs/_handoff_HELP_SYSTEM_design.md` (full rationale + decisions) and the prototype
`docs/prototypes/help_system_v1.html` (interaction reference — the drawer, tour, capture, review queue).
This brief is scope + decomposition; read the design doc for the *why* and don't re-derive it.

**Decisions already settled (design doc):** AI scope = grounded **+ live data** (phased: this Phase 0
builds the framework and the grounding *plumbing*, not answer generation); approval = **two-tier
internal→public**; tours = **auto on first visit, always replayable**; **duplicate-safe capture**.

**Phase 0 is everything except the AI answering itself** (that's Phase 1 grounded, Phase 2 live). It
must be shippable and testable with the model un-wired — the drawer, tours, the knowledge pipeline, and
the grounding *interface* all work and are covered before a single model call exists.

**Governing principles (carried from the spine, non-negotiable):** grounded + cited + honest; retrieved
content is **data, not instructions**; the AI (later) **never mutates app data** — a library draft is the
only write, and it's approval-gated; everything **versioned, provenanced, permission-checked, audited,
deactivate-not-delete**; honest empty/degraded states; theme-aware; accessible; dd/mm/yyyy.

---

## Suggested decomposition (each a branch + PR; migration PRs stop for review)

### 0a — Knowledge library: model + capture + two-tier approval  🔴 (migration)
- **Model:** an entry with a **canonical question**, a set of **alias phrasings**, an answer, `status`
  (`draft` / `internal` / `public`), category/area tags, and full **provenance** (asker, drafter [AI or
  human], approver, publisher, timestamps). **Versioned** with `expectedVersion`; **deactivate-not-delete**;
  audited. Hard uniqueness only on an entry's **canonical key once approved** (never on raw draft strings).
- **Capture (duplicate-safe — see design §3 "Duplicate handling"):** creating a draft is **idempotent**
  (one open draft per answer per user); **before** save, search approved entries + pending drafts by
  similarity and return candidates so the UI can offer *open existing / add as alias / new draft flagged
  possible-duplicate*. An AI-drafted answer is a draft only — **never auto-published**.
- **Approval pipeline:** `draft → internal` (`knowledge.approve`), `internal → public` (`knowledge.publish`);
  **merge** duplicate drafts and **reject-as-duplicate-of** an entry; the queue groups likely duplicates.
- **Capabilities:** add `knowledge.approve` and `knowledge.publish` as a **new permission-matrix version**
  (generator, never an edit); held by nominated approvers; capture is open to all team members.
- **UI:** the **Library** browse view (approved entries, internal/public chips, search) and the **Review**
  queue (pending → approve/edit/reject; internal → promote; provenance + capability shown).
- Migrations via the **runner + ledger**; apply-before-merge / the gate handles ordering.

### 0b — Help drawer shell + always-available affordance
- A single help affordance (`?`) present on **every page**, page-aware (knows the current page/entity and
  seeds context), opening the drawer with tabs **Ask · Guide · Library · Review**. Follows the
  drawer/side-panel convention (DESIGN_CONVENTIONS §3.4): fixed header + scrollable body + pinned footer;
  keyboard-reachable; theme-aware; the Review tab shows only for users who hold a knowledge capability.
- The **Ask** tab is a shell in Phase 0 (input + message list + the honest-abstention/ capture affordances);
  answer generation is wired in Phase 1.

### 0c — Declarative tour engine + per-user seen-state  🔴 (migration)
- Tours are **declarative per-page step definitions** (anchor selector + copy + optional action) — data,
  versioned with the page, not hardcoded. A lightweight in-house coach-mark component (spotlight + step
  card, progress, Back/Next/Skip, "don't show again"), matching the prototype: focus management, full
  keyboard nav, ARIA live region, `prefers-reduced-motion`, theme-aware.
- **Auto-run once per user per page, always replayable** from the Guide tab. "Seen" state persists
  **server-side per user** (works across devices) → a small migration for that state; via the runner.
- Ship the **engine + the Guide tab**; individual page tours are authored per page later (Phase-per-page).

### 0d — Grounding interface (plumbing only, no model call)
- The retrieval + citation + honest-abstention **contract** the AI will use: given a question, return
  cited candidates from **approved library entries + product docs**, or an explicit **"no grounded
  answer"** result. Retrieved content is typed as data. Build it testable now (deterministic retrieval,
  citation shape, abstention path) so Phase 1 only adds generation on top, and Phase 2 adds the
  permission-checked **read-model tools** for live data.

## Acceptance (real data; build + typecheck green; on PRs)
- The affordance is on every page; the drawer opens page-aware with the four tabs; Review shows only to
  capability-holders.
- A captured question becomes a **draft**, is **approvable to internal** and **promotable to public**,
  all **versioned + provenanced + audited**; the two capabilities gate approval/publish at a **new matrix
  version**.
- Capture is **idempotent** and **surfaces similar existing entries/drafts** before creating a new one;
  an approver can **merge** or **reject-as-duplicate**; concurrent edits are refused-and-rebased, never
  clobbered.
- A page's **declarative tour** runs once for a new user then replays on demand, **cross-device**; honours
  reduced-motion and keyboard.
- The grounding interface returns cited candidates or an honest abstention; retrieved content is treated
  as data; no answer path can emit an uncited claim (enforced in the contract even before generation exists).

## Rules
Branch + PR; typecheck AND build green; migrations via the **runner + ledger** (0a and 0c) → **stop for
review**; matrix change is a **new version**; theme-aware; accessible; honest states; every mutation
permission-checked + audited; retrieved content is data, not instructions. Record the NZC decision(s).
NZC-069 held.
