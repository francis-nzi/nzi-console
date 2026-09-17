# Reference-data seed — Industries, Referrals, Team (transcribed from live, 17 Sep 2026)

The live Import/Export has **no export routine**, so these are transcribed from Francis's live-admin
screenshots. **Deactivated entries excluded** (per Francis). This file is the **seed source for Part 0's
importer** — the substitute for the export that couldn't be produced. Governance: team names/emails are
NZI's own staff → **isolated staging only**.

**Three flags for the build (below):** Industries carry **no SIC codes** in live; the team count is
**14 captured vs 15 stated**; and **"Test Admin"** is a live test account.

---

## Industries (54) — NO SIC codes in live
The live Industries list is names only. **Seed these names; keep `sic` nullable; SIC codes must be
curated before the industry→SIC auto-fill is switched on** — do not invent them (wrong SICs cause the
reporting errors this redesign is removing). The industry smart-search works on names immediately;
auto-fill activates once SICs are populated.

```csv
name
Accountancy and Auditing
Aerospace
Agriculture
Architect
Automotive
Bid Management
Business Services
Charities and Not For Profit
Chemicals
Clothing
Computing
Construction
Consultancy
Digital Services
Education
Energy
Engineering
Events Management
Facilities Management
Finance
Food and Drink
Furniture
Healthcare
Hospitality and Travel
Housing
Insurance
Insurance Services
Legal Services
Lighting
Local Authority
Machinery
Manufacturing
Marketing
Media
Office Services
Oil and Gas
Pharmaceuticals
Plastics
Printing
Procurement
Property Management
Recruitment
Recycling
Renewables
Retail
Shipping
Software
Sport
Sport and Leisure
Sustainability
Technology
Transport
Utilities
Waste Management
```

## Referrals (25)
```csv
name
Ailsa ESG
Beena Sharma
Big Zero Show
Chris Williams
Crystal Martin
Customeric Consulting
David Hawes
Direct
Dundee and Angus College
Estu Global
Hertfordshire Chamber of Commerce
Hovis
JPA Workspaces
Keartland and Co
Mortimer Isaacs
NESCOL
Net Zero Nation
NFB
notch
Plans With Purpose
Shred It
Sust Consulting
Sustainable X
Triple Bottom Line Accounting
Website
```

## Team members — `display_name` is the fix for the handle problem
Seed the roster with these; **`display_name` = Name** (this is what the owner/manager smart-searches
show, instead of `m.osei` handles). Position `nan` in the UI = not set → leave blank. Excludes Ellie
Hawes (deactivated).

```csv
display_name,email,role,position,status
Abigail Pearce,abigail@netzero.international,Admin,,Active
Chris Williams,chris@netzero.international,Admin,Chief Commercial Officer,Active
Crystal Martin,crystal@netzero.international,Admin,Customer Relationship Manager,Active
David Hawes,david@netzero.international,SuperAdmin,Chief Executive Officer,Active
Francis Doherty,francis@netzero.international,SuperAdmin,Chief Information Officer,Active
Freya Whiterod,freya@netzero.international,Admin,,Active
Jennie Davide,jennie@netzero.international,SuperAdmin,Customer Relationship Manager,Active
Lea Davies,lea@netzero.international,Admin,Customer Relationship Manager,Active
Lisa Barnaby,lisa@netzero.international,Admin,Customer Relationship Manager,Active
Matilda Phipps,matilda@netzero.international,Admin,,Active
Rebecca Marshall,rebecca@netzero.international,Admin,,Active
Test Admin,teastadmin@netzero.international,SuperAdmin,,Active
Tina Hartley,tina@netzero.international,Admin,Customer Relationship Manager,Active
```

### Flags to resolve with Francis
1. **Team count:** live shows **15 members**; **14 are legible** across the screenshots (13 active above
   + Ellie Hawes, deactivated, excluded). **One member isn't captured** — confirm the missing name and
   whether they're active.
2. **Test Admin** (`teastadmin@netzero.international`) is an active **test account** — almost certainly
   should be excluded from the selectable owner/manager roster. Francis to confirm; excluded by default
   would be my recommendation.
3. **Industries → SIC:** none in live. Seed names now; curate SICs as a follow-up before enabling the
   auto-fill.

### For the importer (Part 0)
This is the real seed data — point the (already CI-tested-on-synthetic) importer at these lists.
Idempotent, reconcile-by-reading, deactivate-not-delete, per §14/§15. Referral values that are people's
names are referral *sources*, not team members — keep them as-is in the Referrals lookup even where a
name coincides with a team member.
