# NZI Console — Data-Entry UX specification (CRP + client portal)

**Why.** Data entry is the largest, most-used surface. This spec fixes the issues Francis raised on the
31 Aug prototypes and locks **one** input process shared by the consultant workspace and the client portal
(NZC-035), grounded in the live `nzi_pro` portal and the dataset category taxonomy.

## 1. Structure — category accordion, grouped by scope

Data entry is organised as **collapsed category sections (accordion)**, grouped by scope, so the user
concentrates on one category at a time. **Only categories applicable to the job are shown** (driven by the
dataset/scope config — the structure that guarantees consistency). Category names come **verbatim from the
datasets**, never ad-hoc:

- **Scope 1** (if applicable): Natural Gas (and other stationary fuels), **Company Vehicles**, Refrigerants.
- **Scope 2** (if applicable): Purchased Electricity, Renewable Electricity.
- **Scope 3** (the 15 GHG categories, if applicable): 1 Purchased Goods and Services · 2 Capital Goods ·
  3 Fuel & Energy Related · 4 Upstream Transportation & Distribution · 5 Waste in Operations ·
  6 Business Travel · 7 Employee Commuting · 8 Upstream Leased Assets · 9 Downstream Transportation &
  Distribution · 10 Processing of Sold Products · 11 Use of Sold Products · 12 End-of-Life Treatment ·
  13 Downstream Leased Assets · 14 Franchises · 15 Investments.

Each collapsed section shows a one-line summary (entries · tCO₂e · completeness). **Many rows per category**
live inside that category's section as a small table, with an **Add entry** action per category. (So "Spend —
purchased goods" becomes **Purchased Goods and Services**; the flat single register is replaced by
scope→category accordions.)

The CRP keeps its **exception-first** strength as a second lens: a top toggle switches between **By category**
(accordion, the default for inputting) and **Needs attention** (the flat exception list, for triage) over the
same rows.

## 2. Site is context, not a per-row field  *(correction)*

A **site selector sits at the top of data entry**. Selecting a site scopes the accordion to that site, and
**every entry made is automatically allocated to it** — the user does not pick a site on each row. "All
sites" and "Unallocated / not site-specific" remain options; a single entry can still be overridden to
Unallocated. (This matches the live portal's up-front `selectedSiteId`.) Applies identically to CRP and
portal.

## 3. One process, one field order — CRP and portal identical  *(correction)*

The two surfaces are **the same capture component** with the **same field order**; the portal is a
*constrained mirror*, not a different form. Canonical order for every entry, both surfaces:

1. **Activity / source** — a **smart-search typeahead** over this scope+category's factors (see §7)
   (+ ID / Reference where relevant).
2. **Quantity** + **Unit**
3. **Monthly breakdown** — directly **under Quantity**, **collapsed by default**, "Add monthly breakdown"
   expands 12 reporting-period-aligned inputs with copy-month-1→all.
4. **Category-specific detail** — shown **only** for the category it belongs to (see §4).
5. **Factor** — CRP: scope+category-scoped, set from the selected activity; **portal: hidden** (NZI sets it).
6. **Evidence note** and **supporting documents** (see §7).

Portal-only: entries **submit to review** and never count as reviewed emissions; categories, sites, factors
and units are limited to what the grant authorises.

## 4. Progressive disclosure — kind-specific fields only where they belong  *(correction)*

The generic form must not confront the user with every field. Category-specific fields appear **only** in
their own category:

- **Purchased Goods and Services** → the **spend adapter**: Net value, VAT %, GL / nominal code, PG&S
  sub-category. **Collapsed / absent for every other category.**
- **Company Vehicles · Business Travel · Employee Commuting** → **vehicle registration lookup** (two-step:
  look up → confirm vehicle → enter distance) **or** manual entry (mode / type). Registration numbers are
  captured. Business Travel is its own visible section supporting vehicle-reg **and** manual **and** its other
  travel types (air, rail, hotel, …).
- All other categories → plain quantity + unit + monthly.

## 5. Portal multi-row & navigation

Each authorised category is its own collapsed section; expanding one shows that category's existing entries
(e.g. several vehicles, several travel legs) and its Add-entry form. Frequently/previously-used chips and
copy-previous-years reduce typing (spend & commuting first).

## 6. What the 31 Aug prototypes got wrong (now corrected here)

- Site shown as a per-row drawer field → **site is context** (§2).
- Spend fields shown on every category → **spend only under PG&S** (§4).
- Monthly mid-drawer → **under Quantity, collapsible** (§3).
- Field order differed between portal and CRP → **one order, both surfaces** (§3).
- "Spend — purchased goods" and ad-hoc labels → **dataset category names** (§1).
- Flat register → **scope→category accordion, collapsed** (§1), exception-first kept as a second lens.

## 7. Refinements — v3.1 (1 Sep 2026)

- **Company Vehicles** is a Scope 1 category in both surfaces (portal added).
- **Depersonalised copy:** no "your"/"you". The heading is the **job title**; the results section/label is
  **Carbon emissions** (not "Your carbon impact"/"Your emissions").
- **Emission factor is scope + category scoped** — the factor list only ever contains factors for that row's
  scope and category, and is **set from the selected activity** (not chosen free-hand). In the **client
  portal the factor field is hidden** (the client does not need it; NZI sets it from the selected row).
- **Description is a smart search** — a typeahead over that scope+category's factor set, mirroring the live
  *Search factors* field in Jobs → Data Entry → *Add data from template*. Selecting an activity is what sets
  the factor.
- **Supporting-document upload** on an entry (evidence / EPD / invoice). **Build requirement:** uploads are
  **virus-scanned server-side** before a consultant can open them, with type/size limits and quarantine on
  failure — for both CRP and portal. (Ties to the ClientFactor EPD evidence in NZC-041.)

*Prepared 31 Aug 2026; refinements 1 Sep 2026. Recorded as NZC-046. Companion to
MODEL_FIDELITY_DATA_ENTRY.md and the B/S slices in REDESIGN_ROLLOUT.md.*

## 8. Refinements — v3.2 (1 Sep 2026)

- **Data entry is never mandatory.** Empty categories show a neutral **"No data"** (not "Needs data" /
  "Data needed") — a client may simply have none of those emissions. No red/amber urgency on empties.
- **Company Vehicles is client self-serve** in the portal. The **Registration finder** (DVLA lookup) is the
  primary entry path for **Company Vehicles, Employee Commuting and Business Travel**, with manual entry as
  the fallback in each.

*Refinements recorded 1 Sep 2026 under NZC-046.*

## 9. Category completeness — CRM vs portal (1 Sep 2026)

- **CRM (consultant):** Scope 3 lists **all 15 GHG categories** in order, as a completeness checklist, even
  when empty. (Scope 1/2 likewise show the canonical set.) Empty categories show a neutral **"No data"** and
  are **excluded from reports and downstream outputs** until an entry exists — they are never mandatory.
- **Client portal:** shows **only the categories NZI has authorised** for that client (not the full 15), to
  keep the client focused; empties there are also neutral "No data".

*Recorded 1 Sep 2026 under NZC-046. Refines §1 (applicable-only) for the CRM completeness view.*
