# Design brief — Help system: tours + grounded AI drawer + governed knowledge library

A three-part help system that fits *this* app: **product tours** teach each page, an **AI help drawer**
answers the specific question, and a **capture → approve → library** flow turns every question into
governed, reusable knowledge that grounds the AI and eventually feeds the public website. Designed now
as shared infrastructure; each page's tour + knowledge is authored as that page is completed.

**The governing principle — grounded, cited, honest, governed.** The whole app refuses to fabricate:
honest empty states, provenance on every figure, "reviewed, not assured," estimate ≠ measurement. The
help AI must hold the same line, because it's the surface people reach for when unsure. So: it answers
**only from sources it can cite** (approved knowledge, product docs, and the user's own live data via
governed read models), and when it can't ground an answer it **says so and offers to capture the
question** — it never guesses. That honesty is the differentiator: most AI help is ungrounded and
quietly wrong; this is trustworthy by construction, which is exactly what a rigour-selling product needs.

**Decisions (confirmed by Francis, 16 Sep 2026):**
1. **AI scope: grounded + the user's live data.** Answers from the approved library + docs *and* the
   user's own clients/data — permission-checked, tenant-scoped. (Phase it — see §5: grounded first,
   live-data as the second tier on the same drawer.)
2. **Two-tier approval: internal, then public.** Approved = live internally + grounds the AI; a second
   promotion makes an entry public/website-ready.
3. **Tours: auto on first visit, always replayable.**

---

## 1. Product tours
- **Declarative per-page step definitions** — each step = an element anchor + copy + optional "do this"
  action. Tours are *data*, versioned with the page, not hardcoded — consistent and maintainable, the
  same declarative discipline as the rest of the system.
- **Behaviour:** auto-run once per user per page (then never again unless replayed); always replayable
  from the help affordance (§4). "Seen" state persists **server-side per user** (works across devices —
  not browser storage, which is per-device and clears).
- **Cutting-edge + accessible:** spotlight/coach-mark with focus management, full keyboard nav, ARIA
  live regions, theme-aware, respects `prefers-reduced-motion`. A lightweight in-house component that
  matches DESIGN_CONVENTIONS (drawer/anatomy conventions apply), so tours feel native, not bolted-on.
- A **"what's new"** variant (highlight a newly shipped feature on a page) is a natural later extension
  of the same engine.

## 2. AI help drawer
Always-available, **page-aware** (it knows what page you're on and seeds context). Answers from three
governed sources, **every answer cited**:
- **(a) Approved knowledge library** (§3) — cited to the entry.
- **(b) Product documentation** — cited to the doc/section.
- **(c) The user's live data** — the sensitive, powerful tier. Non-negotiable architecture:
  - The AI answers live-data questions **only by calling the same permission-checked read models the UI
    uses** (exposed as bounded, scoped "tools"), never by composing raw queries. So a figure in an AI
    answer is the *same* number the screen shows — one source of truth, no divergent second path.
  - It runs **as the asking user** — same permissions, same tenant. A CRM asking about their client sees
    their client; they cannot ask about another org's. Permission parity is enforced by the read models,
    not a privileged service account.
  - Live-data answers carry the app's honesty through: estimate labelled *estimate*, "reviewed not
    assured", honest gaps, as-at + provenance. The AI inherits the honest states; it does not launder
    them into confident prose.
- **Honest abstention:** if no permitted, citable source answers the question, the AI says so plainly
  and offers to **capture it** (§3) — it never fabricates to fill the gap.
- **The AI never mutates app data.** Read + answer + *draft a library entry* is the entire write surface,
  and the draft is gated by approval. No exceptions.
- **Injection boundary:** retrieved content — library, docs, and especially live data — is treated as
  **data, not instructions**, per the app's standing rule. Approved entries are trusted content but the
  boundary still holds.

## 3. Knowledge library — capture → approve → two-tier publish
The flywheel, built as a governed content pipeline mirroring the rest of the spine.
- **Capture:** after any answer, any team member can "add to the knowledge library" — creates a **draft**
  (question + answer; if the answer was AI-drafted it pre-fills, fully editable). An **AI-drafted answer
  never enters the library without human approval** — the AI proposes, a person ratifies. That's the
  integrity guarantee that makes the library citable.
- **Review queue → internal approval:** a **nominated approver** (`knowledge.approve` capability)
  approves / edits / rejects. Approved = **internal**: live for staff and grounds the AI drawer.
- **Public promotion:** a second action (`knowledge.publish` capability) marks an internal entry
  **public / website-ready**, with client-facing wording review. Keeps a firewall between internal
  know-how and client-facing content.
- **Governed like everything else:** entries are **versioned**, carry **provenance** (who asked, who
  drafted — AI or human, who approved, who published, timestamps), **deactivate-not-delete**, fully
  audited. A material edit to an approved entry supersedes and requires re-approval.
- **Duplicate handling — no clashes (Francis, 16 Sep 2026).** Capturing must never spawn duplicate or
  colliding entries:
  - **Idempotent capture.** Capturing from an answer opens or reopens **one** draft — a second click
    never stacks a second form. A user has at most one open draft per answer.
  - **Detect before it's created.** Before a draft is saved, search **approved entries + pending drafts**
    for similar questions (text / embedding similarity) and surface the matches: the user can open the
    existing answer, **add their phrasing as an alias** to it, or proceed with a new draft **flagged
    "possible duplicate"** for the approver. Most near-duplicates resolve here, before the queue.
  - **Canonical question + aliases.** An entry holds one canonical question and a set of alias
    phrasings; a rephrasing folds in as an alias rather than a new entry — which also **improves AI
    grounding** (more phrasings resolve to the one approved answer), and means that once something is in
    the library the AI answers it directly, so it rarely needs re-capturing at all.
  - **Merge / reject-as-duplicate at review.** The queue **groups likely-duplicate drafts**; an approver
    merges them or rejects one as a duplicate-of an existing entry — two entries never say the same thing.
  - **Concurrency.** Drafts and entries carry `expectedVersion` (the spine's optimistic-concurrency
    rule); two people editing the same draft can't clobber each other — a stale write is refused and
    rebased, never silently overwritten.
  - No brittle exact-string unique constraint (near-dupes slip it and legitimate re-asks would clash);
    dedup is a **surfaced, human-adjudicated** step plus the canonical/alias model, with hard uniqueness
    only on an entry's canonical key **after** approval.
- **Feeds the website:** the public tier is the source for the future website knowledge base (export/API
  a later phase; the visibility model is built for it now).
- **Categorisation:** entries tagged by area/page so the AI grounds well and the library is browsable;
  reuse the domain vocabulary already in the app.

## 4. The help affordance
A single, consistent entry point on **every page** (e.g. a `?` in the top bar) opening the help drawer,
offering: **replay this page's tour**, **ask the AI**, **browse the knowledge library** — all page-aware.
One surface, three capabilities, always in the same place, theme-aware, keyboard-reachable.

## 5. Phasing (design now; build alongside each page, per Francis's plan)
- **Phase 0 — shared framework (build once, now-ish):** the help drawer shell + affordance; the
  declarative **tour engine** + per-user seen-state; the **knowledge library** data model + capture +
  two-tier approval pipeline + the two capabilities (new matrix version); the **AI grounding
  architecture** — retrieval + citation + honest abstention over library + docs. This is the reusable
  spine.
- **Phase 1 — grounded AI (library + docs).** The drawer answers from approved knowledge + docs, cited,
  with honest abstention + capture. The flywheel starts turning at lower risk.
- **Phase 2 — live-data answering.** Add the scoped read-model tools + permission-parity execution so the
  AI answers about the user's own data. The biggest, most sensitive tier — deliberately after the
  framework and grounded tier are proven. (This is Francis's chosen end-state; phasing it de-risks it
  without dropping it.)
- **Per page, as each is completed:** author that page's **tour definition**, seed its **initial
  knowledge entries**, and register its **read-model tools** for the live-data tier.
- **Later:** public-tier **website export**.

## 6. Permissions
- `knowledge.approve` (internal approval) and `knowledge.publish` (public promotion) — held by nominated
  team members; a **new permission-matrix version** (via the generator, never an edit). Capture is open
  to all team members; the drawer + tours are available to all users. The live-data tier answers strictly
  within the asking user's existing permissions — it grants no new data access.

## Cutting-edge techniques (what makes it world-class)
- **Grounded, cited RAG with honest abstention** — trustworthy AI that says "I don't know," not a
  confident hallucinator.
- **Permission-parity live-data answering via scoped tools** — the AI sees exactly what you see, from the
  same resolvers, so it can never leak across tenants or diverge from the UI's numbers.
- **A human-in-the-loop knowledge flywheel** with two-tier governance — every question compounds into
  approved, reusable, eventually-public knowledge, integrity preserved by approval.
- **Declarative, accessible, resumable tours** — native-feeling, cross-device, reduced-motion-aware.
- **Page-aware contextual help** — help meets you where you are.
All consistent with the governed spine: versioned, provenanced, permission-checked, honest.

## Acceptance (per phase; real data; on PRs)
- **Framework:** the affordance is on every page; a page's declarative tour runs once then replays on
  demand, cross-device; a captured question becomes a draft, is approvable to internal and promotable to
  public, all versioned + audited; the two capabilities gate approval/publish at a new matrix version.
- **Grounded AI:** answers cite an approved entry or doc; an unanswerable question yields honest
  abstention + a capture offer; no answer is emitted without a citation; retrieved content is treated as
  data.
- **Live-data AI:** an answer about the user's own data matches the UI's figure (same read model), carries
  its honest labels + as-at, and is impossible to obtain for data the user can't already see (tenant +
  permission parity, asserted by test); the AI never mutates app data.

## Rules
Branch + PR; typecheck AND build green; migrations via the runner + ledger (the knowledge model, the
matrix version); theme-aware; accessible; honest states; deactivate-not-delete; every mutation
permission-checked + audited; retrieved content is data, not instructions. NZC-069 held.
