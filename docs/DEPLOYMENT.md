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
- **Verified authentication commit:** `54340dd` — "Allow credential-scoped membership authentication"

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
| `NZI_AUTH_ENABLED` | `true` |
| `NZI_AUTH_REQUIRED` | `true` |
| `NZI_CONSOLE_SESSION_SECRET` | Dedicated Render-only secret |
| `NZI_CONSOLE_MFA_ENCRYPTION_KEY` | Dedicated Render-only secret |
| `NZI_WRITE_API_ENABLED` | Explicit independent gate for authenticated command routes |

Clients, Jobs, and individual Job workspace screens use the isolated Supabase schema and expose
authenticated client/job creation plus versioned job-stage transitions through the transactional command
boundary. CRP jobs read and edit canonical `job_scope_rows`; `J000712` uses an explicit fictional evidence
seed and newly created CRP jobs begin in a truthful empty state. Other workspaces remain on synthetic
`@nzi/mock-data` fixtures. The service retains unrelated legacy environment variables from its earlier
use; the Console boundary ignores generic `DATABASE_URL` and accepts only `NZI_ISOLATED_DATABASE_URL`.

## ⚠️ Notes / follow-ups

- **Public URL is misleadingly named** `nzi-pro-api-prod.onrender.com` — this is a **staging redesign UI on
  mock data**, not a production API. Before anyone bookmarks or references it: confirm this service was not
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
