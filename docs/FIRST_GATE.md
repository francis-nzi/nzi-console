# NZI Console — first green gate

Bring the scaffold up locally, confirm it builds and runs, then commit. This is the design-first gate:
everything runs on `@nzi/mock-data`, no backend, no database, no production anything.

## 1. Prerequisites

- Node 20.18.0 (see `.node-version`). npm ships with Node — no extra tooling needed.

## 2. Install & run (npm workspaces)

```powershell
cd "C:\Users\franc\Claude\Projects\NZI Console"
npm install
npm run dev
```

Run from the repo root so the workspace packages (`@nzi/ui`, `@nzi/mock-data`) link. Open
`http://localhost:3000` → it redirects to `/jobs` and shows the Job workflow screen. Click rows in the
table; the right evidence drawer updates. Use the filter chips (All / Needs data / Estimated / Complete).

## 3. Verify (the gate)

- [ ] `npm install` completes with no errors.
- [ ] `npm run dev` serves `/jobs` and the drawer + filters work.
- [ ] `npm run build` succeeds (production build of @nzi/console).
- [ ] `http://localhost:3000/api/health` returns `{"status":"ok","app":"nzi-console",...}`.
- [ ] No production URL, key, or database reference anywhere (grep the repo).

## 4. Commit & push

```powershell
git add .
git commit -m "Scaffold nzi-console: workspace, @nzi/ui design system, @nzi/mock-data, Job workflow screen"
git push -u origin main
```

## 5. What this is / isn't

- **Is:** the isolated redesign environment (Inter + emerald design system, workspace shell, evidence
  drawer) with the Job workflow as the first real screen on illustrative data.
- **Isn't:** wired to the live NZI Pro backend or database. That's a later, separate step against a
  **non-production** Supabase/staging API only.

## 6. Next steps (after the gate is green)

1. Create the Render web service from `render.yaml` (root `apps/console`), env `NEXT_PUBLIC_APP_ENV=staging`.
2. Add the second screen (Clients / Control Room home) reusing `@nzi/ui`.
3. Promote page-local pieces (table, drawer form) into `@nzi/ui` components as they stabilise.
4. Seed a non-production Supabase project only when we move from mock data to wired-but-isolated.

If anything fails at step 2 or 3, paste the error and I'll fix it — we hold the gate until the build is green.
