# SRS Readiness — deep review (pre-redesign)

A review of the SRS Readiness tool before its redesign. It is positioned as a
**commercial / demo asset** — an intuitive assessment that shows a client (or prospect)
where they stand against the UK Sustainability Reporting Standards, with **output graphics
and data** compelling enough to win work. This review grounds the redesign in the real
framework, assesses the current tool, and specifies the assessment model, the output
graphics, and the open decisions.

---

## 1. Why this matters now (the commercial window)

- **UK SRS S1 and S2 were published on 25 February 2026** as the UK-endorsed versions of
  the ISSB's IFRS S1 and S2. They are **currently voluntary**.
- **Mandatory requirements are proposed for early 2027** (FCA consultation closed 20 March
  2026) — first for listed companies by listing category, and likely "economically
  significant" private companies (term still being defined).
- So there is a **12–18 month voluntary window** in which companies want to know *"how ready
  are we, and what's the path?"* — before it's compulsory. A readiness tool that answers
  that clearly, with credible graphics, is a direct lead-generation and upsell asset for NZI.

**Design implication:** the tool must work for two audiences — an **existing client**
(operational: track and close gaps) and a **prospect in a demo** (persuasive: a clear
picture and an obvious next step, i.e. engaging NZI). The output graphics serve the second
audience especially.

## 2. What UK SRS actually requires (the structure to assess against)

UK SRS is a UK endorsement of ISSB, which consolidated TCFD. The disclosure architecture is
**two standards over four pillars**:

- **UK SRS S1** — general sustainability-related financial disclosures (any material
  sustainability risk/opportunity).
- **UK SRS S2** — climate-specific disclosures (the deeper, more prescriptive one; where
  most readiness effort lands first).

Both are organised on the **four TCFD/ISSB pillars**:

1. **Governance** — the board/management oversight of sustainability risks & opportunities.
2. **Strategy** — material risks/opportunities, their effects on the business model,
   strategy and financial position, and **scenario analysis / climate resilience**.
3. **Risk management** — how sustainability risks are identified, assessed, managed and
   integrated into enterprise risk.
4. **Metrics & targets** — the GHG inventory (Scope 1/2/3), other cross-industry and
   industry-based metrics, and the targets set (this is where NZI's core measurement work
   plugs straight in).

**Design implication:** the assessment is a matrix of **S1 / S2 × the four pillars**, broken
into concrete disclosure requirements. Metrics & targets should **pull from the client's
existing NZI data** (footprint, targets, intensity) rather than ask again — an instant,
credible "you're already partway there" moment in a demo.

## 3. The current tool — what it does, where it falls short

Today (`srs_readiness_routes`, migration 0065; surfaced in the console and, lightly, in the
portal — M6.4): a **per-client readiness questionnaire** that rolls up to an overall
percentage and a per-pillar status (the live screen shows "Overall readiness 62% ·
Governance On track · Metrics & targets Gaps").

Limits to fix in the redesign:

- **Percentage-only scoring** is thin — a single % doesn't tell a prospect *what* to do, and
  a naked number is easy to distrust. Needs **maturity levels + evidence + named gaps**.
- **No output graphics** worth demoing — no radar, no gap heatmap, no roadmap. This is the
  biggest miss for the commercial goal.
- **Not obviously linked** to the rest of the platform — readiness gaps should become
  **actions/levers**, and Metrics & targets should read the **assured footprint** already in
  NZI, not a re-keyed answer.
- **Questionnaire UX** is a flat form rather than a guided, sectioned, save-as-you-go
  assessment with progress and help-on-demand.

## 4. Design principles for the redesign

- **Guided, not a wall of questions.** Work pillar by pillar (S2 climate first, then S1),
  save-as-you-go, clear progress, plain-language help (InfoTip) on every requirement — a
  consultant *or* a client can drive it.
- **Maturity, not just yes/no.** Each requirement scored on a short ladder:
  **Not started → Developing → Established → Advanced → Assured** — so the output shows a
  journey, not a pass/fail.
- **Evidence-linked and honest.** Each requirement can carry evidence (a doc, a data point,
  a note); readiness that can't be evidenced is shown as such (truth-before-availability).
  No inflated scores.
- **Reuse NZI data.** Metrics & targets requirements pre-fill from the client's assured
  footprint, targets and intensity — the tool *recognises* what NZI already delivers.
- **Every gap has a next step.** A gap links to a **reduction/readiness action** (the
  action-lever library) with an owner and date — turning the assessment into a roadmap and,
  commercially, into scoped work for NZI.
- **Reassessable over time.** Readiness is dated and versioned; the tool shows the trend as
  the client improves (great for renewals).

## 5. The assessment model

```
UK SRS readiness (per client, dated + versioned)
 └─ Standard: S1 (general) · S2 (climate)
     └─ Pillar: Governance · Strategy · Risk management · Metrics & targets
         └─ Requirement (concrete disclosure item)
             ├─ Maturity: Not started / Developing / Established / Advanced / Assured
             ├─ Evidence: doc / data reference / note  (or "none")
             ├─ Owner + due date
             ├─ Source: entered  |  auto from NZI data (footprint/targets/intensity)
             └─ Gap → linked action (action-lever library)
```

Scoring rolls **requirement → pillar → standard → overall**, weighted (weights are
Admin-configurable). The framework itself (standards, pillars, requirements, weights,
maturity definitions) is **Admin-managed and versioned**, so it tracks UK SRS as it evolves
(e.g. when mandatory rules land in 2027) without a code change.

## 6. Output graphics & data (the demo-critical part)

The point of the redesign. All follow the dataviz rules — **status palette (good / warning /
serious / critical) for maturity, never the scope palette; texture as well as colour for
print/CVD; one axis**. Each renders identically on screen, in the portal, and in the report.

1. **Overall readiness header** — one honest headline: overall maturity (e.g. "Established ·
   62%") with a small confidence/evidence-coverage note ("48 of 61 requirements evidenced").
   A number *and* a level, never a bare %.
2. **Pillar radar (spider)** — the four pillars on one radar, S1 and S2 as two overlays.
   Instantly shows shape: "strong Governance, weak Metrics evidence." The single most
   demo-friendly graphic.
3. **Maturity ladder / bullet bars per pillar** — each pillar as a bar on the five-step
   ladder with a target marker — "where you are vs where SRS expects you." Print-safe and
   unambiguous.
4. **Gap heatmap** — requirements (rows) × maturity (colour), grouped by pillar — the
   at-a-glance "red list" of what's missing. Status colours + labels, never colour-alone.
5. **Readiness roadmap** — a timeline of the gaps-turned-actions with owners and target
   dates, ending at "SRS-ready" — the graphic that converts a prospect (it *is* the proposal).
6. **Evidence coverage** — % of requirements with evidence attached, by pillar — signals
   rigour and defensibility.
7. **Trend over time** — overall readiness across reassessments — the renewal story.
8. **(Stage 2) Sector benchmark** — readiness vs peers/sector. High demo value but **only
   with real, defensible data** — no fabricated peer numbers; hold until the data exists.

**Data outputs** (not just pictures): an exportable readiness register (requirement,
maturity, evidence, gap, owner, due) and a one-page **SRS Readiness statement** for the
report/portal — the leave-behind after a demo.

## 7. How it plugs into the rest of NZI

- **Metrics & targets pillar** ← reads the assured footprint, targets and intensity metrics
  already in the client (no re-keying; provenance carries through).
- **Gaps → Actions** → each gap becomes an action in the **action-lever library** (owner,
  date, sphere) — the readiness roadmap and the decarbonisation plan share the same spine.
- **Report** → the readiness dashboard + statement are a report section (R-track).
- **Portal** → the client sees their readiness and roadmap (M6.4), read-only, assured.
- **Permissions** → assessing is gated (`srs.manage` per NZC-022); the framework is
  Admin-managed.

## 8. Open decisions for Francis (before I prototype the redesign)

1. **Maturity scale** — the 5-step ladder above (Not started → Assured), or a scale you
   already use with clients? This shapes every graphic.
2. **S1 + S2 now, or S2 (climate) first?** S2 is deeper and closer to NZI's core; S1 is
   broader. Recommend leading with S2 in the demo, S1 alongside.
3. **Benchmark** — is there (or will there be) defensible sector/peer data? If not, benchmark
   is Stage 2 and the demo leans on the radar + roadmap instead.
4. **Framework authoring** — confirm the requirement set + weights live in the Admin Centre
   (versioned), so the tool tracks UK SRS changes without code.
5. **Assessment ownership** — consultant-led, client self-assessment in the portal, or both?
   (Affects the portal build.)

---

*Sources: UK SRS S1/S2 published 25 Feb 2026 as UK-endorsed IFRS S1/S2, currently voluntary,
mandatory proposed early 2027 (DLA Piper; PwC UK; FCA consultation). Four-pillar structure
per ISSB/TCFD. Live tool per `docs/WORKFLOWS.md` §5 (`srs_readiness`, migration 0065).*
