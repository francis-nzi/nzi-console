import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AuditLine, CapabilityChip, DrawerEditor, EnvBadge, NumberField, ProvenanceBadge, SelectField, StatusBadge, Switch, TextField, WorkspaceRail,
} from "../src/index";

/**
 * The admin primitives (admin Phase A1; docs/design/admin-prototype.html): governance rendered as UI, labelled fields,
 * the drawer editor on the shared accessible Drawer, and the admin language scoped under `.nz-admin` (NZC-167).
 */
const render = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);
const noop = () => {};

describe("governance badges", () => {
  it("say where a record came from, in words", () => {
    assert.match(render(createElement(ProvenanceBadge, { provenance: "v7" })), />Imported · v7</);
    assert.match(render(createElement(ProvenanceBadge, { provenance: "added" })), />Added here</);
    assert.match(render(createElement(ProvenanceBadge, { provenance: "seeded" })), />Seeded</);
  });
  it("say whether a record is live — the dot is decorative, the word carries it", () => {
    assert.match(render(createElement(StatusBadge, { active: true })), /<span class="nz-a-badge ok"><i aria-hidden="true"><\/i>Active<\/span>/);
    assert.match(render(createElement(StatusBadge, { active: false })), />Inactive</);
  });
  it("name the governing capability, and the environment from what they are given", () => {
    const chip = render(createElement(CapabilityChip, { capability: "admin.lookups" }));
    assert.match(chip, /title="Changes here need the admin.lookups capability"/);
    assert.match(chip, /<span class="nz-sr-only">Governed by <\/span>admin.lookups/);
    assert.match(render(createElement(EnvBadge, { label: "Staging · isolated", detail: "d" })), /title="d"><i aria-hidden="true"><\/i>Staging · isolated</);
  });
  it("show the audit line with the record's version", () => {
    assert.match(render(createElement(AuditLine, { version: 4 })), /Every change is recorded in the audit log · v4/);
    assert.match(render(createElement(AuditLine, { version: "new" })), /audit log · new/);
  });
});

describe("admin form fields", () => {
  it("tie the label, the hint and the error to the control", () => {
    const html = render(createElement(TextField, { label: "Label", hint: "Shown in pickers.", error: "Already in use.", value: "Retail" }));
    const id = /<label for="([^"]+)">Label<\/label>/.exec(html)?.[1];
    assert.ok(id, "the label points at the input");
    assert.match(html, new RegExp(`<input id="${id}" aria-invalid="true" aria-describedby="${id}-hint ${id}-error" value="Retail"`));
    assert.match(html, new RegExp(`<div class="nz-a-hint" id="${id}-hint">Shown in pickers.</div>`));
    assert.match(html, /role="alert">Already in use.</);
  });
  it("keep a number as typed text, in the mono face", () => {
    const html = render(createElement(NumberField, { label: "Sort order", value: "10" }));
    assert.match(html, /class="nz-a-field mono"/);
    assert.match(html, /type="number" inputMode="decimal" value="10"/);
  });
  it("offer a select's options, with an optional empty choice", () => {
    const html = render(createElement(SelectField, { label: "Family", value: "", placeholder: "Choose…", options: [{ value: "crp", label: "Carbon reporting" }] }));
    assert.match(html, /<option value="" selected="">Choose…<\/option><option value="crp">Carbon reporting<\/option>/);
  });
  it("render the Active toggle as a labelled switch whose state is announced", () => {
    const html = render(createElement(Switch, { label: "Active", description: "Inactive values leave the pickers.", checked: true }));
    assert.match(html, /<button type="button" role="switch" aria-checked="true" aria-labelledby="[^"]+-label" aria-describedby="[^"]+-desc" class="nz-a-tog on">/);
  });
});

describe("the drawer editor", () => {
  it("renders nothing while closed", () => {
    assert.equal(render(createElement(DrawerEditor, { open: false, onClose: noop, eyebrow: "Industries", title: "Retail", children: "x" })), "");
  });
  it("is a named modal dialog with a close control, a body and an audit footer", () => {
    const html = render(createElement(DrawerEditor, {
      open: true, onClose: noop, eyebrow: "Industries", title: "Retail", children: createElement("p", null, "fields"),
      audit: createElement(AuditLine, { version: 3 }), actions: createElement("button", { type: "button" }, "Save"),
    }));
    assert.match(html, /^<div role="dialog" aria-modal="true" aria-label="Industries: Retail" tabindex="-1" class="nz-a-scrim">/);
    assert.match(html, /<button type="button" class="nz-a-icon-btn" aria-label="Close Retail">/);
    assert.match(html, /<div class="nz-a-drawer-body"><p>fields<\/p><\/div>/);
    assert.match(html, /audit log · v3/);
  });
  it("has no delete affordance of its own — admin records are deactivated, never deleted", () => {
    const html = render(createElement(DrawerEditor, { open: true, onClose: noop, eyebrow: "E", title: "T", children: "x", audit: createElement(AuditLine) }));
    assert.doesNotMatch(html, /delete/i);
  });
});

describe("the rail's gated items", () => {
  it("do not render until the viewer's capabilities are known — failing closed", () => {
    const html = render(createElement(WorkspaceRail, {
      sections: [{ heading: "Growth & admin", items: [
        { id: "platform", label: "Platform & audit", icon: "settings", href: "/platform" },
        { id: "admin", label: "Admin", icon: "settings", href: "/admin", capabilityPrefix: "admin." },
      ] }],
      user: { initials: "A", name: "A", role: "r" },
    }));
    assert.match(html, /href="\/platform"/);
    assert.doesNotMatch(html, /href="\/admin"/);
  });
});

describe("the admin visual language is scoped (NZC-167)", () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/styles.css"), "utf8");
  const admin = css.slice(css.indexOf("/* ── Admin section"));

  it("defines its tokens under .nz-admin — never on :root, so nothing outside /admin changes", () => {
    assert.ok(admin.length > 1000, "the admin block is present");
    assert.doesNotMatch(admin, /:root/);
    for (const rule of admin.replace(/\/\*[\s\S]*?\*\//g, "").split("}").map((part) => part.split("{")[0]!.trim()).filter(Boolean)) {
      if (rule.startsWith("@") || /^(from|to|\d+%)$/.test(rule) || rule.startsWith("--")) continue;
      for (const selector of rule.split(",").map((part) => part.trim())) {
        assert.match(selector, /^(\.nz-admin|\.nz-a-|@)/, `"${selector}" escapes the admin scope`);
      }
    }
  });

  it("carries the three-state theme: light by default, dark by system unless forced light, dark when forced", () => {
    assert.match(admin, /@media \(prefers-color-scheme:dark\)\{\.nz-admin:not\(\[data-theme="light"\]\)\{/);
    assert.match(admin, /\.nz-admin\[data-theme="dark"\]\{/);
  });

  it("uses the admin typefaces through their self-hosted variables", () => {
    assert.match(admin, /--a-sans:var\(--font-admin-sans\)/);
    assert.match(admin, /--a-mono:var\(--font-admin-mono\)/);
  });
});
