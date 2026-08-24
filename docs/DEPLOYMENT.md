# NZI Console — deployment record

Isolated staging environment for the redesigned NZI Pro front-end. **Additive only** — separate repo,
service and (future) database. Does not touch the live NZI Pro platform, its production database, or the
FuelCap services.

## Render service (verified 24 August 2026)

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
- **Live commit at record:** `989715b` — "Add Control Room home (portfolio overview) reusing @nzi/ui"

## Environment variables

| Key | Value |
|---|---|
| `NODE_VERSION` | `20.18.0` |
| `NEXT_PUBLIC_APP_ENV` | `staging` |

No Supabase or production credentials are configured. The app runs entirely on `@nzi/mock-data`.

## ⚠️ Notes / follow-ups

- **Public URL is misleadingly named** `nzi-pro-api-prod.onrender.com` — this is a **staging redesign UI on
  mock data**, not a production API. Before anyone bookmarks or references it: confirm this service was not
  previously serving a real NZI Pro API, and that nothing else points at that URL. The `.onrender.com`
  subdomain is fixed at service creation and can't be changed by renaming; for a clean name, create a fresh
  service (`nzi-console.onrender.com`) or attach a custom domain (`console.netzero.international`).
- `NEXT_PUBLIC_APP_ENV=staging` is the authoritative in-app signal that this is not production.
- When moving from mock data to wired-but-isolated, add only a **non-production** Supabase project's URL +
  publishable key here — never production values.

## Rollback / teardown

Entirely additive: to remove, delete this Render service (`srv-d6o8snvgi27c73frfta0`) and the
`francis-nzi/nzi-console` repo. Nothing in production is affected; there is no migration to reverse.
