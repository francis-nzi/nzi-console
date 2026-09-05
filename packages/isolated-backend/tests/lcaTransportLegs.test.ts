import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CommandValidationError, createLcaTransportLeg, deleteLcaTransportLeg,
  listLcaTransportLegs, updateLcaTransportLeg, withTenantRead,
} from "../src/index";

const context = (key: string) => ({ organisationId: "org-a", actorId: "consultant-a", principal: "staff" as const, idempotencyKey: key, correlationId: `corr-${key}` });

const leg = { fromLabel: "Ningbo plant, CN", toLabel: "Felixstowe port, UK", mode: "sea" as const, distanceKm: 19600 };

function legPool(opts: { lineItemModule?: string | null; legFound?: boolean } = {}) {
  const { lineItemModule = "A4", legFound = true } = opts;
  const writes: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const client = {
    async query(sql: string, values?: readonly unknown[]) {
      writes.push({ sql, values });
      if (sql.includes("FROM nzi_console.command_idempotency")) return { rows: [] };
      if (sql.includes("FROM nzi_console.lca_line_items li")) return { rows: lineItemModule == null ? [] : [{ module_code: lineItemModule }] };
      if (sql.includes("SELECT COALESCE(MAX(leg_order)+1,0)")) return { rows: [{ next: "2" }] };
      if (sql.includes("SELECT 1 FROM nzi_console.lca_transport_legs WHERE")) return { rows: legFound === false ? [] : [{ ok: 1 }] };
      if (sql.startsWith("DELETE FROM nzi_console.lca_transport_legs")) return { rows: legFound === false ? [] : [{ leg_id: "leg-1" }] };
      return { rows: [] };
    },
    release() {},
  };
  return { pool: { connect: async () => client } as never, writes };
}

describe("createLcaTransportLeg (Track C / L3)", () => {
  it("creates a leg on an A2/A4/C2 line item, auto-assigning the next leg order", async () => {
    const state = legPool();
    const result = await createLcaTransportLeg(state.pool, { jobId: "job-1", assessmentId: "assess-1", lineItemId: "line-1", ...leg } as never, context("leg-create-1"));
    assert.ok(result.data.legId);
    const insert = state.writes.find((w) => w.sql.includes("INSERT INTO nzi_console.lca_transport_legs"));
    assert.ok(insert?.values?.includes("Ningbo plant, CN"));
    assert.ok(insert?.values?.includes(2), "leg order comes from MAX(leg_order)+1");
    assert.ok(state.writes.some((w) => w.sql.startsWith("UPDATE nzi_console.lca_line_items SET transport_kgco2e")), "the parent line's transport total is recomputed");
  });

  it("rejects a line item that isn't a transport module (A1, A3, B*, C1/C3/C4, D)", async () => {
    await assert.rejects(
      () => createLcaTransportLeg(legPool({ lineItemModule: "A1" }).pool, { jobId: "job-1", assessmentId: "assess-1", lineItemId: "line-1", ...leg } as never, context("leg-wrong-module")),
      (error: unknown) => error instanceof CommandValidationError && error.issues.some((issue) => issue.code === "WRONG_MODULE"),
    );
  });

  it("rejects an unknown line item", async () => {
    await assert.rejects(
      () => createLcaTransportLeg(legPool({ lineItemModule: null }).pool, { jobId: "job-1", assessmentId: "assess-1", lineItemId: "line-missing", ...leg } as never, context("leg-missing-item")),
      (error: unknown) => error instanceof CommandValidationError && error.issues.some((issue) => issue.code === "NOT_FOUND"),
    );
  });

  it("rejects a blank origin, an unrecognised mode, and a dataset factor with no dataset id", async () => {
    await assert.rejects(() => createLcaTransportLeg(legPool().pool, { jobId: "job-1", assessmentId: "assess-1", lineItemId: "line-1", ...leg, fromLabel: " " } as never, context("leg-bad-1")), CommandValidationError);
    await assert.rejects(() => createLcaTransportLeg(legPool().pool, { jobId: "job-1", assessmentId: "assess-1", lineItemId: "line-1", ...leg, mode: "hyperloop" } as never, context("leg-bad-2")), CommandValidationError);
    await assert.rejects(() => createLcaTransportLeg(legPool().pool, { jobId: "job-1", assessmentId: "assess-1", lineItemId: "line-1", ...leg, factorSource: "dataset", factorId: "f-1" } as never, context("leg-bad-3")), CommandValidationError);
  });

  it("rejects a 'client' factor source — there is no client_factor_id column on this table", async () => {
    await assert.rejects(() => createLcaTransportLeg(legPool().pool, { jobId: "job-1", assessmentId: "assess-1", lineItemId: "line-1", ...leg, factorSource: "client" } as never, context("leg-bad-client")), CommandValidationError);
  });
});

describe("updateLcaTransportLeg / deleteLcaTransportLeg (Track C / L3)", () => {
  it("updates an existing leg and recomputes the parent transport total", async () => {
    const state = legPool();
    const result = await updateLcaTransportLeg(state.pool, { jobId: "job-1", assessmentId: "assess-1", lineItemId: "line-1", legId: "leg-1", ...leg, distanceKm: 20000 } as never, context("leg-update-1"));
    assert.equal(result.data.legId, "leg-1");
    const update = state.writes.find((w) => w.sql.startsWith("UPDATE nzi_console.lca_transport_legs"));
    assert.ok(update?.values?.includes(20000));
    assert.ok(state.writes.some((w) => w.sql.startsWith("UPDATE nzi_console.lca_line_items SET transport_kgco2e")));
  });

  it("rejects updating an unknown leg", async () => {
    await assert.rejects(
      () => updateLcaTransportLeg(legPool({ legFound: false }).pool, { jobId: "job-1", assessmentId: "assess-1", lineItemId: "line-1", legId: "leg-missing", ...leg } as never, context("leg-update-missing")),
      (error: unknown) => error instanceof CommandValidationError && error.issues.some((issue) => issue.code === "NOT_FOUND"),
    );
  });

  it("deletes an existing leg and rejects deleting an unknown one", async () => {
    const state = legPool();
    const result = await deleteLcaTransportLeg(state.pool, { jobId: "job-1", assessmentId: "assess-1", lineItemId: "line-1", legId: "leg-1" }, context("leg-delete-1"));
    assert.equal(result.data.legId, "leg-1");
    assert.ok(state.writes.some((w) => w.sql.startsWith("UPDATE nzi_console.lca_line_items SET transport_kgco2e")));
    await assert.rejects(
      () => deleteLcaTransportLeg(legPool({ legFound: false }).pool, { jobId: "job-1", assessmentId: "assess-1", lineItemId: "line-1", legId: "leg-missing" }, context("leg-delete-missing")),
      (error: unknown) => error instanceof CommandValidationError && error.issues.some((issue) => issue.code === "NOT_FOUND"),
    );
  });
});

describe("listLcaTransportLegs (Track C / L3)", () => {
  it("maps a row in leg order, including a null calculated_kgco2e (pending the L4 calc engine)", async () => {
    const client = {
      async query(sql: string) {
        if (sql.includes("FROM nzi_console.lca_transport_legs WHERE line_item_id=$1")) {
          return { rows: [{ leg_id: "leg-1", leg_order: 0, from_label: "Ningbo plant, CN", from_lat: "29.87", from_lng: "121.55", to_label: "Ningbo port, CN", to_lat: "29.95", to_lng: "121.85", mode: "road_hgv", distance_km: "42", distance_source: "geocoded", factor_source: "unmapped", dataset_id: null, factor_id: null, factor_value: null, calculated_kgco2e: null, notes: "" }] };
        }
        return { rows: [] };
      },
      release() {},
    };
    const legs = await withTenantRead({ connect: async () => client } as never, "org-a", (db) => listLcaTransportLegs(db, "line-1"));
    assert.equal(legs.length, 1);
    assert.equal(legs[0]!.fromLat, 29.87);
    assert.equal(legs[0]!.distanceKm, 42);
    assert.equal(legs[0]!.calculatedKgco2e, null);
  });
});
