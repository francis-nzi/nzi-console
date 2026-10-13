import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FigureEvidence } from "@nzi/contracts";
import { FigureEvidenceBody } from "../app/clients/[clientId]/FigureEvidence";

(globalThis as { React?: unknown }).React = React;

// Ruled 13 Oct 2026: the drawer shows a figure's factor sets by dataset id, never the upload file name its stamp carries.
const figure = (labels: FigureEvidence["provenanceLabels"]): FigureEvidence => ({
  state: "resolved", value: 10, unit: "tCO₂e", qualityTier: "Measured", tiers: [{ tier: "Measured", tco2e: 10 }],
  provenance: { factorSet: "tmpupload1.csv", factorSetVersion: "tmpupload1.csv tmpupload1.csv", dataHash: "sha256:abc", asAtDate: "2026-05-02", sourceRef: "J000001 · reviewed snapshot v1", resolver: "crp.snapshot.issue@2", source: "issued" },
  ...(labels ? { provenanceLabels: labels } : {}),
  lineage: [], source: null, note: null,
});
const draw = (value: FigureEvidence) => renderToStaticMarkup(createElement(FigureEvidenceBody, { figure: value, context: "Synthetic" }));

describe("the evidence drawer names factor sets by dataset id", () => {
  it("shows the id-derived labels, and no upload file name", () => {
    const html = draw(figure({ factorSet: "DESNZ GB 2026", factorSetVersion: "DESNZ GB 2026 (uk-ghg-gb-2026)" }));
    assert.match(html, /Factor set<\/span><span class="v">DESNZ GB 2026<\/span>/);
    assert.match(html, /Factor-set version<\/span><span class="v">DESNZ GB 2026 \(uk-ghg-gb-2026\)<\/span>/);
    assert.doesNotMatch(html, /tmpupload1/);
    assert.match(html, /sha256:abc/, "the rest of the signature is shown as it is");
  });

  it("a figure without labels shows its signature exactly as before", () => {
    const html = draw(figure(undefined));
    assert.match(html, /Factor set<\/span><span class="v">tmpupload1.csv<\/span>/);
  });
});
