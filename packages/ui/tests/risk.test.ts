import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RiskBadge, RiskLegend } from "../src/index";

/**
 * The Risk traffic light (PR 2, ruled R6): the label always beside the dot, and colours from a status role that no
 * scope identity shares — so no single hue means both a scope and a risk state.
 */

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/styles.css"), "utf8");
const token = (name: string) => new RegExp(`--${name}:(#[0-9A-Fa-f]{6})`).exec(css)?.[1]?.toUpperCase();

describe("RiskBadge", () => {
  it("always shows the label, with a decorative dot", () => {
    for (const risk of ["Overdue", "Due", "Healthy", "Not set"] as const) {
      const html = renderToStaticMarkup(createElement(RiskBadge, { risk }));
      assert.match(html, new RegExp(`<span class="nz-risk [a-z]+"><i aria-hidden="true"></i>${risk}</span>`));
    }
  });

  it("uses risk tokens that are none of the scope-identity hues", () => {
    const scopes = ["s1", "s2", "s3"].map(token);
    assert.equal(scopes.filter(Boolean).length, 3, "the scope tokens are where the test expects them");
    for (const name of ["risk-overdue", "risk-overdue-bg", "risk-due", "risk-due-bg", "risk-healthy", "risk-healthy-bg", "risk-notset", "risk-notset-bg"]) {
      const value = token(name);
      assert.ok(value, `--${name} is defined`);
      assert.ok(!scopes.includes(value), `--${name} (${value}) must not be a scope hue`);
    }
    assert.doesNotMatch(css.slice(css.indexOf(".nz-risk{")), /var\(--(s1|s2|s3|coral|amber|emerald|danger)\)/, "the risk rules draw on no scope token");
  });
});

describe("RiskLegend", () => {
  it("lists the four levels in severity order, each labelled", () => {
    const html = renderToStaticMarkup(createElement(RiskLegend));
    const labels = [...html.matchAll(/<\/i>([^<]+)<\/span>/g)].map((match) => match[1]);
    assert.deepEqual(labels, ["Overdue", "Due", "Healthy", "Not set"]);
  });
});
