# Custom field values: the contract for the entity workstreams

**Status:** in force from admin Phase F3 (migration 0151). Ruled in `phaseF-comms-crm-plan.md` (F-Q5): **F builds the
definitions only.** The **values** belong to each entity's own workstream. This document is what those workstreams build
against.

| Entity | Its workstream | Values table (to be made there) |
|---|---|---|
| `client` | Clients | e.g. `client_custom_field_values` |
| `job` | Jobs | e.g. `job_custom_field_values` |
| `contact` | Client contacts | e.g. `contact_custom_field_values` |
| `quote` | Quotes / commercials | e.g. `quote_custom_field_values` |
| `supplier` | Suppliers (admin E4's records) | e.g. `supplier_custom_field_values` |

## What F3 built

`nzi_console.custom_field_definitions` holds one row per organisation per (entity type, key):

| Column | Meaning | Changes? |
|---|---|---|
| `definition_id` | The definition's id | never |
| `entity_type` | `client` · `job` · `contact` · `quote` · `supplier` | **never** (set once) |
| `field_key` | The field's identity within its entity: `^[a-z][a-z0-9_-]{0,63}$` | **never** (set once) |
| `field_type` | `text` · `long_text` · `number` · `decimal` · `date` · `checkbox` · `select` | **never** (set once) |
| `label` | What a form shows | editable |
| `required` | Whether a record may be saved without a value | editable |
| `sort_order` | The order a form shows its fields in | editable |
| `options` | For a `select` only: `[{value, label, active}]` | options are added, relabelled, deactivated, **never removed** |
| `default_value` | The value a new record starts with, valid for the type | editable |
| `active` | Whether the field is offered at all | deactivate / reinstate; **never deleted** |

**To read an entity's fields for a form:** use `listActiveCustomFields(db, entityType)`
(`packages/isolated-backend/src/customFields.ts`). It returns the active definitions in order. **To check a value:** use
`customFieldValueIssue(type, value, options)` (`packages/contracts/src/adminCustomFields.ts`), the same rule a definition's
default is held to.

## The rules a values workstream follows

1. **Store against the definition, not the label.** Key a value by `(organisation_id, <the entity's id>, definition_id)`:
   - FK to `custom_field_definitions (organisation_id, definition_id)`;
   - FK to the entity's own row, which v7 never had;
   - one value per field per record.
   - Keep `field_key` beside it only if you want it for reading; the definition id is the identity.
2. **One table per entity, forced row-level security, the tenant policy, no DELETE.** A value is cleared by setting it to
   null, through a command, and audited. It's tenant-scoped like everything else; v7's values table had no organisation.
3. **Store as text, in the canonical form** that `customFieldValueIssue` accepts:

   | Type | Stored as |
   |---|---|
   | `text` | One line, ≤ 500 characters |
   | `long_text` | ≤ 10,000 characters |
   | `number` | `-?\d{1,15}` |
   | `decimal` | `-?\d{1,15}(\.\d{1,6})?`, using `.` |
   | `date` | `YYYY-MM-DD` |
   | `checkbox` | `true` or `false` |
   | `select` | One option's `value`, never its label |

4. **Validate on the server, in the entity's own save command:**
   - a **required** field must have a value when the record is saved (v7 checked this only in the browser);
   - a value must pass `customFieldValueIssue` for its definition's type and options;
   - a **new** choice must be an **active** option.
5. **What's held stands (R3):**
   - **Deactivated field:** it leaves the form, but values already held are kept and shown, read-only, wherever the record
     shows its fields. A required field that's inactive is not required.
   - **Deactivated option:** a record that holds it keeps it and shows its label. It just isn't offered for new choices.
     Options are never removed, so every held value resolves.
   - **Type:** never changes, so a held value never becomes the wrong type. A field that needs another type is a new
     field (a new key).
6. **The default applies once, when a record is created.** It never overwrites a value, and it isn't re-applied when the
   default changes.
7. **Audit the act, not just the value.** A value change is a command on the entity (e.g. `client.custom_fields.set`),
   recorded with before and after. A custom field is the organisation's own data, not personal data by design. But a
   free-text field can hold anything a person types, so a workstream that puts a custom field on a person (`contact`)
   brings it to the PII inventory before going live.

## Carrying v7's values

v7 kept values in one global `custom_field_values` table, keyed `(field_id, entity_type, entity_id)`: no organisation,
no foreign key to the record, and every value as text. A workstream that imports them:

- **Resolves the field by v7 identity.** `load:v7-custom-fields` stamps each definition it carries with v7's `field_id`
  (`source_system = 'nzi-pro-v7'`, `legacy_db_id`).
- **Resolves the record by its own import's v7 identity** (e.g. clients by `db_id`, jobs by `job_id`).
- **Validates each value with `customFieldValueIssue`.** A value that fails is reported, never coerced. For example:
  - v7's checkbox stored `1` or `yes` as checked, which normalises to `true`, and says so;
  - a v7 date in another format is reported.
- **Carries no value whose definition was left out** of the definitions import. Those definitions are named in its dry
  run.

## What F3 didn't do

- **No values table, no value commands, no form rendering.** Those are each workstream's.
- **No WFM mapping.** v7 offered active client and job field keys as WFM import targets; that belongs to whichever
  workstream owns the WFM import.
