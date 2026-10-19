import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

// B2-4 (C of DESIGN-report-studio-small-fixes): the narrative edited where it is drawn, and its client-edit colour — screen only.
const APP = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "app");
const read = (path: string) => readFileSync(join(APP, path), "utf8");
const studio = read("jobs/[jobId]/report/ReportStudio.tsx");
const editor = read("jobs/[jobId]/report/StudioNarrativeEditor.tsx");
const v5 = read("reports/[versionId]/ReportComposedV5.tsx");
const css = read("reports/[versionId]/report-composed5.css");
const studioPrint = read("jobs/[jobId]/report/studioPrint.ts");

describe("C — Edit / Generate / Reset on the composed narrative", () => {
  it("is offered on a draft and (d)(ii) a validated version, behind report-edit, to someone holding report.edit — never a published one", () => {
    assert.match(studio, /const narrativeOn = reportFeatureEnabled\("report-edit"\) && Boolean\(composition\.narrative\);/);
    assert.match(studio, /: accessFor\(me, "report\.edit"\);/);
    assert.match(studio, /const narrativeTarget: NarrativeEditTarget \| null = kind === "draft" \? \{ kind: "draft", jobId \}\n\s+: kind === "validated" && version \? \{ kind: "validated", reportVersionId: version\.reportVersionId, version: version\.version \}\n\s+: null;/,
      "a published version has no target, so no editor");
    assert.match(studio, /const narrativeEditor: NarrativeEditor \| undefined = narrativeTarget && narrativeOn\n\s+\? \(_key, element, drawn\) => <StudioNarrativeEditor target=\{narrativeTarget\} /);
    assert.match(studio, /canEdit=\{editAccess\.state === "allowed" && pending === null\}/);
  });

  it("says, on a validated version, that its narrative is editable in place, bumps the version, and is issued exactly as frozen", () => {
    assert.match(studio, /<b>is editable here, on this validated version<\/b>: each save changes it in place and bumps the version — nothing is re-validated\. Publishing issues exactly the narrative frozen on it\./);
    assert.doesNotMatch(studio, /changing it means validating the report again/, "the first cut's note is gone");
    assert.match(studio, /exactly as publishing would issue it\.\{narrativeEditor \? null : " Nothing here is stored or sent\."\}/,
      "with the editor on, the band no longer says nothing is stored — a save stores");
    assert.match(studio, /: <> The narrative was frozen with this version when it was validated; publishing issues exactly that\.<\/>/,
      "without the editor (flag off) it claims nothing editable");
  });

  it("a draft drives report.section.*, pinned by the section version it was composed at; a validated version report.narrative.update, pinned by the version", () => {
    assert.match(editor, /`\/api\/isolated\/reports\/sections\/\$\{kind\}`, kind === "edit"\n\s+\? \{ jobId: target\.jobId, sectionKey: element\.key, bodyHtml, expectedVersion: element\.sectionVersion \}/);
    assert.match(editor, /"\/api\/isolated\/reports\/narrative", \{\n\s+reportVersionId: target\.reportVersionId, expectedVersion: target\.version, sectionKey: element\.key, change: kind,\n\s+\.\.\.\(kind === "edit" \? \{ bodyHtml \} : \{\}\),/);
    assert.match(editor, /This section changed since the draft was composed — reload to see it, then edit again\./);
    assert.match(editor, /This version changed since you opened it — reload to see it, then edit again\./);
    // And which path a target takes: only a draft reaches the section commands.
    assert.match(editor, /const result = target\.kind === "draft"\n\s+\? await postBrowserCommand<\{ version: number \}>\(`\/api\/isolated\/reports\/sections\/\$\{kind\}`/);
  });

  it("keeps figures locked: the editor shows chips, a figure comes from the palette, and a typed figure or money is refused before sending", () => {
    assert.match(editor, /dangerouslySetInnerHTML=\{\{ __html: narrativeForEditing\(element\.bodyHtml, composition\) \}\}/);
    assert.match(editor, /const html = serializeReportSectionBody\(body\.current\?\.innerHTML \?\? ""\);\n\s+const issues = reportNarrativeBodyIssues\(html\);\n\s+if \(issues\.length\) \{ setProblem/);
    assert.match(editor, /<option value="">Insert a figure…<\/option>/);
    assert.match(editor, /reportTokenCatalogue\.filter\(\(token\) => resolveComposedToken\(token\.key, composition\)\.ok && token\.kind !== "phrase"\)/);
  });

  it("Reset is offered only when there is something to reset to", () => {
    assert.match(editor, /disabled=\{!canEdit \|\| busy !== null \|\| \(element\.contentSource === "default" && element\.sectionVersion === 0\)\}/);
  });

  it("the editor is a prop of the renderer, passed only by the studio — an issued report draws the renderer's own markup", () => {
    assert.match(v5, /return editor \? <>\{editor\(sectionKey, element, drawn\)\}<\/> : drawn;/);
    assert.equal((v5.match(/editor=\{editor\}/g) ?? []).length, 6 + 6, "the six blocks, through their six sections");
  });
});

describe("the client-edit colour: amber on screen, stripped in print", () => {
  it("marks an edited block with the amber pill and a left rule — the body text stays ink", () => {
    assert.match(v5, /<div className=\{`r5-editblock r5-src-\$\{element\.contentSource\}`\} data-narrative=\{sectionKey\}>/);
    assert.match(v5, /const SOURCE_LABEL: Record<ReportNarrativeElement\["contentSource"\], string> = \{ default: "Default template", ai: "AI-drafted", "client-edited": "Edited by client" \};/);
    assert.match(css, /\.nzr5 \.r5-spill-client-edited\{background:#FFF4DB;color:#7A4F00;border-color:#F5D58A\}/);
    assert.match(css, /\.nzr5 \.r5-editblock\.r5-src-client-edited\{border-left:3px solid #FFC24B;padding-left:12px;margin-left:-15px\}/);
    assert.match(css, /\.nzr5 \.r5-spill-ai\{background:var\(--r5-sky-bg\);color:var\(--r5-sky-ink\);border-color:var\(--r5-sky-line\)\}/);
    assert.doesNotMatch(css, /\.r5-src-client-edited \.r5-prose\{[^}]*color/, "never amber body text");
  });

  it("strips the pill, the rule and the chip styling in print — composed@6 only, so composed@5's issued print is untouched", () => {
    const print = css.slice(css.indexOf("@media print{\n  .nzr5[data-renderer=\"composed@6\"]"));
    assert.match(print, /\.nzr5\[data-renderer="composed@6"\] \.r5-spill\{display:none!important\}/);
    assert.match(print, /\.nzr5\[data-renderer="composed@6"\] \.r5-editblock\{border-left:0!important;padding-left:0!important;margin-left:0!important\}/);
    assert.match(print, /\.nzr5\[data-renderer="composed@6"\] \.r5-tok\{background:none!important;border:0!important;padding:0!important;color:inherit!important\}/);
    // The studio's own print and Page · A4 strip the same, and the editor's controls.
    assert.match(studioPrint, /"\.nzr5 \.r5-editblock\{border-left:0!important;padding-left:0!important;margin-left:0!important\}",/);
    assert.match(studioPrint, /"\.nzs-narr-tools,\.nzs-narr-note\{display:none!important\}",/);
  });
});
