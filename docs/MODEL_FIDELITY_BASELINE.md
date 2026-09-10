# NZI Console — Baseline & Re-Baselining Model Fidelity Assessment

**Question addressed (Francis, 10 Sep 2026):** raised while fixing J000699 (Silent Sounds), whose baseline
was moved to its own reporting year but whose report still showed both a baseline column and a prior-year
column. The live question — *should re-baselining overwrite `Client → Targets` or be recorded properly?* — is
answered in the live repo's `RE_BASELINING_DESIGN.md`. This is the console-side companion: **the redesign has
already re-adopted the model that failed**, in NZC-064 (confirmed 9 Sep 2026), and NZC-059 and NZC-060 are
built on top of it. Same shape as `MODEL_FIDELITY_JOB_FAMILIES.md`: what live actually does, what the console
now does, what must change, and when.

**Method.** Live `nzi_pro_v7-POSTGRES` working tree as at 10 Sep 2026 — read directly, **not** via
`nzi-live-fix/`, which is a ~24 Aug snapshot and predates every finding below. Sources:
`api/job_report_routes.py`, `api/job_live_report_routes.py`, `api/client_reporting_routes.py`,
`api/chart_generation.py`, `api/report_template_routes.py`, `services/client_benchmark.py`,
`frontend/src/components/report-widgets/pathway-data.ts`, `frontend/src/components/ClientPathwayCharts.tsx`,
`frontend/src/components/ClientReporting.tsx`, `schema.sql`, `sql_migrations/`. Console side:
`DECISIONS.md` NZC-059, NZC-060, NZC-064; `WORKFLOWS.md` §2.

---

## 0. Verdict

**The baseline is not one thing in the live data model — it is four, and re-baselining writes to one of them.
The console has carried the same shape forward, and three confirmed decisions now sit on it.**

- **Live storage is split four ways.** `clients.benchmark_period_start/end` (the *label*),
  `clients.benchmark_year` (the *resolution*), `clients.benchmark_scope_1/2/3_tco2e` +
  `benchmark_total_tco2e` (*cached figures* that can drift from whatever job resolves), and
  `jobs.is_benchmark` (a tiebreak in one query). There is **no baseline history**. Which field is
  populated decides which of them a given screen believes.
- **It is not three resolvers. It is eleven.** Eight independent derivations of *which year* is the
  baseline — four of them the same rule implemented separately — plus three more in the pathway charts, and
  four separate resolutions of *which job or figures* the baseline is. Full table in §1.
- **The 10 Sep guard is unreachable for most clients.** `job_is_its_own_baseline` is correct but lives
  inside `_resolve_benchmark_reference_job`, and `get_benchmark_emissions` returns the cached
  `clients.benchmark_*_tco2e` **before it ever calls the resolver**. It worked for Silent Sounds only
  because that client's cached figures were null.
- **Overwriting retroactively rewrites history.** `clients.benchmark_*` is read at render time, so changing
  it moves every report that client has ever had. Reissue a 2024 report today and it compares against a
  year that had not happened when it was written.
- **Targets are bare percentages with no baseline reference.** `net_zero_target_reduction_pct`,
  `interim_s1/2/3_pct`, `target_s1/2/3_pct` on `clients`. A percentage reduction is meaningless without the
  baseline it reduces from — so re-baselining silently redefines whether every client is on track.
- **The console has inherited the shape, not the split.** NZC-064's Targets tab is a single mutable record
  on `clients` (migration `0060`) carrying baseline period + historical S1/S2/S3 + total. It is *better*
  than live in that the save is atomic and versioned — but `clients.version` records **that** a save
  happened, not **what the baseline was before it**. A reissued report still cannot reproduce itself.
- **Two confirmed decisions depend on that record being stable.** NZC-059 renders "% vs BL" as
  `current ÷ baseline − 1` resolved against it; NZC-060's gap engine generalises YoY variance "from a single
  prior to baseline + multi-year" against it. A Targets-tab save moves both, retrospectively, with no record.

**What must change, and when:** §4. The short version is that it is cheap now — `0060`'s Targets tab is
still being built — and expensive once consultants have entered baselines through it.

---

## 1. Live: the eleven derivations

### Which *year* is the baseline

| # | Location | Rule |
|---|---|---|
| 1 | `api/job_report_routes.py:3007` `get_job_target_data` | `jobs.baseline_year` ?? `clients.benchmark_year` — **no period fallback** |
| 2 | `api/job_report_routes.py:2483` `get_benchmark_emissions` | `benchmark_year` ?? `jobs.baseline_year` |
| 3 | `api/job_live_report_routes.py:330` `_early_benchmark_year` | `benchmark_year` ?? `YEAR(benchmark_period_end)` |
| 4 | `api/job_live_report_routes.py:450` `_effective_benchmark_year` | same rule again — and it overwrites `job_data["benchmark_year"]` in the response payload |
| 5 | `api/job_live_report_routes.py:270` in `_build_yearly_emissions` | same rule, third time |
| 6 | `api/client_reporting_routes.py:186` | same rule, fourth time |
| 7 | `api/chart_generation.py:945` | `target_data.baseline_year` ?? `reporting_year - 1` ?? **literal `2023`** |
| 8 | `frontend/.../ClientReporting.tsx:113` | `years[0]` — earliest year on file; ignores the client record entirely |

Plus three in the pathway charts, each `benchmarkYear ?? firstHistoricalYear ?? currentYear`:
`report-widgets/pathway-data.ts:52`, `ClientPathwayCharts.tsx:145` (emissions) and
`ClientPathwayCharts.tsx:186` (intensity). The last two differ from one another — `:145` starts the chart at
the baseline year, `:186` at the first historical year — so **the two pathway charts on the same screen can
start in different years for the same client.**

### Which *job or figures* are the baseline

`get_benchmark_emissions` (cached client figures, else the resolver) · `_resolve_benchmark_reference_job`
(`job_report_routes.py:2363`, four priority tiers, does **not** exclude archived jobs) ·
`job_live_report_routes.py:465` (its own benchmark-job query, which **does** exclude archived) ·
`client_reporting_routes.py:128` `_synthetic_benchmark_scope_entry`.

Two resolvers over the same data with different archived-job handling will pick different baseline jobs for
the same client. That is not a hypothetical; it is what the code says.

### Incidental defects found in the same pass

- `job_is_its_own_baseline` compares `benchmark_period_*` to `reporting_period_*` as exact 10-character
  string equality. A baseline period differing by one day, or stored at different precision, is not detected.
- `_build_yearly_emissions` derives `dashboard_year` as
  `COALESCE(EXTRACT(YEAR FROM reporting_period_end), reporting_year)` but orders on the **reverse**
  `COALESCE`. Latent today (no job in the estate has the two disagreeing) but a drift trap.
- The same function deduplicated to the **highest `job_id`** per year — insertion order, not authority.
  Corrected 10 Sep; see §3 for the rule that replaced it, which matters to the console.
- `jobs.baseline_year` is populated in **0 of 753 rows**, is read in two places, is a **required report
  template variable** (`report_template_routes.py:77`), and **is not in `schema.sql` or any file in
  `sql_migrations/`**. Nothing in the repo appears to have created it.

---

## 2. Console: what NZC-064 actually built

The Targets tab (NZC-064, migration `0060`) carries, on `clients`: net-zero year/%, **baseline period**,
**historical baseline S1/S2/S3 + total**, per-scope interim year/%. Saved atomically through
`client.update` with `expectedVersion`, one audit event per save, bumping `clients.version`.

This is a genuine improvement on live in three respects — one record not four, no request-time DDL, and a
concurrent edit conflicts rather than half-applying. It does not solve the problem, because:

1. **A version bump is not a history.** `clients.version` says a save occurred. It does not say what the
   baseline was before, who changed it, why, or from which reporting period the new one takes effect. A
   reissued report resolves against whatever the record says *now*.
2. **Forward comparison is still possible by construction.** Nothing stops a baseline period later than a
   report's own reporting period, which is exactly the J000699 failure.
3. **NZC-059's "% vs BL" resolves at render.** `current ÷ baseline − 1` computed against a mutable field
   means a Targets-tab save silently restates every historical percentage in the trend table.
4. **NZC-060's gap engine inherits it.** Flag type (1) compares against "baseline + multi-year". Move the
   baseline and previously-clear datasets can acquire flags, or lose them, with no event explaining why.
5. **Targets have no baseline reference.** Same as live. The net-zero and interim percentages sit beside the
   baseline figures in the same tab with no relation between them, so a re-baseline redefines the target
   without touching the target fields.

**Assessment: NZC-064's Details, Address and Compliance tabs are sound and unaffected. The Targets tab's
baseline fields are the part that needs superseding** — and it is the cheapest possible moment to do it,
because no consultant has entered a baseline through that surface yet.

---

## 3. What the redesign must carry forward

Three things the live platform gets *right*, or has since learned, that must survive into the console:

- **Typed figures as well as a job reference.** Some clients' baselines predate the platform entirely; that
  is what live's cached `benchmark_*_tco2e` columns are genuinely for, and NZC-064 correctly kept them. Any
  replacement must accept *either* a baseline job *or* typed-in scope figures as first-class, not treat
  typed figures as a degraded case.
- **The reporting-year eligibility rule (live, 10 Sep).** `_build_yearly_emissions` now treats a job as
  representing a year only if its reporting period is **300–400 days**; among eligible jobs it takes the
  latest `reporting_period_end` then the highest `job_id`; ineligible jobs are **excluded**, and a
  client-year with no eligible job produces **no point** rather than a wrong one. Live found stub jobs
  (30–63 days) and multi-year jobs (452–790 days) standing in for reporting years across several clients.
  The console's five-year trend (NZC-059) needs the same rule, or it will plot a 790-day total as one year.
- **A baseline built on a non-annual job is a bad baseline.** The clients above are precisely the ones whose
  baselines should not be migrated as verified. Any seed must be able to mark a record
  `migrated_unverified` and have the resolver decline to compare against it, rather than silently treating a
  two-year total as a base year.

---

## 4. Proposed model

Four decisions, drafted as NZC-065 to NZC-068. NZC-068 is **Open** and blocks the Targets tab.

**NZC-065 — the baseline is a dated record.** A `client_baselines` table: client, period start/end, either a
baseline job reference *or* typed scope figures, `kind` (`initial` | `rebaseline` | `recalculation` — GHG
Protocol treats base-year *recalculation* after a structural change differently from choosing a new base
year, and they carry different disclosure obligations), `source` (`declared` | `migrated_unverified`),
reason, set_by, set_at, `effective_from` (the first reporting period it governs, which is not the same as
when it was entered), superseded_at. Plus a client-level significance threshold, since a base-year
recalculation policy has to state one. Supersedes the baseline fields of NZC-064's Targets tab; the rest of
NZC-064 stands.

**NZC-066 — issued reports stamp their baseline.** A dated record resolved at render time is still not
reproducible: correct a mis-entered row in 2027 and every historical report moves again. On issue, stamp the
resolved baseline onto the job (baseline id + the figures used + resolved_at). Reissuing replays the
snapshot. NZC-059's "% vs BL" reads the stamp for an issued report, and resolves live only for one not yet
issued. `client_baselines` is the *policy* record; the stamp is the *reproducibility*.

**NZC-067 — one resolver.** `resolveBaseline(clientId, periodStart, periodEnd)` returning period, figures,
source, and whether the job is its own baseline. The rule **never look earlier than the baseline in force**
lives in it and nowhere else. Sole consumer for the NZC-059 trend table, the pathway charts, NZC-060's gap
engine and the portal — so the eleven-derivation failure cannot recur. The frontend receives the resolved
baseline in the payload rather than re-deriving it.

**NZC-068 — targets: pin or recalculate? [Open]** Either targets reference a baseline record — history
preserved, but a re-baselined client's stated target no longer matches its current baseline — or a
re-baseline forces an explicit target recalculation, which keeps them consistent but changes whether clients
are on track, visibly. This is a commercial answer, not a technical one, and it determines the shape of both
`client_baselines` and the Targets tab. **It should be answered before more of `0060` is built.**

---

## 5. Sequencing

| | | |
|---|---|---|
| **Now** | Answer NZC-068. | Blocks the Targets tab; nothing else can be finalised around it. |
| **Then** | Confirm NZC-065–067; amend NZC-064 to exclude the baseline fields. | Cheap while no baseline has been entered through the new surface. |
| **Then** | `resolveBaseline()` + the 300–400-day eligibility rule, behind the existing trend/assurance work. | NZC-059 and NZC-060 become consumers rather than re-implementations. |
| **Then** | `client_baselines` migration + the issue-time stamp. | |
| **Not yet** | Any migration of live baseline data. | Live's own step 1.5 triage — which client-years have no annual job, which cached figures disagree with the job that resolves — must complete first. Seeding blind converts known-bad data into an audit record, which is worse than a cache. |

---

## 6. Cross-reference

The live-platform side of this work is `RE_BASELINING_DESIGN.md` in `nzi_pro_v7-POSTGRES`, which carries the
remediation sequence for the production system, the triage categories for the ~116 mismatched jobs, and the
four open questions for the live platform. NZC-068 is the same question as that document's open question 1;
they must be answered once, not twice.

`nzi-live-fix/` in this repo is a ~24 Aug snapshot and does **not** contain any of the 10 Sep findings or
fixes. Cite the live tree, not the snapshot, for anything in this document.
