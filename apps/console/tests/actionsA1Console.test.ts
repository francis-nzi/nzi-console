import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { ADMIN_ITEMS } from "../app/admin/adminNav";

/**
 * Actions A1 in the console: the Admin action library (R1), and the client plan's drawers — an owner chosen from the
 * client's contacts (R4), only the ladder's legal moves offered (R3), an action added as Proposed unless the client has
 * agreed it, the Include-in-report toggle (R5), and the lever-coverage summary (R2).
 */
const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(join(here, "..", path), "utf8");
const board = read("app/admin/action-library/ActionLibraryBoard.tsx");
const page = read("app/admin/action-library/page.tsx");
const leverRoute = read("app/api/isolated/reduction-levers/route.ts");
const forms = read("app/clients/[clientId]/StrategyForms.tsx");
const area = read("app/clients/[clientId]/ReductionStrategiesArea.tsx");

describe("the Admin action library (R1)", () => {
  it("is on the admin rail, under admin.lookups, with a built page (no phase placeholder)", () => {
    const item = ADMIN_ITEMS.find((entry) => entry.id === "action-library");
    assert.ok(item);
    assert.deepEqual([item!.href, item!.capability, item!.phase], ["/admin/action-library", "admin.lookups", undefined]);
  });

  it("reads the library and levers whole, and edits only with admin.lookups and writes switched on", () => {
    assert.match(page, /listLibraryStrategies\(db\)/);
    assert.match(page, /listLevers\(db\)/);
    assert.match(page, /holds\(access\.capabilities, "admin\.lookups"\)/);
    assert.match(page, /serviceEnvironment\(\)\.writes !== "enabled"/);
  });

  it("withdraws rather than deletes, with the reason as the command's reason header", () => {
    assert.match(board, /putBrowserCommandWithReason<\{ heldByClients: number \}>\("\/api\/isolated\/reduction-strategies"[^\n]*key\("withdraw"\), reason\)/);
    assert.match(board, /putBrowserCommandWithReason<\{ strategiesUnder: number \}>\("\/api\/isolated\/reduction-levers"[^\n]*key\("withdraw"\), reason\)/);
    assert.doesNotMatch(board, /DELETE|deleteBrowserCommand/);
  });

  it("allocates a strategy to its levers, offering a withdrawn lever only where it already sits", () => {
    assert.match(board, /levers\.filter\(\(lever\) => lever\.active \|\| draft\.leverIds\.includes\(lever\.id\)\)/);
    assert.match(board, /\.\.\.draft \}, key\("save"\)/, "the allocation travels with the strategy");
  });

  it("routes the lever commands through the command runner's principal check", () => {
    assert.match(leverRoute, /requireCommandPrincipal\(request, "strategy\.lever\.upsert"\)/);
    assert.match(leverRoute, /requireCommandPrincipal\(request, "strategy\.lever\.deactivate"\)/);
  });
});

describe("the client plan's drawers (R2–R5)", () => {
  it("chooses the owner from the client's active contacts, never free text", () => {
    assert.match(forms, /contacts\.filter\(\(contact\) => contact\.status === "active"\)/);
    assert.doesNotMatch(forms, /setOwner\(event\.target\.value\)/, "the free-text owner input is gone");
    assert.match(forms, /ownerContactId: ownerContactId \|\| null/);
  });

  it("offers only the ladder's legal moves, and adds an action as Proposed unless the client has agreed it", () => {
    assert.match(forms, /strategyNextStatuses\(action\.status\)\.map/);
    assert.match(forms, /status: agreed \? "agreed" : "proposed"/);
  });

  it("removes with the reason as the command's reason header (the validator reads only the header)", () => {
    assert.match(forms, /putBrowserCommandWithReason<\{ version: number \}>\([\s\S]*?crypto\.randomUUID\(\), reason\)/);
  });

  it("names the toggle Include in report, and shows the lever coverage and what a report would leave out", () => {
    assert.match(forms, /<span>Include in report<\/span>/);
    assert.match(area, /strategyLeverCoverage\(plan, levers\)/);
    assert.match(area, /strategyIsReportable\(strategy\)/);
  });
});
