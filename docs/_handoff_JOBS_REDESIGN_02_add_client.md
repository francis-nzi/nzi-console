# Handoff brief — Redesign · Part 2: Add-client form (Identity step)

Small, self-contained. Only the **Add client** form's **Identity** step (`/clients/new`). Changes only —
everything else on the step stays as is.

## Changes
1. **Client owner** → **smart-search over team members** (typeahead), not free text. Same team-member
   source as Client manager.
2. **Client manager** → **smart-search over team members** (typeahead). (This is the field jobs default
   their Client Manager from — Part 1.)
3. **Industry** → **smart-search from the industry lookup** (reference list), not free text / a basic
   dropdown.
4. **Remove the Headquarters field** entirely.
5. **Referral** → **smart-search from a referral lookup**.
6. **Remove** the helper line "Only identity is required — later steps can be completed now or from the
   client's edit tabs afterwards."
7. **Remove** the Identity step subtitle "Who the client is, who owns the relationship, and how they
   report."

Use the app's **existing smart-search component** (as in data-entry activity/source) so all four fields
behave consistently.

## Confirm before building (quick, Claude Code's call to check the data model)
- **Industry lookup source** — where the list comes from; and whether selecting an industry should
  auto-fill **Industry code (SIC)**. If the lookup carries SIC, offer the auto-fill; **do not assume** —
  flag it for Francis to decide.
- **Referral lookup** — does a referral reference list exist? If not, it needs defining (a small
  reference table → migration). **Do not invent referral values silently** — flag it.

## Acceptance
- Client owner, Client manager, Industry, Referral are all **typeahead smart searches** against their
  lists (team members / industry lookup / referral lookup); no free-text-only or basic dropdown remains
  for these four.
- **Headquarters** field is gone.
- Both helper lines are gone.
- Theme-aware, accessible; the audited client-create behaviour is unchanged.

## Rules
Branch + PR; theme-aware; permission-matrix unaffected. If a new reference/lookup table is needed
(referral, or industry if not already present), that's a **migration via the runner + ledger → stops for
review**. Auto-delete-branches on; frozen-branch rule. NZC-069 held.
