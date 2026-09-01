# NZI Console prototypes — build reference for Claude Code

Read each alongside its spec. Prototypes are the visual reference; the spec doc governs where a
detail is not visible in the HTML.

| File | Surface | Spec | Published Artifact |
|------|---------|------|--------------------|
| `crp_v3.html` | CRP Workspace (consultant data entry) | `docs/DATA_ENTRY_UX.md` (NZC-046) | https://claude.ai/code/artifact/f5fda985-b9eb-428c-ae8a-1c59d062cc43 |
| `portal_v3.html` | Client Portal (data entry) | `docs/DATA_ENTRY_UX.md` (NZC-046) | https://claude.ai/code/artifact/513f921c-c169-4b9c-89a4-34899892e789 |
| `report_v3.html` | Report → Report Printing | `docs/REPORT_PRINTING_UX.md` (NZC-048–051) | https://claude.ai/code/artifact/d3dd74a6-5031-471a-bde6-5cfa0cefdf6f |

## report_v3 — the four fixes it demonstrates
- Print-safe charts (deterministic inline SVG, canonical @nzi/charts palette: S1 coral / S2 amber / S3 emerald).
- Editable sections (Edit / Regenerate AI / Reset; default / AI-drafted / client-edited status).
- Data-bound figure tokens (locked green chips; editing prose can't drift the numbers).
- Paged output: Continuous ↔ Page view (A4), page-break markers, repeating table headers.
- All text is Inter (NZC-003); all dates dd/mm/yyyy (NZC-040); "carbon emissions" not "footprint" (NZC-039).
