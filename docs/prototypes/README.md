# Data-entry redesign prototypes (v3.2)

These are the **build reference** for the UX1 data-entry accordion work. Build both
surfaces to match these, read alongside `docs/DATA_ENTRY_UX.md` (NZC-046, the spec of
record). Where a detail is not visible in the HTML, `DATA_ENTRY_UX.md` governs.

| File | Surface | Audience |
|------|---------|----------|
| `crp_v3.html` | CRP Workspace (consultant CRM) | Full 15 GHG Scope-3 categories shown for included scopes; empties `noData`, excluded from reports, never mandatory. Emissions factor visible. |
| `portal_v3.html` | Client Portal | Authorised bucket-grant categories only. Emissions factor hidden. No "Your"/"You" language. |

## Both surfaces share ONE data-entry UX
- Scope → category accordion (categories collapsed), dataset category names verbatim.
- Site is **context** (select site once; all rows inherit), not a per-row field.
- One field order everywhere: Activity smart-search → Quantity/Unit → Monthly (collapsible, under Quantity) → category-specific detail → factor → note → documents.
- Spend fields appear **only** under Purchased Goods and Services.
- Registration finder available for Company Vehicles, Business Travel, Employee Commuting; plus manual entry.
- Factor is scope- and category-scoped, set from the selected activity (hidden in portal).
- Uploads virus-scanned.

Published Artifact equivalents (same content):
- CRP: https://claude.ai/code/artifact/f5fda985-b9eb-428c-ae8a-1c59d062cc43
- Client Portal: https://claude.ai/code/artifact/513f921c-c169-4b9c-89a4-34899892e789
