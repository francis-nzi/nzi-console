import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bulkCreateLcaLineItems, CommandValidationError, createLcaLineItem, deleteLcaLineItem, gapFillLcaLineItem,
  listLcaComponentsForJob, listLcaLineItems, listLcaMaterialCategories, updateLcaLineItem, withTenantRead,
} from "../src/index";

const context = (key: string) => ({ organisationId: "org-a", actorId: "consultant-a", principal: "staff" as const, idempotencyKey: key, correlationId: `corr-${key}` });

const line = { moduleCode: "A1" as const, lineLabel: "Cardboard box", quantity: 0.5, unit: "kg" };

function lineItemPool(opts: { assessmentFound?: boolean; itemFound?: boolean } = { assessmentFound: true, itemFound: true }) {
  const writes: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const client = {
    async query(sql: string, values?: readonly unknown[]) {
      writes.push({ sql, values });
      if (sql.includes("FROM nzi_console.command_idempotency")) return { rows: [] };
      if (sql.includes("FROM nzi_console.lca_assessments a JOIN")) return { rows: opts.assessmentFound === false ? [] : [{ ok: 1 }] };
      if (sql.includes("SELECT 1 FROM nzi_console.lca_line_items WHERE")) return { rows: opts.itemFound === false ? [] : [{ ok: 1 }] };
      if (sql.startsWith("DELETE FROM nzi_console.lca_line_items")) return { rows: opts.itemFound === false ? [] : [{ line_item_id: "line-1" }] };
      return { rows: [] };
    },
    release() {},
  };
  return { pool: { connect: async () => client } as never, writes };
}

describe("createLcaLineItem (Track C / NZC-054/056)", () => {
  it("creates a line item under an existing assessment", async () => {
    const state = lineItemPool();
    const result = await createLcaLineItem(state.pool, { jobId: "job-1", assessmentId: "assess-1", ...line } as never, context("li-create-1"));
    assert.ok(result.data.lineItemId);
    const insert = state.writes.find((w) => w.sql.includes("INSERT INTO nzi_console.lca_line_items"));
    assert.ok(insert?.values?.includes("Cardboard box"));
    assert.ok(insert?.values?.includes("A1"));
  });

  it("rejects an unknown assessment", async () => {
    await assert.rejects(
      () => createLcaLineItem(lineItemPool({ assessmentFound: false }).pool, { jobId: "job-1", assessmentId: "assess-missing", ...line } as never, context("li-create-missing")),
      (error: unknown) => error instanceof CommandValidationError && error.issues.some((issue) => issue.code === "NOT_FOUND"),
    );
  });

  it("rejects a blank label, an invalid module code, and a dataset factor with no dataset id", async () => {
    await assert.rejects(() => createLcaLineItem(lineItemPool().pool, { jobId: "job-1", assessmentId: "assess-1", ...line, lineLabel: " " } as never, context("li-bad-1")), CommandValidationError);
    await assert.rejects(() => createLcaLineItem(lineItemPool().pool, { jobId: "job-1", assessmentId: "assess-1", ...line, moduleCode: "Z9" } as never, context("li-bad-2")), CommandValidationError);
    await assert.rejects(() => createLcaLineItem(lineItemPool().pool, { jobId: "job-1", assessmentId: "assess-1", ...line, factorSource: "dataset", factorId: "f-1" } as never, context("li-bad-3")), CommandValidationError);
  });
});

describe("bulkCreateLcaLineItems (Track C — BOM import)", () => {
  it("creates every line in one command, returning one id per line", async () => {
    const state = lineItemPool();
    const result = await bulkCreateLcaLineItems(state.pool, { jobId: "job-1", assessmentId: "assess-1", lines: [line, { ...line, lineLabel: "Steel bracket", moduleCode: "A3" }] } as never, context("li-bulk-1"));
    assert.equal(result.data.lineItemIds.length, 2);
    assert.equal(state.writes.filter((w) => w.sql.includes("INSERT INTO nzi_console.lca_line_items")).length, 2);
  });

  it("rejects an empty batch, and a batch with one bad line reports its index", async () => {
    await assert.rejects(() => bulkCreateLcaLineItems(lineItemPool().pool, { jobId: "job-1", assessmentId: "assess-1", lines: [] } as never, context("li-bulk-empty")), CommandValidationError);
    await assert.rejects(
      () => bulkCreateLcaLineItems(lineItemPool().pool, { jobId: "job-1", assessmentId: "assess-1", lines: [line, { ...line, lineLabel: "" }] } as never, context("li-bulk-bad")),
      (error: unknown) => error instanceof CommandValidationError && error.issues.some((issue) => issue.field === "lines.1.lineLabel"),
    );
  });
});

describe("updateLcaLineItem / deleteLcaLineItem (Track C)", () => {
  it("updates an existing line item (no version column — last-write-wins, matching the schema)", async () => {
    const state = lineItemPool();
    const result = await updateLcaLineItem(state.pool, { jobId: "job-1", assessmentId: "assess-1", lineItemId: "line-1", ...line, lineLabel: "Updated label" } as never, context("li-update-1"));
    assert.equal(result.data.lineItemId, "line-1");
    const update = state.writes.find((w) => w.sql.startsWith("UPDATE nzi_console.lca_line_items"));
    assert.ok(update?.values?.includes("Updated label"));
  });

  it("rejects updating an unknown line item", async () => {
    await assert.rejects(
      () => updateLcaLineItem(lineItemPool({ itemFound: false }).pool, { jobId: "job-1", assessmentId: "assess-1", lineItemId: "line-missing", ...line } as never, context("li-update-missing")),
      (error: unknown) => error instanceof CommandValidationError && error.issues.some((issue) => issue.code === "NOT_FOUND"),
    );
  });

  it("deletes an existing line item and rejects deleting an unknown one", async () => {
    const state = lineItemPool();
    const result = await deleteLcaLineItem(state.pool, { jobId: "job-1", assessmentId: "assess-1", lineItemId: "line-1" }, context("li-delete-1"));
    assert.equal(result.data.lineItemId, "line-1");
    await assert.rejects(
      () => deleteLcaLineItem(lineItemPool({ itemFound: false }).pool, { jobId: "job-1", assessmentId: "assess-1", lineItemId: "line-missing" }, context("li-delete-missing")),
      (error: unknown) => error instanceof CommandValidationError && error.issues.some((issue) => issue.code === "NOT_FOUND"),
    );
  });
});

describe("listLcaLineItems (Track C)", () => {
  it("maps a row including its factor unit and gap-fill flags", async () => {
    const client = {
      async query(sql: string) {
        if (sql.includes("FROM nzi_console.lca_line_items WHERE assessment_id=$1")) {
          return { rows: [{ line_item_id: "line-1", assessment_id: "assess-1", component_id: null, module_code: "A1", line_label: "Cardboard box", material_category_id: null, quantity: "0.5", unit: "kg", origin_country: null, energy_kwh: null, end_of_life_route: null, factor_source: "manual", dataset_id: null, factor_id: null, client_factor_id: null, factor_value: "0.8", factor_unit: "kgCO2e/kg", factor_label: "Manual estimate", factor_match_confidence: null, data_quality: "estimated", is_gap_filled: true, gap_fill_method: "category average", is_placeholder: false, transport_kgco2e: "0", calculated_kgco2e: "0.4", notes: "" }] };
        }
        return { rows: [] };
      },
      release() {},
    };
    const rows = await withTenantRead({ connect: async () => client } as never, "org-a", (db) => listLcaLineItems(db, "assess-1"));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.factorUnit, "kgCO2e/kg");
    assert.equal(rows[0]!.isGapFilled, true);
    assert.equal(rows[0]!.calculatedKgco2e, 0.4);
    assert.deepEqual(rows[0]!.transportLegs, []);
  });
});

function gapFillPool(opts: { row?: { factor_source: string; is_placeholder: boolean } | null } = {}) {
  const { row = { factor_source: "unmapped", is_placeholder: false } } = opts;
  const writes: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const client = {
    async query(sql: string, values?: readonly unknown[]) {
      writes.push({ sql, values });
      if (sql.includes("FROM nzi_console.command_idempotency")) return { rows: [] };
      if (sql.includes("FROM nzi_console.lca_assessments a JOIN")) return { rows: [{ ok: 1 }] };
      if (sql.includes("SELECT factor_source,is_placeholder FROM nzi_console.lca_line_items WHERE")) return { rows: row == null ? [] : [row] };
      return { rows: [] };
    },
    release() {},
  };
  return { pool: { connect: async () => client } as never, writes };
}

describe("gapFillLcaLineItem (Track C / L4 — the LCA analogue of the Data Assurance gate)", () => {
  const fill = { factorValue: 3.1, factorUnit: "kgCO2e/kg", gapFillMethod: "Category-average printing ink, DEFRA 2025" };

  it("gap-fills an unmapped line with a manual proxy value", async () => {
    const state = gapFillPool();
    const result = await gapFillLcaLineItem(state.pool, { jobId: "job-1", assessmentId: "assess-1", lineItemId: "line-1", ...fill }, context("gap-1"));
    assert.equal(result.data.lineItemId, "line-1");
    const update = state.writes.find((w) => w.sql.startsWith("UPDATE nzi_console.lca_line_items"));
    assert.ok(update?.sql.includes("is_gap_filled=true"), "is_gap_filled is set");
    assert.ok(update?.values?.includes(fill.gapFillMethod));
  });

  it("rejects an unknown line item", async () => {
    await assert.rejects(
      () => gapFillLcaLineItem(gapFillPool({ row: null }).pool, { jobId: "job-1", assessmentId: "assess-1", lineItemId: "line-missing", ...fill }, context("gap-missing")),
      (error: unknown) => error instanceof CommandValidationError && error.issues.some((issue) => issue.code === "NOT_FOUND"),
    );
  });

  it("rejects a placeholder row and an already-mapped line", async () => {
    await assert.rejects(
      () => gapFillLcaLineItem(gapFillPool({ row: { factor_source: "unmapped", is_placeholder: true } }).pool, { jobId: "job-1", assessmentId: "assess-1", lineItemId: "line-1", ...fill }, context("gap-placeholder")),
      (error: unknown) => error instanceof CommandValidationError && error.issues.some((issue) => issue.code === "PLACEHOLDER"),
    );
    await assert.rejects(
      () => gapFillLcaLineItem(gapFillPool({ row: { factor_source: "dataset", is_placeholder: false } }).pool, { jobId: "job-1", assessmentId: "assess-1", lineItemId: "line-1", ...fill }, context("gap-mapped")),
      (error: unknown) => error instanceof CommandValidationError && error.issues.some((issue) => issue.code === "ALREADY_MAPPED"),
    );
  });

  it("rejects a negative factor value and a blank method", async () => {
    await assert.rejects(() => gapFillLcaLineItem(gapFillPool().pool, { jobId: "job-1", assessmentId: "assess-1", lineItemId: "line-1", ...fill, factorValue: -1 }, context("gap-bad-1")), CommandValidationError);
    await assert.rejects(() => gapFillLcaLineItem(gapFillPool().pool, { jobId: "job-1", assessmentId: "assess-1", lineItemId: "line-1", ...fill, gapFillMethod: " " }, context("gap-bad-2")), CommandValidationError);
  });
});

describe("listLcaComponentsForJob / listLcaMaterialCategories (Track C / NZC-053)", () => {
  it("returns client-scoped and global components alike", async () => {
    const client = {
      async query(sql: string) {
        if (sql.includes("FROM nzi_console.lca_components c")) {
          return { rows: [
            { component_id: "comp-global", client_id: null, component_code: "GLB-1", description: "Generic cardboard", material_category_id: "cat-1", material_category_label: "Paper & board", default_unit_mass: "0.4", default_unit: "kg", origin_country: "GB", supplier_name: null },
            { component_id: "comp-client", client_id: "client-a", component_code: "CLI-1", description: "Verdant house film", material_category_id: null, material_category_label: null, default_unit_mass: null, default_unit: "kg", origin_country: null, supplier_name: "Acme Films" },
          ] };
        }
        return { rows: [] };
      },
      release() {},
    };
    const components = await withTenantRead({ connect: async () => client } as never, "org-a", (db) => listLcaComponentsForJob(db, "job-1"));
    assert.equal(components.length, 2);
    assert.equal(components.find((c) => c.id === "comp-global")!.materialCategoryLabel, "Paper & board");
    assert.equal(components.find((c) => c.id === "comp-client")!.supplierName, "Acme Films");
  });

  it("lists active material categories for the job's organisation", async () => {
    const client = {
      async query(sql: string) {
        if (sql.includes("FROM nzi_console.lca_material_categories mc")) return { rows: [{ material_category_id: "cat-1", name: "Paper & board" }] };
        return { rows: [] };
      },
      release() {},
    };
    const categories = await withTenantRead({ connect: async () => client } as never, "org-a", (db) => listLcaMaterialCategories(db, "job-1"));
    assert.deepEqual(categories, [{ id: "cat-1", name: "Paper & board" }]);
  });
});
