> **Status (29 Sep 2026).** Approved by Francis and promoted here from `_handoff/` in admin Phase A1, as the notes'
> housekeeping item asks. Ruled for Phase A: the visual language is a **scoped pilot** under `.nz-admin` (NZC-167,
> amending NZC-003 for `/admin` only), with Hanken Grotesk and IBM Plex Mono self-hosted via `next/font/local`, dark
> mode in `/admin` only, and unbuilt areas shown as phase-badged placeholders. The prototype's sample rows are
> illustrative; its patterns and tokens are the spec.

# Admin section — design reference (approved 29 Sep 2026)

Approved by Francis. `docs/design/admin-prototype.html` is the visual source of truth; this note is the
rationale and how it maps onto the console. Build Phase A — and all admin — to this.

## Direction
Calm, data-first "instrument panel." **One spine, one pattern:** every admin entity is operated through
list → side-panel editor → audit. Learn Lookups and you know all of admin. This is also the pilot for a
console-wide visual refresh (extend the language outward from admin over time).

## Information architecture (left-rail groups → roadmap phases)
- **Overview**
- **Foundation:** Lookups, Team & access, Organisation
- **Delivery:** Job types, Milestone templates, File types
- **Commercial:** Tax & currency, Service catalogue, Suppliers
- **Engagement:** Message templates, Report templates, CRM & pipeline
- **Carbon data:** Factor library, Custom factors, Methodology

## Core pattern (reuse everywhere)
- **List** on the shared `DataList` (existing `@nzi/ui`): search, filter segments, columns including
  provenance + in-use + status.
- **Right-hand slide-in drawer editor** (new `@nzi/ui` component): labelled/typed fields, Active toggle,
  footer audit line + Save. **Deactivate / Reinstate, never delete.**
- **Governance rendered as UI:** provenance badge (Imported·v7 / Added here / Seeded), in-use count,
  capability chip by the title (`admin.lookups` / `admin.users` / `admin.settings` / `admin.templates`),
  the `Staging · isolated` environment badge in the top bar, and `audited · vN` in the drawer footer.

## Visual language (add tokens to styles.css `:root`, full three-state theme)
- **Light:** bg `#F2F5F3` · surface `#FFFFFF` · rail `#12201B` · ink `#17201C` · ink-2 `#586460` ·
  line `#DEE4E1` · accent `#0E7C5A` · accent-weak `#E2F0EA`. Status reuses the Risk tokens: ok `#0B7A4B`,
  warn `#8A5A0F`, bad `#B23A2B`.
- **Dark:** bg `#0D1310` · surface `#141C18` · rail `#0A100D` · ink `#E8EDEA` · line `#25302A` ·
  accent `#3FBE8C`.
- **Type:** Hanken Grotesk (UI + headings), IBM Plex Mono (codes, rates, IDs, eyebrow labels, counts).
  Radius ≈10px. Tabular-nums on all figures.

## Mapping to the console
- A new **AdminShell** (rail + top bar + canvas) in `apps/console`, or an admin nav mode on the existing shell.
- Reuse `DataList` for every list; add the **drawer editor** + form-field primitives to `@nzi/ui`.
- **Reference-value engine** screen = the Lookups pattern (category rail + DataList + drawer), behind
  `admin.lookups`.
- **Typed entities** (VAT rates, currencies, job types, milestone templates) = same shell, typed drawer forms.
- **Milestone templates** = nested child-rows editor (three kinds + day offsets), linked to job types.
- **Organisation** = form layout with the finance-gated (Admin + Finance) bank-details section visibly locked.

## Housekeeping
- Promote this prototype into `docs/design/` as part of Phase A's PR if it should be version-controlled.
- The prototype's data is illustrative; the patterns and tokens are the spec, not the sample rows.
