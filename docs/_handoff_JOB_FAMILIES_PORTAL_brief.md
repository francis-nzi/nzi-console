# Handoff brief — Job families in the client portal

The client-facing display of all job families (CRP · LCA · PCF · Training · Consultancy) in
the portal. The **staff-side** family modules and their models are covered elsewhere
(`MODEL_FIDELITY_JOB_FAMILIES.md` §6–7: models `0045`–`0050` done; LCA/PCF module L1–L7 built;
Training + Consultancy staff modules follow the LCA reference pattern). **This brief is the
portal side** — how a client sees that work. **Design reference:**
`docs/prototypes/portal_projects_v1.html`. Branch + PR; typecheck AND build green; portal
realm auth; print-safe `NziIcon` set.

## Principles
- **Only released work appears.** A job shows in the portal only once it's been shared
  (review → send-to-portal / `portal-jobs` grant). Assured/published content only — never
  staff drafts or internals.
- **Read-only.** The portal displays; it does not edit. Client identity comes from the
  **session**, never a URL parameter, and each job grant is re-checked (reuse the pattern
  already shipped for the portal intensity view).
- **One resolver per family, shared with the console** — the portal recomputes nothing; it
  reads the same reviewed-snapshot resolvers the staff app and report use. Figures carry the
  same assurance/provenance discipline (assured mark; "reviewed snapshot", not third-party
  assured).

## The Projects hub (per prototype)
🟢 1. A **Projects** area listing the client's released jobs across families, filterable by
   family. Each row: `NziIcon` family mark, **family badge** (CRP/LCA/PCF/Training/
   Consultancy — distinct, not the scope palette), title, a one-line client-facing summary,
   client-appropriate headline figures, a status pill, and an action opening the family view.
🟢 2. Family badges/colours are their own categorical set (CRP emerald, LCA teal, PCF violet,
   Training amber-ink, Consultancy pine) — kept distinct from the reserved scope colours.

## Per-family client view (read-only, from the reviewed snapshot)
🟢 3. **CRP** → footprint summary + the published report (existing portal reporting/report
   surface) + intensity (already built).
🟢 4. **LCA** → the assured product result: kgCO₂e per functional unit, life-cycle **module
   breakdown** (EN 15804 A–D), standard, confirmed mass; from `lca_result_snapshots`
   (reviewed). *(Shown opened in the prototype as the reference.)*
🟢 5. **PCF** → same view, ISO 14067 cradle-to-gate preset, labelled "Product Carbon
   Footprint" per NZC-039.
🟢 6. **Training** → the client's training record: runs, attendance, **certificates issued**,
   and **free places used** (entitlements consumed) — from the reviewed training snapshot.
🟢 7. **Consultancy** → deliverables and their status (planned/in-progress/delivered/accepted).
🟡 8. Each family view offers the client-appropriate **download** (CRP report PDF; LCA/PCF
   EPD-style summary; training certificates/register; consultancy deliverable pack) — same
   print-safe assets as the report.

## Build note
Build the hub to render **whatever a family has released**, so it lights up per family as each
staff module lands: CRP + LCA/PCF are available now; Training and Consultancy views populate
when those staff modules ship (per `MODEL_FIDELITY_JOB_FAMILIES.md` §7 steps 5–6). A family
with nothing released shows a truthful empty state, never a placeholder figure.

## Acceptance (real data; build+typecheck green; on a PR)
- The portal lists only released jobs for the signed-in client, across families, with the
  right family badge and a client-facing summary; access is session-based and grant-checked.
- Opening a family shows its assured, read-only view from the shared resolver (no recompute):
  LCA/PCF module breakdown + per-unit result; Training attendance/certificates/free places;
  Consultancy deliverables; CRP footprint + report.
- Two clients see different projects; nothing unreleased or unassured leaks; empty families
  show honest empty states.
