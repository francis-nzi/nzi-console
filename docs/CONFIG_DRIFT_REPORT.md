# Config drift report — `render.yaml` vs the Render dashboard

**Phase 1 (repo-side inventory). Working document — the right-hand columns are for Francis to fill
from the dashboard.** Nothing is fixed here: Phase 2 reconciles, and any drift that changes staging
behaviour is a dashboard action, not a merge.

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

### 3.1 `nzi-console` — Environment tab

| Key | Declared | Dashboard actual | Matches? |
|---|---|---|---|
| `NODE_VERSION` | `20.18.0` | | |
| `NEXT_PUBLIC_APP_ENV` | `staging` | | |
| 🚩 `NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2` | `spend,spend-import,portal-spend,commuting,vehicle,travel,client-factors,data-entry-accordion,job-stage-sections,data-assurance,entry-lean-capture,data-entry-fast-add` | | |
| 🚩 `NEXT_PUBLIC_FEATURE_REPORT_STUDIO` | `report-svg-charts,report-tokens,report-edit,report-paged` | | |
| 🚩 `NEXT_PUBLIC_FEATURE_JOB_MODULES` | `job-module-lca` | | |
| `NZI_DATA_MODE` | `isolated-api` | | |
| `NZI_DATABASE_BOUNDARY` | `isolated-non-production` | | |
| `NZI_DEMO_ORGANISATION_ID` | `demo-nzi-console` | | |
| `NZI_ISOLATED_API_URL` | `https://nzi-pro-api-prod.onrender.com` | | |
| `NZI_ISOLATED_DATABASE_URL` | *(secret — set?)* | present / absent | |
| `NZI_AUTH_ENABLED` | `"false"` | | |
| `NZI_AUTH_REQUIRED` | `"false"` | | |
| `NZI_CONSOLE_SESSION_SECRET` | *(secret — set?)* | present / absent | |
| `NZI_CONSOLE_MFA_ENCRYPTION_KEY` | *(secret — set?)* | present / absent | |
| — | *Any key in the dashboard **not** listed above* | | ⚠️ list it |

**Never write a secret's value into this file.** For the three `sync: false` keys, "present" or
"absent" is the whole answer.

### 3.2 `nzi-console` — Settings → Deploy

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

### 3.3 `nzi-console-reminders` — Environment tab

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

### 3.4 `nzi-console-reminders` — Settings → Deploy

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

## 4. What Phase 2 does with this

1. **Act on value drift first.** A flag difference is a live behavioural bug, not a documentation nit —
   staging is not the build we think we are testing. Each drift is Francis's call per item: update
   `render.yaml` to match reality where the live value is right, or change the dashboard where the file
   held the intent. **Dashboard changes are Francis's to apply.**
2. **Correct the one false claim** at `render.yaml:18–22`, to match the wording `DEPLOYMENT.md` already
   uses. Re-grep to prove none remains.
3. **Record the NZC decision**: for these manually-created services the dashboard is the effective
   source of truth, `render.yaml` is documentation and the carrier for a future Blueprint rebuild, and
   **Blueprint adoption is recommended but deliberately not done** — it risks duplicating live services
   and deserves its own migration.
