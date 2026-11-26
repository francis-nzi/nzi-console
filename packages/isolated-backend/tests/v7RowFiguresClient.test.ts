import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { V7_FIGURES_CONTRACT } from "@nzi/contracts";
import { priceByV7Spans, type SpanEdition } from "../src/monthlyPricing";
import { v7FiguresPacer, V7FiguresConnectionRefused, v7RowFiguresClientFromEnv } from "../src/v7Drift";

/**
 * Datasets Part 2, increment 2: the previous system's own row figures (CONTRACT-v7-import-figures endpoint 2) — the same guard as
 * endpoint 1, one call at a time through the pace, every answer that is not a v1 reply read as unknown — and a row priced span by span
 * from V7's own spans (`priceByV7Spans`), as the rows modal judges each candidate.
 */
const SPAN_2025 = { from: "2025-04", to: "2025-12", dataset_id: 1, dataset_year: 2025, factor: 0.177, ghg_unit: "kgCO2e", tco2e: 9.679068 };
const SPAN_2026 = { from: "2026-01", to: "2026-03", dataset_id: 69, dataset_year: 2026, factor: 0.13096, ghg_unit: "kgCO2e", tco2e: 5.62761312 };
const REPLY = { contract: V7_FIGURES_CONTRACT, job_id: 256, computed_at: "2026-11-26T10:00:00Z",
  rows: [{ row_id: 9278, scope: "Scope 2", enabled: true, tco2e: 15.30668112, blended: true, custom_factor: false, spans: [SPAN_2025, SPAN_2026] }] };
const ENV = { NZI_V7_FIGURES_URL: "https://v7.example.test/",NZI_V7_FIGURES_TOKEN: "t0ken", NZI_ISOLATED_API_URL: "https://console.example.test" };
const now = async <T>(call: () => Promise<T>) => call();
const answering = (status: number, body: unknown, seen: string[] = []): typeof fetch =>
  (async (url: string | URL | Request) => { seen.push(String(url)); return new Response(typeof body === "string" ? body : JSON.stringify(body), { status }); }) as typeof fetch;

describe("the previous system's own row figures, read through the contract", () => {
  it("not configured: answers not-configured and calls nothing; a URL that is not HTTPS, or the console's, is refused", async () => {
    let called = false;
    assert.deepEqual(await v7RowFiguresClientFromEnv({}, (async () => { called = true; return new Response("{}"); }) as typeof fetch, now)({ v7JobId: "256" }), { ok: false, reason: "not-configured" });
    assert.equal(called, false);
    assert.throws(() => v7RowFiguresClientFromEnv({ ...ENV, NZI_V7_FIGURES_URL: "http://v7.example.test" }), V7FiguresConnectionRefused);
    assert.throws(() => v7RowFiguresClientFromEnv({ ...ENV, NZI_V7_FIGURES_URL: "https://console.example.test" }), V7FiguresConnectionRefused);
  });

  it("a v1 reply for the job asked is read; the path is V7's job id, never a job number", async () => {
    const seen: string[] = [];
    const read = await v7RowFiguresClientFromEnv(ENV, answering(200, REPLY, seen), now)({ v7JobId: "256" });
    assert.deepEqual(read, { ok: true, body: REPLY });
    assert.match(seen[0]!, /\/api\/console-import\/v1\/jobs\/256\/row-figures$/);
    assert.deepEqual(await v7RowFiguresClientFromEnv(ENV, answering(200, REPLY), now)({ v7JobId: "J000265" }), { ok: false, reason: "not-found" }, "an id, or nothing is called");
  });

  it("anything else is unknown, by code: another job, an extra field, a mistyped span, the statuses", async () => {
    const read = (status: number, body: unknown) => v7RowFiguresClientFromEnv(ENV, answering(status, body), now)({ v7JobId: "256" });
    assert.deepEqual(await read(200, { ...REPLY, job_id: 265 }), { ok: false, reason: "contract" });
    assert.deepEqual(await read(200, { ...REPLY, label: "x" }), { ok: false, reason: "contract" });
    assert.deepEqual(await read(200, { ...REPLY, rows: [{ ...REPLY.rows[0], spans: [{ ...SPAN_2025, tco2e: "9.7" }] }] }), { ok: false, reason: "contract" });
    assert.deepEqual(await read(200, { ...REPLY, rows: [{ ...REPLY.rows[0], site: "Head office" }] }), { ok: false, reason: "contract" }, "no label or site crosses");
    assert.deepEqual(await read(200, "not json"), { ok: false, reason: "contract" });
    assert.deepEqual(await read(404, {}), { ok: false, reason: "not-found" });
    assert.deepEqual(await read(422, {}), { ok: false, reason: "cannot-compute" });
    assert.deepEqual(await read(503, {}), { ok: false, reason: "busy" });
    assert.deepEqual(await read(500, {}), { ok: false, reason: "refused" });
  });

  it("the pace: one call at a time, each at least the floor after the last ended", async () => {
    let clock = 0;
    const waits: number[] = [];
    const pace = v7FiguresPacer(2_000, async (ms) => { waits.push(ms); clock += ms; }, () => clock);
    const order: string[] = [];
    const call = (name: string, takes: number) => pace(async () => { order.push(`start ${name}`); clock += takes; order.push(`end ${name}`); return name; });
    assert.deepEqual(await Promise.all([call("a", 500), call("b", 100), call("c", 0)]), ["a", "b", "c"]);
    assert.deepEqual(order, ["start a", "end a", "start b", "end b", "start c", "end c"], "never two at once");
    assert.deepEqual(waits, [2_000, 2_000], "the floor after each call ended");
  });
});

describe("a previous-system row priced span by span from its own spans", () => {
  const editions = new Map<number, SpanEdition>([[2025, { datasetId: "uk-ghg-gb-2025", year: 2025, selected: true, factor: { kg: 0.177, unit: "kWh", active: true } }],
    [2026, { datasetId: "uk-ghg-gb-2026", year: 2026, selected: true, factor: { kg: 0.13096, unit: "kWh", active: true } }]]);
  // V7's month_N is calendar month N: Jan–Mar 14,324 kWh each, Apr–Dec 6,076 each.
  const months = [14_324, 14_324, 14_324, 6_076, 6_076, 6_076, 6_076, 6_076, 6_076, 6_076, 6_076, 6_076];
  const base = { quantity: 97_656, months, applyPct: 100, sameUnit: (unit: string) => unit === "kWh", spans: [SPAN_2025, SPAN_2026], editions };

  it("J000265 row 9278: each span's months at its year's edition — 15.3, both parts agreeing", () => {
    const priced = priceByV7Spans(base);
    assert.equal(priced.tco2e, 15.306681);
    assert.deepEqual(priced.parts.map((part) => [part.from, part.to, part.months, part.datasetId, part.tco2e, part.agrees, part.issue]), [
      ["2025-04", "2025-12", 9, "uk-ghg-gb-2025", 9.679068, true, null], ["2026-01", "2026-03", 3, "uk-ghg-gb-2026", 5.627613, true, null]]);
  });
  it("an annual row is one span: its whole quantity at that span's edition; apportionment applies", () => {
    const priced = priceByV7Spans({ ...base, months: null, quantity: 10_000, applyPct: 50, spans: [{ ...SPAN_2025, from: "2025-04", to: "2026-03", tco2e: 0.885 }] });
    assert.deepEqual([priced.tco2e, priced.parts[0]!.agrees], [0.885, true]);
  });
  it("why a part would not come in so: an edition the job does not hold, no edition for the year, another unit, a custom factor", () => {
    const unheld = priceByV7Spans({ ...base, editions: new Map([...editions, [2026, { ...editions.get(2026)!, selected: false }]]) });
    assert.deepEqual(unheld.parts.map((part) => part.issue), [null, "dataset-not-on-job"]);
    const none = priceByV7Spans({ ...base, editions: new Map([[2025, editions.get(2025)!]]) });
    assert.deepEqual([none.tco2e, none.parts[1]!.issue], [null, "dataset-not-on-job"], "no edition for 2026: no figure");
    assert.deepEqual(priceByV7Spans({ ...base, sameUnit: () => false }).parts.map((part) => part.issue), ["unit", "unit"]);
    const custom = priceByV7Spans({ ...base, spans: [{ ...SPAN_2025, dataset_id: null }, SPAN_2026] });
    assert.deepEqual([custom.tco2e, custom.parts[0]!.issue], [null, "custom-factor"]);
  });

  // J000265 source:1169: a hotel stay, 29 "Room per night", no monthly figures, V7 at 10.4 over Apr 2025 – Mar 2026 = 0.3016 t.
  const HOTEL = new Map<number, SpanEdition>([[2025, { datasetId: "uk-ghg-gb-2025", year: 2025, selected: true, factor: { kg: 10.4, unit: "nights", active: true } }],
    [2026, { datasetId: "uk-ghg-gb-2026", year: 2026, selected: true, factor: { kg: 10.4, unit: "nights", active: true } }]]);
  const HOTEL_SPANS = [{ ...SPAN_2025, factor: 10.4, tco2e: 0.2262 }, { ...SPAN_2026, factor: 10.4, tco2e: 0.0754 }];
  const hotel = { quantity: 29, months: null, applyPct: 100, sameUnit: (unit: string) => unit === "nights", spans: HOTEL_SPANS, editions: HOTEL, ownDatasetId: "uk-ghg-gb-2025" };

  it("an annual row over two spans (J000265 source:1169): one price at its own edition (D-B), each span its months' share — 0.30 t, both parts ✓", () => {
    const priced = priceByV7Spans(hotel);
    assert.equal(priced.tco2e, 0.3016, "29 nights × 10.4 kg = 0.3016 t, as the previous system");
    assert.deepEqual(priced.parts.map((part) => [part.from, part.to, part.datasetId, part.tco2e, part.agrees, part.issue]), [
      ["2025-04", "2025-12", "uk-ghg-gb-2025", 0.2262, true, null], ["2026-01", "2026-03", "uk-ghg-gb-2025", 0.0754, true, null]],
      "priced once at its own edition, as bringing it in prices it — never \"factor not in that edition\"");
    // At its own edition, whatever another year's edition charges: bringing it in prices it so (planRowPricing, D-B).
    const dearer = new Map([...HOTEL, [2026, { ...HOTEL.get(2026)!, factor: { kg: 99, unit: "nights", active: true } }]]);
    assert.equal(priceByV7Spans({ ...hotel, editions: dearer }).tco2e, 0.3016);
  });
  it("a part's issue names what is wrong: a unit that differs is \"unit\", never no-match — and before the job's editions", () => {
    assert.deepEqual(priceByV7Spans({ ...hotel, sameUnit: () => false }).parts.map((part) => part.issue), ["unit", "unit"]);
    const unheld = new Map([...HOTEL, [2025, { ...HOTEL.get(2025)!, selected: false }]]);
    assert.deepEqual(priceByV7Spans({ ...hotel, editions: unheld, sameUnit: () => false }).parts.map((part) => part.issue), ["unit", "unit"], "the unit first");
    assert.deepEqual(priceByV7Spans({ ...base, sameUnit: () => false, editions: new Map([...editions, [2026, { ...editions.get(2026)!, selected: false }]]) }).parts.map((part) => part.issue),
      ["unit", "unit"]);
    // "no-match" only where the edition lacks the factor.
    const lacking = new Map([...HOTEL, [2025, { ...HOTEL.get(2025)!, factor: null }]]);
    assert.deepEqual(priceByV7Spans({ ...hotel, editions: lacking }).parts.map((part) => part.issue), ["no-match", "no-match"], "its own edition lacks it");
    assert.deepEqual(priceByV7Spans({ ...hotel, ownDatasetId: "uk-ghg-gb-2019" }).parts.map((part) => [part.datasetId, part.issue]),
      [[null, "dataset-not-on-job"], [null, "dataset-not-on-job"]], "its own edition not in the series' editions read");
  });
});
