import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { INFOTIP_GAP, INFOTIP_MARGIN, placeInfoTip } from "../../../packages/ui/src/InfoTip";

const here = dirname(fileURLToPath(import.meta.url));
const box = (left: number, top: number, size = 15) => ({ left, top, right: left + size, bottom: top + size, width: size, height: size });
const pop = { width: 230, height: 80 };
const viewport = { width: 1200, height: 800 };

describe("InfoTip placement", () => {
  it("sits below the button, left-aligned to it", () => {
    const spot = placeInfoTip(box(300, 200), pop, viewport);
    assert.deepEqual([spot.placement, spot.left, spot.top], ["below", 300, 215 + INFOTIP_GAP]);
  });
  it("flips above when there is no room below", () => {
    const spot = placeInfoTip(box(300, 750), pop, viewport);
    assert.equal(spot.placement, "above");
    assert.equal(spot.top, 750 - INFOTIP_GAP - pop.height);
  });
  it("stays inside the viewport at either edge", () => {
    assert.equal(placeInfoTip(box(1190, 100), pop, viewport).left, viewport.width - pop.width - INFOTIP_MARGIN);
    assert.equal(placeInfoTip(box(2, 100), pop, viewport).left, INFOTIP_MARGIN);
  });
  it("points the arrow at the button even after shifting", () => {
    const spot = placeInfoTip(box(1190, 100), pop, viewport);
    assert.ok(spot.arrowLeft > pop.width / 2 && spot.arrowLeft <= pop.width - 16);
  });
});

describe("InfoTip is drawn outside any clipping ancestor", () => {
  const source = readFileSync(resolve(here, "../../../packages/ui/src/InfoTip.tsx"), "utf8");
  const css = readFileSync(resolve(here, "../../../packages/ui/src/styles.css"), "utf8");
  it("portals the visible popover to <body>, fixed to the viewport", () => {
    assert.match(source, /createPortal\([\s\S]*document\.body/);
    assert.match(css, /\.nz-infotip-float\{position:fixed;/);
  });
  it("no longer positions the visible popover inside the wrapper", () => {
    assert.doesNotMatch(css, /\.nz-infotip-pop\{position:absolute;z-index/);
  });
});
