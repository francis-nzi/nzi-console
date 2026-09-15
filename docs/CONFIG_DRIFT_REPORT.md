# Config drift report — `render.yaml` vs the Render dashboard

**Status: reconciled 16 September 2026 (NZC-079).** Phase 1 produced the inventory; Francis read the
dashboard; Phase 2 brought `render.yaml` into line with what is actually running. **No live value was
changed** — this file and `render.yaml` are documentation, and the point was to stop them lying.

## Result in one line

**Three differences out of eighteen declared values, and the two portal features everybody was
worried about turned out not to be flag-gated at all.**

| | |
|---|---|
| ✅ **Matched** | `NEXT_PUBLIC_APP_ENV`, `NEXT_PUBLIC_FEATURE_REPORT_STUDIO`, `NEXT_PUBLIC_FEATURE_JOB_MODULES`, `NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2` (same 12 tokens), `NODE_VERSION`, `NZI_DATA_MODE`, `NZI_DATABASE_BOUNDARY`, `NZI_DEMO_ORGANISATION_ID`, `NZI_ISOLATED_API_URL` |
| ⚠️ **Drifted** | `NZI_AUTH_ENABLED` and `NZI_AUTH_REQUIRED` — declared `"false"`, live `true` |
| ⚠️ **Missing from the file** | `NEXT_PUBLIC_FEATURE_PORTAL` = `portal-analytics,portal-actions` — live, undeclared |
| 🔎 **Unresolved** | The legacy tail (`MS_*`, `NZI_ENVIRONMENT`, `NZI_JWT_SECRET`, …) — deliberately not touched, §5 |

**Every feature flag matched.** The thing that would have meant "staging is not the build we think"
was not wrong. What *was* wrong is arguably more interesting: two client-facing portal surfaces have
no gate at all (§4).

**What changed in this pass:** `render.yaml` now records the live auth values with an explicit note
that their *intent* is unconfirmed; `NEXT_PUBLIC_FEATURE_PORTAL` is declared; and the false
"single source of truth" comment is replaced with what is actually true. The 12 `DATA_ENTRY_V2`
tokens are identical to the dashboard's but in a different order — left alone, since re-typing a
12-token list to match an ordering that has no behavioural meaning is risk without benefit.

---

**Scope:** the two services `render.yaml` describes — `nzi-console` (staging web) and
`nzi-console-reminders` (worker). **Production (`nzi-insights-pro-api-live`) is out of scope.**

**Why this exists.** Both services were created by hand, not from a Blueprint, so Render does not read
`render.yaml` for them. The effective configuration is whatever the dashboard holds. The risk is not
the file being untidy — it is **silent drift**: a redesign flag believed on that is off, or off that is
on, with staging quietly behaving unlike the thing we call the source of truth.

---

## 1. What the repo claims — and, mostly, already doesn't

The brief expected a spread of false "single source of truth" claims. There is essentially **one**,
and the rest of the repo already contradicts it.

### 1.1 The false claim

| File · line | Verbatim |
|---|---|
| `render.yaml` **:18–22** | `# Data-entry redesign flags (NZC-035/036/041/043/046). Gated rollout:`<br>`# render.yaml is the single source of truth (docs/REDESIGN_ROLLOUT.md`<br>`# §"Feature-flag strategy"), so every flip is a reviewed, source-controlled`<br>`# change. NEXT_PUBLIC_* is inlined at `next build`, so a change here forces`<br>`# a rebuild with the new set baked into the client bundle.` |

This is false on two counts: the file is not read for this service at all, and the document it cites
as its authority says the opposite (§1.2).

**It also contradicts itself, twice, further down the same file:**

| File · line | Verbatim |
|---|---|
| `render.yaml` **:37–39** | `# Report Studio (R-track) flags — own variable, build-inlined, flipped via`<br>`# the Render dashboard + rebuild (see docs/DEPLOYMENT.md). Kept here for`<br>`# continuity only.` |
| `render.yaml` **:43–46** | `# Job-family modules (Track C, NZC-024) — own variable, same dashboard-edit-`<br>`# plus-rebuild procedure. … continuity value here; the dashboard flip is still a manual step.` |

So two of the three flag variables are already documented as dashboard-driven "for continuity only",
in the same file where the first is called source-controlled truth.

### 1.2 Where the repo already tells the truth — leave these alone

These are **not** false claims and need no Phase 2 rewrite. They are the wording Phase 2 should make
`render.yaml` match:

| File · line | Verbatim |
|---|---|
| `docs/DEPLOYMENT.md` **:63–66** | `**The Render dashboard value is authoritative on this service, not `render.yaml`.** The env var was edited manually in the dashboard during an earlier rollout, and Render then stops syncing that key from the blueprint. `render.yaml` is kept in step **for continuity only** — merging a `render.yaml` change **does nothing to the running build**.` |
| `docs/REDESIGN_ROLLOUT.md` **:121–123** | ``render.yaml` carries the intended value for continuity, but **the Render dashboard value is authoritative on this service** and `NEXT_PUBLIC_*` is build-inlined — so a flip is a dashboard edit + rebuild, not a `render.yaml` merge.` |
| `docs/REDESIGN_ROLLOUT.md` **:264** | ``render.yaml` alone is cosmetic — see `DEPLOYMENT.md`` |
| `docs/ACCEPTANCE_R3_FIGURE_TOKENS.md` **:73** | ``render.yaml` was brought back into line with the dashboard-authoritative value` |
| `docs/ACCEPTANCE_PORTAL_A2_LITE.md` **:32, :44** | `confirmed in the dashboard-authoritative Render variable` · `append `portal-actions` to the dashboard-authoritative `NEXT_PUBLIC_FEATURE_PORTAL`` |
| `docs/ACCEPTANCE_PORTAL_PHASE2.md` **:145, :200** | `Behind build-time, dashboard-authoritative `NEXT_PUBLIC_FEATURE_PORTAL` tokens` · `dashboard-authoritative — **Clear build cache & deploy** to flip` |
| `docs/ACCEPTANCE_LCA_MODULE_SLICE7.md` **:6** | `built and carried in `render.yaml`, but the dashboard-authoritative staging flip is still pending` |

> **Finding.** The documentation was largely right already; `render.yaml`'s own comment is the outlier.
> Phase 2 is therefore a small, targeted correction rather than a sweep — and the more valuable half of
> this exercise is §3, finding whether the *values* have drifted.

### 1.3 A claim about a different thing — do not "fix" it

`docs/ACCEPTANCE_PORTAL_PHASE2.md:50` and several code comments call the **server** authoritative for
permission and session checks. That is a correctness statement about client-vs-server trust and has
nothing to do with deployment config. Out of scope.

---

## 2. Declared inventory — `render.yaml`, as written

Every declared item, verbatim. `sync: false` means the file declares the key but deliberately carries
no value (secrets); the dashboard must supply it.

> **This records the file as it stood at Phase 1, before reconciliation.** `render.yaml` has since been
> corrected (§6), so the two auth values now read `true` there and `NEXT_PUBLIC_FEATURE_PORTAL` has been
> added. The rows below are kept as the *before* picture — that is what makes the drift legible.

### 2.1 `nzi-console` — staging web service

| Setting | Declared in `render.yaml` |
|---|---|
| `type` | `web` |
| `runtime` | `node` |
| `region` | `frankfurt` |
| `plan` | `starter` |
| `branch` | `main` |
| `buildCommand` | `npm install && npm run build -w @nzi/console` |
| `startCommand` | `npm run start -w @nzi/console` |
| **`preDeployCommand`** | **ABSENT from the file** — the live gate is set in the dashboard only (NZC-077) |
| `healthCheckPath` | `/api/health` |
| `autoDeploy` | `true` |

**Environment — `nzi-console`**

| Key | Declared value |
|---|---|
| `NODE_VERSION` | `20.18.0` |
| `NEXT_PUBLIC_APP_ENV` | `staging` |
| 🚩 `NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2` | `spend,spend-import,portal-spend,commuting,vehicle,travel,client-factors,data-entry-accordion,job-stage-sections,data-assurance,entry-lean-capture,data-entry-fast-add` |
| 🚩 `NEXT_PUBLIC_FEATURE_REPORT_STUDIO` | `report-svg-charts,report-tokens,report-edit,report-paged` |
| 🚩 `NEXT_PUBLIC_FEATURE_JOB_MODULES` | `job-module-lca` |
| `NZI_DATA_MODE` | `isolated-api` |
| `NZI_DATABASE_BOUNDARY` | `isolated-non-production` |
| `NZI_DEMO_ORGANISATION_ID` | `demo-nzi-console` |
| `NZI_ISOLATED_API_URL` | `https://nzi-pro-api-prod.onrender.com` |
| `NZI_ISOLATED_DATABASE_URL` | `sync: false` (secret) |
| `NZI_AUTH_ENABLED` | `"false"` |
| `NZI_AUTH_REQUIRED` | `"false"` |
| `NZI_CONSOLE_SESSION_SECRET` | `sync: false` (secret) |
| `NZI_CONSOLE_MFA_ENCRYPTION_KEY` | `sync: false` (secret) |

🚩 **The three flagged rows are the highest-risk drift.** They are build-inlined at `next build`, so the
dashboard value at build time is what shipped in the bundle — the file's value has no effect whatever.
A mismatch here means staging is not the thing we believe we are testing.

> **Note on the auth pair.** `NZI_AUTH_ENABLED` / `NZI_AUTH_REQUIRED` are declared `"false"`, yet
> `/api/health` on staging currently reports `"authentication":"enabled","authenticationRequired":true`.
> That is almost certainly dashboard values overriding the file — i.e. **already-observed drift**, and
> the health endpoint is independent evidence for it. Confirm in §3.1 and treat the live values as
> correct unless Francis says otherwise.

### 2.2 `nzi-console-reminders` — worker

| Setting | Declared in `render.yaml` |
|---|---|
| `type` | `worker` |
| `runtime` | `node` |
| `region` | `frankfurt` |
| `plan` | `starter` |
| `branch` | `main` |
| `buildCommand` | `npm install` |
| `startCommand` | `npm run reminder-worker -w @nzi/isolated-backend` |
| `preDeployCommand` | **ABSENT, and deliberately so** — two services racing to apply the same migrations is worse than the fault the gate fixes (NZC-077) |
| `healthCheckPath` | n/a for a worker |
| `autoDeploy` | `true` |

**Environment — `nzi-console-reminders`**

| Key | Declared value |
|---|---|
| `NODE_VERSION` | `20.18.0` |
| `NEXT_PUBLIC_APP_ENV` | `staging` |
| `NZI_DATABASE_BOUNDARY` | `isolated-non-production` |
| `NZI_DEMO_ORGANISATION_ID` | `demo-nzi-console` |
| `NZI_ISOLATED_DATABASE_URL` | `sync: false` (secret) |
| `NZI_REMINDER_TICK_SECONDS` | `"900"` |
| ⛔ `NZI_MAIL_MODE` | **Deliberately absent.** Commented out at `render.yaml:115–116`. `mailDelivery()` requires the exact string `send`, so unset is the suppressing default |
| `SMTP_HOST` · `SMTP_PORT` · `SMTP_USER` · `SMTP_PASS` · `SMTP_FROM` · `SMTP_TLS` | all `sync: false` (secrets) |

⛔ **The one check that matters most on this service.** Staging must never email a real client. Three
things independently prevent it — an isolated boundary, `NEXT_PUBLIC_APP_ENV` ≠ `production`, and
`NZI_MAIL_MODE` ≠ `send` — and the boundary alone is decisive. **If `NZI_MAIL_MODE=send` is present in
the dashboard, say so immediately**: it would not enable sending on its own here, but it is the single
edit closest to doing so, and it must not be on this service.

---

## 3. Comparison checklist — to fill from the dashboard

Read each value from the Render dashboard and write it in. Where it matches, `✓` is enough; where it
differs, write the **actual** value — that is the finding.

### 3.1 `nzi-console` — Environment tab · READ 16 Sep 2026

| Key | Declared | Dashboard actual | Matches? |
|---|---|---|---|
| `NODE_VERSION` | `20.18.0` | ✓ | ✓ |
| `NEXT_PUBLIC_APP_ENV` | `staging` | ✓ | ✓ |
| 🚩 `NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2` | `spend,spend-import,portal-spend,commuting,vehicle,travel,client-factors,data-entry-accordion,job-stage-sections,data-assurance,entry-lean-capture,data-entry-fast-add` | ✓ | ✓ |
| 🚩 `NEXT_PUBLIC_FEATURE_REPORT_STUDIO` | `report-svg-charts,report-tokens,report-edit,report-paged` | ✓ | ✓ |
| 🚩 `NEXT_PUBLIC_FEATURE_JOB_MODULES` | `job-module-lca` | ✓ | ✓ |
| `NZI_DATA_MODE` | `isolated-api` | ✓ | ✓ |
| `NZI_DATABASE_BOUNDARY` | `isolated-non-production` | ✓ | ✓ |
| `NZI_DEMO_ORGANISATION_ID` | `demo-nzi-console` | ✓ | ✓ |
| `NZI_ISOLATED_API_URL` | `https://nzi-pro-api-prod.onrender.com` | ✓ | ✓ |
| `NZI_ISOLATED_DATABASE_URL` | *(secret — set?)* | present / absent | |
| ⚠️ `NZI_AUTH_ENABLED` | `"false"` | `true` | **NO — drifted** |
| ⚠️ `NZI_AUTH_REQUIRED` | `"false"` | `true` | **NO — drifted** |
| `NZI_CONSOLE_SESSION_SECRET` | *(secret — set?)* | present / absent | |
| `NZI_CONSOLE_MFA_ENCRYPTION_KEY` | *(secret — set?)* | present / absent | |
| ⚠️ `NEXT_PUBLIC_FEATURE_PORTAL` | *(not declared)* | `portal-analytics,portal-actions` | **NO — missing from file** |
| 🔎 `MS_*`, `NZI_ENVIRONMENT`, `NZI_JWT_SECRET`, … | *(not declared)* | present — legacy tail | see §5, not actioned |

**Never write a secret's value into this file.** For the three `sync: false` keys, "present" or
"absent" is the whole answer.

### 3.2 `nzi-console` — Settings → Deploy · NOT YET READ

| Setting | Declared | Dashboard actual | Matches? |
|---|---|---|---|
| Build Command | `npm install && npm run build -w @nzi/console` | | |
| Start Command | `npm run start -w @nzi/console` | | |
| **Pre-Deploy Command** | *absent from file* — expected `npm run migrate -w @nzi/isolated-backend` | | |
| Auto-Deploy | `true` (on) | | |
| Health Check Path | `/api/health` | | |
| Branch | `main` | | |
| Region | `frankfurt` | | |
| Instance type / plan | `starter` | | |

> Instance type is load-bearing beyond cost: a pre-deploy command is unavailable on Render's **Free**
> instance, so dropping off a paid plan removes the migration gate **without an error**.

### 3.3 `nzi-console-reminders` — Environment tab · ⚠️ NOT YET READ

| Key | Declared | Dashboard actual | Matches? |
|---|---|---|---|
| `NODE_VERSION` | `20.18.0` | | |
| `NEXT_PUBLIC_APP_ENV` | `staging` | | |
| `NZI_DATABASE_BOUNDARY` | `isolated-non-production` | | |
| `NZI_DEMO_ORGANISATION_ID` | `demo-nzi-console` | | |
| `NZI_ISOLATED_DATABASE_URL` | *(secret — set?)* | present / absent | |
| `NZI_REMINDER_TICK_SECONDS` | `"900"` | | |
| ⛔ `NZI_MAIL_MODE` | **must be absent** | present / absent | |
| `SMTP_HOST` | *(secret)* | present / absent | |
| `SMTP_PORT` | *(secret)* | present / absent | |
| `SMTP_USER` | *(secret)* | present / absent | |
| `SMTP_PASS` | *(secret)* | present / absent | |
| `SMTP_FROM` | *(secret)* | present / absent | |
| `SMTP_TLS` | *(secret)* | present / absent | |
| — | *Any key in the dashboard **not** listed above* | | ⚠️ list it |

> **⚠️ The worker has not been reconciled.** The readout covered `nzi-console` only. The worker tables
> below are still the Phase 1 checklist, unfilled. **`NZI_MAIL_MODE` is the one to check first** — it
> must be absent, and it is the single edit closest to putting mail on the wire from a service that
> must never write to a real client. Until it is read, this report says nothing about the worker.

### 3.4 `nzi-console-reminders` — Settings → Deploy · ⚠️ NOT YET READ

| Setting | Declared | Dashboard actual | Matches? |
|---|---|---|---|
| Build Command | `npm install` | | |
| Start Command | `npm run reminder-worker -w @nzi/isolated-backend` | | |
| **Pre-Deploy Command** | *none, deliberately* | | |
| Auto-Deploy | `true` (on) | | |
| Branch | `main` | | |
| Region | `frankfurt` | | |
| Instance type / plan | `starter` | | |

---

## 4. Are the portal features actually live? — traced in the code

The question that mattered: are the portal plan and readiness statement merged but **dark** on
staging, gated on a token that isn't set?

**No — and not because the tokens are set. Because neither feature is gated at all.**

`portalFeatureEnabled()` (`apps/console/app/lib/portalFlags.ts`) knows exactly two tokens, and every
call site in the app is accounted for here:

| Token | What it gates | In the live value? | Effect |
|---|---|---|---|
| `portal-analytics` | `/portal/intensity` (redirects away when off) · `/portal/jobs/[jobId]/dashboard` (redirects away when off) · the "Emissions dashboard" link on the portal home | ✅ yes | **Live** |
| `portal-actions` | `PortalActionTrackerPanel` on the job dashboard | ✅ yes | **Live** |

| Feature | Gate | Status on staging |
|---|---|---|
| Portal reduction plan (**#173**) | **None.** `<PortalReductionPlan/>` renders unconditionally at `PortalHome.tsx:25`; the component contains no flag reference | **Live** |
| Portal SRS readiness statement (**#177**) | **None.** `<PortalReadiness/>` renders unconditionally at `PortalHome.tsx:28`; the component contains no flag reference | **Live** |
| `/api/portal/strategies`, `/api/portal/readiness` | **None** — neither route consults a flag | **Live** |

> **The finding, stated plainly.** Nothing is dark. But two client-facing surfaces shipped with **no
> rollout gate**, while every other portal Phase 2 surface sits behind a token. `REDESIGN_ROLLOUT.md`
> §"Feature-flag strategy" says new UI stays behind a flag until its acceptance pass — these did not.
>
> It did no harm here: both are read-only, tenant-scoped, and were merged deliberately. But it means
> there is **no way to turn either off without a revert**, which is exactly what a flag buys. Worth a
> decision — add `portal-plan` / `portal-readiness` tokens retrospectively, or record that these two
> were intentionally ungated. Not actioned in this pass; it changes behaviour, and this pass does not.
>
> *(The brief cited the readiness statement as #183; that was the estimate-entry form. Readiness
> shipped as #177 — corrected above.)*

## 5. The legacy tail — deliberately untouched

The dashboard carries keys `render.yaml` never declared: `MS_*`, `NZI_ENVIRONMENT`, `NZI_JWT_SECRET`
and others. **None was removed, and none should be on this evidence.**

`NZI_JWT_SECRET` is the clearest reason for caution: auth is **enabled and required** on this service
(§3.1), so a secret that looks like dead weight from the recycled service it was created on may be
load-bearing for the auth that is actually running. Removing it to tidy a list would be the kind of
cleanup that takes staging down.

Each key needs its own check — genuinely unreferenced in the code, and genuinely unread at runtime —
before anything is deleted. That is its own careful pass, not a sweep.

## 6. What Phase 2 did, and what is still open

1. **Brought `render.yaml` into line with reality** — the two auth values, and the missing
   `NEXT_PUBLIC_FEATURE_PORTAL` key, each with a comment saying what it reflects and what is still
   unconfirmed. No live value was changed.
2. **Corrected the false claim** at `render.yaml:18–22`, to the wording `DEPLOYMENT.md` already used.
3. **Recorded NZC-079** — the dashboard is the effective source of truth for these manually-created
   services; `render.yaml` is documentation and the carrier for a future Blueprint rebuild; Blueprint
   adoption is recommended but deliberately not done, since it risks duplicating live services.

**Still open, each needing a decision rather than a merge:**

- **The auth pair's intent** (§3.1) — deliberate, or inherited from the recycled service? The file now
  records the live values; nobody has confirmed they are wanted.
- **The ungated portal surfaces** (§4) — retrofit tokens, or record that they are intentionally always-on.
- **The legacy tail** (§5) — one careful pass, per key, before anything is removed.
- **Blueprint adoption** — the end state that would make this file authoritative again, and make this
  whole class of drift impossible.
