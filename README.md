# NZI Console

Redesigned NZI Pro front-end — a **separate, isolated environment**. It does not modify the live
`nzi_pro_v7-POSTGRES` platform, its production database, or the FuelCap environments. Additive only.

## Structure

```
apps/
  console/        Next.js app (the redesigned UI)
packages/
  ui/             design system — Inter + emerald tokens, app shell, evidence drawer
  mock-data/      sample / anonymised data for design-first iteration (no real client data)
```

## Design decisions (locked)

- **Type:** Inter throughout (no Space Grotesk).
- **Palette:** Emerald `#0BA75E` primary, Deep Pine `#0B7A4B`, Midnight `#0B1B2B`, Signal Amber `#FFC24B`,
  Drop Coral `#FF5C48`, Mint Tint `#DFF5E9`.
- **Shell:** left workspace rail · top command/search bar · main data area · right evidence drawer with
  provenance + calculation lineage.

## Isolation rules

- Staging Supabase only; **no production credentials or data** in this repo/service.
- No reference to the live NZI API or database until a dedicated staging backend exists.
- First iteration runs entirely on `@nzi/mock-data` — zero backend risk.

## Run locally (npm workspaces)

```bash
npm install
npm run dev            # http://localhost:3000  (runs @nzi/console)
```

Build: `npm run build`. Health check: `/api/health`. Run all from the repo root so the workspace
packages (`@nzi/ui`, `@nzi/mock-data`) link correctly.

## Status

Phase: **design-first scaffold.** First real screen: the Job workflow (`/jobs/712`), on mock data.
