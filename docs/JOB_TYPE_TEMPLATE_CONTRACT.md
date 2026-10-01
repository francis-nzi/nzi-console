# Job-type templates: the copy-at-creation contract

**Status:** in force from admin Phase E3 (migration 0147). It's written for the downstream **Quotes / Job commercials**
plan, which builds the copy. Ruled in `phaseE-commercial-catalogue-plan.md` (E-Q5).

## What E built, and what it didn't

- **E2:** the **service catalogue**, `job_items`. Each item has a code that never changes, a name, a category, a unit,
  default hours, VAT, and default cost and sell in the organisation's selling currency. Cost and sell are restricted to
  `finance.manage`.
- **E3:** the **job-type template**, `job_type_items`. These are the catalogue items a new job of a type starts with,
  each with a `quantity`, an `is_required` flag and a `sort_order`.
- **Not built in E:** `job_line_items`, a job's own lines. They're the **snapshot** this contract describes, and they
  belong downstream.

## The copy

When a job is created with a job type, its lines are copied from that type's template **once, at that moment**:

1. **What's copied.** The template's rows where `included = true`, in `sort_order`. A row with `included = false` is an
   item the template dropped; it's kept for history and never copied.
2. **What each line carries.**
   - The row's `quantity` and `is_required`.
   - The catalogue item's values **as they stand at that moment**: its `item_code`, `name`, unit, VAT rate, default
     hours, default cost and default sell, and the currency they're held in.
   - The line keeps the `item_code` and the `item_id` it came from, as provenance. The code never changes (E-Q4), so it
     always names the same service.
3. **Inactive items.** A deactivated catalogue item that a template still includes is copied like any other. R3:
   deactivated means "not offered for new choices", not "gone". Whether the copy should **skip** such items, or flag
   them for a person, is a decision for the downstream plan to make explicitly.
4. **Cost and sell.** They're commercially sensitive (E-Q8). The copy reads them as the system does. Who may see them
   on a job line is the downstream plan's call, under the same `finance.manage` rule.

## What never happens

- **A later edit never reaches an existing job.**
  - Editing a template (quantities, order, items added or dropped) changes what the **next** job copies.
  - Editing a catalogue item (name, unit, VAT, amounts) changes what the **next** copy reads.
  - Neither touches a job's lines once they're made.
- **Nothing is deleted.** Templates drop items by `included = false`, and catalogue items deactivate. Neither cascades
  into a job.

## Where things live

| Thing | Where |
|---|---|
| The template rows | `nzi_console.job_type_items`: one per (job type, item), the pair fixed |
| The template's version | `nzi_console.job_types.items_version`, apart from the type's definition `version` |
| Setting a template | `job_type.items.set` (`admin.lookups`): set whole, in order, against `items_version` |
| Reading a template | `listJobTypeTemplates()` (`packages/isolated-backend/src/jobTypeTemplates.ts`) |
| The catalogue | `nzi_console.job_items`; `packages/isolated-backend/src/serviceCatalogue.ts` |
| v7's templates | `load:v7-job-type-items`, run after `load:v7-jobs-config` and `load:v7-job-items` |
