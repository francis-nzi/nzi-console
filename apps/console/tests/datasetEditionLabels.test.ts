import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DatasetRegistryIssue, DatasetRegistryItem } from "@nzi/isolated-backend";

/**
 * The library list and the job's datasets show a dataset by its edition ("DESNZ GB 2026"), never the file it was imported as
 * (DATASET-CURRENCY §2; staging's 2026 editions were imported as "tmpai4mgnde.csv", 26 Nov). The file name stays only where §2 put
 * it: a tooltip.
 */
(globalThis as { React?: unknown }).React = React;
let board: typeof import("../app/datasets/DatasetBoard");
before(async () => { board = await import("../app/datasets/DatasetBoard"); });
const read = (path: string) => readFileSync(new URL(`../app/${path}`, import.meta.url), "utf8");

const TEMP = "tmpai4mgnde.csv";
const DATASET: DatasetRegistryItem = { id: "uk-ghg-gb-2026", name: TEMP, label: "DESNZ GB 2026", version: TEMP, validFrom: "2026-01-01", validTo: "2026-12-31", country: "GB",
  scopes: ["1", "2", "3"], method: "activity", source: "DESNZ", analysisType: "published-source", year: 2026, licence: "OGL", status: "active", factorCount: 7000, usedByJobs: 3, synthetic: false };
const ISSUE: DatasetRegistryIssue = { id: "i1", severity: "warning", datasetId: "uk-ghg-gb-2026", jobNumber: "J000265", message: "Cross-country use", state: "open" };
// Text a person reads: the markup without its tags' attributes (a tooltip is an attribute).
const visible = (markup: string) => markup.replace(/<[^>]*>/g, " ");

describe("the library list: the edition, never the file it was imported as", () => {
  it("the list, the open drawer's title and subtitle, and the audit table all say \"DESNZ GB 2026\"; no file name is visible text", () => {
    const markup = renderToStaticMarkup(createElement(board.DatasetBoard, { datasets: [DATASET], issues: [ISSUE] }));
    assert.ok(visible(markup).includes("DESNZ GB 2026"));
    assert.equal(visible(markup).split("DESNZ GB 2026").length - 1 >= 3, true, "the list, the drawer's title and the audit table");
    assert.ok(!visible(markup).includes(TEMP), "no temp file name in what a person reads");
    assert.ok(markup.includes(`title="Imported as ${TEMP}"`), "§2: the imported name stays as the tooltip");
    const source = read("datasets/DatasetBoard.tsx");
    assert.ok(!source.includes("imported as ${selected.name} ${selected.version}"), "the drawer's subtitle names no file");
    assert.ok(source.includes(`dataset.id === issue.datasetId)?.label??"Dataset unavailable"`), "the audit table names the edition");
  });
});

describe("the job's datasets: the edition, never the file", () => {
  it("the selected datasets read by label (§2) — the imported name only as the tooltip", () => {
    const source = read("jobs/CrpScopeWorkspace.tsx");
    assert.match(source, /<li key=\{d\.datasetId\} title=\{`\$\{d\.name\} · \$\{d\.version\}`\}>\s*<b>\{d\.label\}<\/b>/);
  });
  it("a period change's plan names the automatic and hand-chosen datasets by edition", () => {
    const source = read("jobs/JobMilestonesPanel.tsx");
    assert.ok(source.includes("items.map((item) => datasetLabelFromId(item.datasetId))"));
    assert.ok(source.includes("Chosen by hand, kept: <b>{datasetLabelFromId(manual.datasetId)}</b>"));
    assert.ok(!/manual\.name|item\.name/.test(source), "no dataset's imported name");
  });
});
