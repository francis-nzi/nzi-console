# R3 — staging acceptance record

Date: **8 September 2026**  
Target: isolated Render staging (`https://nzi-pro-api-prod.onrender.com`)  
Flag: `NEXT_PUBLIC_FEATURE_REPORT_STUDIO=report-svg-charts,report-tokens`

## Automated result

- Hardened `report-figure-tokens.spec.ts`: the deployed `.report-sections` surface is now a hard
  precondition, not a conditional skip.
- Playwright: **4/4 passed** — staff and portal authentication setup, resolved narrative-token
  journey, and axe/responsive report-surface journey.
- Six ordered report sections rendered with source pills.
- All figure chips resolved; no `.nz-fig-token.unresolved` elements were present.
- The integrity banner covered narrative figures and `data-report-ready="true"` remained set.
- No uncatalogued serious/critical axe issue or horizontal overflow was found.
- Workspace typecheck and `@nzi/contracts` **83/83** passed before the staging run.

## Configuration continuity

`render.yaml` now records `report-svg-charts,report-tokens`, matching the value already live in the
Render dashboard. The dashboard remains authoritative because the service is not blueprint-synced.

## Human gate

Still open for Francis: confirm the section headings, source pills and locked figure chips read
sensibly with Narrator, then confirm printed output presents the chip values as plain figures.
