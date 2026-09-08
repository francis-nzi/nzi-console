# R4 — staging acceptance record

Date: **8 September 2026**  
Target: isolated Render staging (`https://nzi-pro-api-prod.onrender.com`)  
Flag: `NEXT_PUBLIC_FEATURE_REPORT_STUDIO=report-svg-charts,report-tokens,report-edit`  
Render deploy: `dep-dag803qjnfac73dpu4rg`

## Automated result

- Hardened `report-section-editor.spec.ts`: `.nz-report-editor` is now a required deployed surface,
  not a flag-dependent skip.
- Playwright: **4/4 passed** — staff and portal authentication setup, the locked-token editor
  journey, and the editor axe journey.
- Six editable section rows rendered with source pills and Edit/Regenerate controls.
- Edit mode exposed a textbox while each figure chip remained `contenteditable="false"`; Cancel
  restored the read view.
- No uncatalogued serious/critical axe issue was found.
- Workspace typecheck, `@nzi/contracts` **83/83**, `@nzi/isolated-backend` full suite, and
  `@nzi/console` **127/127** passed during the R3/R4 campaign.

The first hard-gate run correctly failed while Render was still serving the build started before the
public environment-variable update. A clear-cache rebuild compiled the new `NEXT_PUBLIC_*` value and
the immediate rerun passed. This is why the rebuild remains an explicit part of every public flag flip.

## Human gate

Still open for Francis: check Narrator announcements and reading order; use only the keyboard through
Edit/Save/Cancel; inspect reduced motion; and confirm edited wording freezes into the next reviewed
snapshot.
