# NZI Console — deployment record

Isolated staging environment for the redesigned NZI Pro front-end. **Additive only** — separate repo,
service and (future) database. Does not touch the live NZI Pro platform, its production database, or the
FuelCap services.

## Render service (verified 25 August 2026)

- **Service name:** `nzi-console`
- **Service ID:** `srv-d6o8snvgi27c73frfta0`
- **Type / plan:** Web Service · Node · Starter
- **Repo / branch:** `francis-nzi/nzi-console` · `main`
- **Root Directory:** blank (repo root — required so `@nzi/ui` / `@nzi/mock-data` resolve)
- **Build command:** `npm install && npm run build -w @nzi/console`
- **Start command:** `npm run start -w @nzi/console`
- **Health check path:** `/api/health`
- **Auto-Deploy:** on commit to `main`
- **Public URL:** `https://nzi-pro-api-prod.onrender.com`
- **Latest accepted implementation commit:** `d49eb7d` — "Prove complete CRP workflow lifecycle"

## Environment variables

| Key | Value |
|---|---|
| `NODE_VERSION` | `20.18.0` |
| `NEXT_PUBLIC_APP_ENV` | `staging` |
| `NZI_DATA_MODE` | `isolated-api` |
| `NZI_DATABASE_BOUNDARY` | `isolated-non-production` |
| `NZI_DEMO_ORGANISATION_ID` | `demo-nzi-console` |
| `NZI_ISOLATED_API_URL` | `https://nzi-pro-api-prod.onrender.com` |
| `NZI_ISOLATED_DATABASE_URL` | Secret non-production Supabase session-pooler URL; Render only |
| `NZI_PORTAL_AUTH_ENABLED` | Set to `true` when independent client portal sign-in is enabled |
| `NZI_PORTAL_SESSION_SECRET` | Dedicated random secret of at least 32 bytes; never reuse the staff session secret |
| `NZI_AUTH_ENABLED` | `true` |
| `NZI_AUTH_REQUIRED` | `true` |
| `NZI_CONSOLE_SESSION_SECRET` | Dedicated Render-only secret |
| `NZI_CONSOLE_MFA_ENCRYPTION_KEY` | Dedicated Render-only secret |
| `NZI_WRITE_API_ENABLED` | Explicit independent gate for authenticated command routes |
| `NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2` | Comma-separated list of enabled data-entry / workspace UI flags (`spend`, `spend-import`, `portal-spend`, `commuting`, `vehicle`, `client-factors`, `data-entry-accordion`, `job-stage-sections`, …). Unset = every flag OFF, generic path is default. Per-flag rollout gate — see `docs/REDESIGN_ROLLOUT.md`; do not enable a flag until it has passed its rendered acceptance. **`NEXT_PUBLIC_*` is inlined at `next build`, and this service's value is currently set in the Render dashboard (not synced from `render.yaml`) — so a flip is a dashboard edit + rebuild. See "Feature-flag flips" below.** |
| `DVLA_VES_API_KEY` | Optional. DVLA Vehicle Enquiry Service key for the UX1 registration lookup (`/api/*/jobs/{id}/vehicle-lookup`). **Unset on isolated staging** — with `NEXT_PUBLIC_APP_ENV=staging` the service returns a deterministic stub vehicle so the two-step flow is exercisable without a real key or plate. The registration is transient: never persisted, never logged. |

Clients, Jobs, and individual Job workspace screens use the isolated Supabase schema and expose
authenticated client/job creation plus versioned job-stage transitions through the transactional command
boundary. The independent client portal also uses the isolated boundary for enrolment, sessions, grants,
published reports, collaboration, deliverables, and constrained data entry. CRP jobs read and edit canonical
`job_scope_rows`; `J000712` uses an explicit fictional evidence seed and newly created CRP jobs begin in a
truthful empty state. Other staff workspaces remain on synthetic `@nzi/mock-data` fixtures. The service retains unrelated legacy environment variables from its earlier
use; the Console boundary ignores generic `DATABASE_URL` and accepts only `NZI_ISOLATED_DATABASE_URL`.

## Feature-flag flips (`NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2`)

**The Render dashboard value is authoritative on this service, not `render.yaml`.** The env var was edited
manually in the dashboard during an earlier rollout, and Render then stops syncing that key from the
blueprint. `render.yaml` is kept in step **for continuity only** — merging a `render.yaml` change **does
nothing to the running build**.

`NEXT_PUBLIC_*` values are **inlined into the client bundle at `next build`**, and several flag-gated
surfaces (`CrpScopeWorkspace`, the accordion, `CrpStageSections`, `ClientFactorPanel`) are client
components — so a flip is not a restart, it is a **rebuild**.

**To flip a UI flag ON:**

1. In the Render dashboard for `nzi-console` (`srv-d6o8snvgi27c73frfta0`) → Environment, **append** the new
   token to `NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2` (keep the existing tokens; comma-separated, no spaces).
2. Save — Render triggers a rebuild + deploy. Confirm `/api/health` is green and the surface renders.
3. In the **same PR that added the flag**, append the token to `render.yaml`'s value too (continuity), so
   the two never diverge in intent.
4. Roll back = remove the token from the dashboard value + rebuild. Flag-gated UI is additive; the legacy
   path returns.

Current dashboard value (3 Sep 2026):
`spend,spend-import,portal-spend,commuting,vehicle,client-factors,data-entry-accordion,job-stage-sections`
— `job-stage-sections` (UX1e-1) was appended and the rebuild is live; acceptance recorded in
`docs/STAGING_ACCEPTANCE_UX1E.md`. `render.yaml` carries the same token set for continuity.

**Longer-term fix:** blueprint-link the service (Render dashboard → the service → "Link to Blueprint", or
recreate it from `render.yaml`) so `render.yaml` becomes authoritative and env changes ship as reviewed
commits. Until then, every `NEXT_PUBLIC_*` flip is the manual dashboard step above.

## ⚠️ Notes / follow-ups

- **Public URL is misleadingly named** `nzi-pro-api-prod.onrender.com` — this is a **staging redesign UI with
  an isolated non-production data boundary**, not a production API. Before anyone bookmarks or references it: confirm this service was not
  previously serving a real NZI Pro API, and that nothing else points at that URL. The `.onrender.com`
  subdomain is fixed at service creation and can't be changed by renaming; for a clean name, create a fresh
  service (`nzi-console.onrender.com`) or attach a custom domain (`console.netzero.international`).
- `NEXT_PUBLIC_APP_ENV=staging` is the authoritative in-app signal that this is not production.
- Browser-side Supabase keys are not used; database access is server-only through the dedicated
  non-production session pooler.

## Rollback / teardown

For an immediate application rollback, set `NZI_DATA_MODE=fixture` on service
`srv-d6o8snvgi27c73frfta0` and trigger a deploy. This disconnects the application from Postgres and returns
Clients and Jobs to bundled fixtures without deleting isolated data. Entire teardown remains additive.
