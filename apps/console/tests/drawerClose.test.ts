import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Every drawer closes: a visible × top-right, Escape, and a click on the scrim - from the shared components, not drawer by drawer.
 * (Escape and the focus handling are the Drawer's own and unchanged; this pins what is new, and audits every call site so a new
 * drawer cannot quietly opt out.)
 */
(globalThis as { React?: unknown }).React = React;
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");

const ui = () => import("@nzi/ui");
const drawerModule = () => import("../../../packages/ui/src/Drawer");
const render = async (props: Record<string, unknown>, label = "Row detail") => {
  const { Drawer } = await ui();
  return renderToStaticMarkup(createElement(Drawer, { open: true, onClose: () => undefined, ariaLabel: label, className: "nz-site-drawer", ...props } as never, createElement("p", null, "body")));
};

describe("the shared Drawer", () => {
  it("gives every drawer a visible close × (named for the drawer) that closes it", async () => {
    const html = await render({});
    assert.match(html, /<button type="button" class="nz-drawer-close"[^>]*aria-label="Close Row detail"/);
    assert.match(html, /<svg[^>]*aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/);
    assert.equal(await render({ open: false }), "", "closed: nothing");
  });

  it("closes on a click on the scrim by default (the root is the scrim) - and on a separate scrim where the panel's class draws none", async () => {
    // Default: the root element handles a pointer-down on itself; React does not print handlers, so pin the contract on the source.
    const source = readFileSync(resolve(root, "packages/ui/src/Drawer.tsx"), "utf8");
    assert.match(source, /dismissOnOutsideClick = true/);
    assert.match(source, /if \(event\.target === event\.currentTarget\) onClose\(\)/);
    const withScrim = await render({ addScrim: true });
    assert.ok(withScrim.indexOf('class="nz-drawer-scrim"') >= 0 && withScrim.indexOf('class="nz-drawer-scrim"') < withScrim.indexOf('role="dialog"'), "a scrim element behind the panel");
    assert.doesNotMatch(await render({}), /nz-drawer-scrim/, "a panel that draws its own scrim gets no second one");
  });

  it("a gate that must be answered, not dismissed, has no × and no scrim", async () => {
    const html = await render({ dismissible: false, addScrim: true });
    assert.doesNotMatch(html, /nz-drawer-close|nz-drawer-scrim/);
    assert.match(html, /role="dialog"/);
  });

  it("keeps a close the content already has, and adds none beside it", async () => {
    const { hasOwnCloseControl, OWN_CLOSE_SELECTOR } = await drawerModule();
    const stub = (matches: boolean) => ({ querySelector: (selector: string) => (matches && selector === OWN_CLOSE_SELECTOR ? {} : null) });
    assert.equal(hasOwnCloseControl(stub(true)), true);
    assert.equal(hasOwnCloseControl(stub(false)), false);
    assert.equal(hasOwnCloseControl(null), false);
    for (const own of ["button.x", "button.close", "[data-drawer-close]:not([data-drawer-auto])", '.nz-a-icon-btn[aria-label^="Close"]']) assert.ok(OWN_CLOSE_SELECTOR.includes(own), own);
    assert.ok(!OWN_CLOSE_SELECTOR.includes('button[aria-label^="Close"]'), "an ordinary 'Close …' action button is not a drawer close");
  });
});

describe("the docked evidence panel", () => {
  const panel = async (onClose?: () => void) => renderToStaticMarkup(createElement((await ui()).EvidenceDrawer, { kicker: "Client · active", title: "Acme Ltd", subtitle: "Manufacturing", onClose } as never, createElement("p", null, "body")));
  it("has a close × when its host says what closing means, and none when it does not", async () => {
    assert.match(await panel(() => undefined), /<button type="button" class="x" data-drawer-close="true" aria-label="Close Acme Ltd"[^>]*>×<\/button>/);
    assert.match(await panel(() => undefined), /class="nz-dh has-close"/);
    assert.doesNotMatch(await panel(), /aria-label="Close/);
  });
});

/** The tag of each `<Name …>` in a file, scanned past `=>` and nested braces to the real closing `>`. */
function tagsOf(source: string, name: string): string[] {
  const tags: string[] = [];
  for (let at = source.indexOf(`<${name}`); at !== -1; at = source.indexOf(`<${name}`, at + 1)) {
    if (!/[\s>]/.test(source[at + name.length + 1] ?? "")) continue;
    let depth = 0, quote = "";
    let end = at + name.length + 1;
    for (; end < source.length; end += 1) {
      const c = source[end]!;
      if (quote) { if (c === quote && source[end - 1] !== "\\") quote = ""; continue; }
      if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "{") depth += 1;
      else if (c === "}") depth -= 1;
      else if (c === ">" && depth === 0 && source[end - 1] !== "=") break;
    }
    tags.push(source.slice(at, end + 1));
  }
  return tags;
}
const walk = (dir: string): string[] => readdirSync(dir).flatMap((entry) => {
  if (["node_modules", ".next", "tests"].includes(entry)) return [];
  const full = join(dir, entry);
  return statSync(full).isDirectory() ? walk(full) : /\.tsx$/.test(entry) ? [full] : [];
});
const files = walk(resolve(root, "apps/console/app")).map((file) => ({ name: relative(root, file).replace(/\\/g, "/"), source: readFileSync(file, "utf8") }));

describe("every drawer in the app", () => {
  const calls = files.flatMap((file) => tagsOf(file.source, "Drawer").map((tag) => ({ file: file.name, tag })));

  it("is a shared Drawer that can be dismissed - the only two that cannot are the terms gate and the idle warning", () => {
    assert.ok(calls.length >= 15, `only ${calls.length} Drawer call sites found - the scan is broken`);
    const gates = calls.filter((call) => /dismissible=\{false\}/.test(call.tag)).map((call) => call.file).sort();
    assert.deepEqual(gates, ["apps/console/app/portal/PortalInactivityGuard.tsx", "apps/console/app/portal/PortalTermsGate.tsx"]);
    assert.deepEqual(calls.filter((call) => /dismissOnOutsideClick=\{false\}/.test(call.tag)).map((call) => call.file), [], "none opts out of the scrim click");
  });

  it("has a scrim to click: its class draws one, or it adds its own", () => {
    const ownScrim = /\b(nz-site-drawer|nz-import-modal|nz-a-scrim)\b/;
    // Inline (not an overlay) when the portal shell flag is off: no scrim exists to click, and it never had one.
    const inline = new Set(["apps/console/app/portal/files/PortalFilesView.tsx", "apps/console/app/portal/jobs/[jobId]/data/PortalDataView.tsx"]);
    const without = calls.filter((call) => !/dismissible=\{false\}/.test(call.tag) && !ownScrim.test(call.tag) && !/\baddScrim\b/.test(call.tag)).map((call) => call.file);
    assert.deepEqual(without.filter((file) => !inline.has(file)), [], "a Drawer whose class draws no scrim must say addScrim");
    assert.ok(calls.some((call) => /\baddScrim\b/.test(call.tag)), "the assurance drawers add one");
  });

  it("the shared admin editor keeps its own ×, Escape and scrim", () => {
    const editor = readFileSync(resolve(root, "packages/ui/src/admin/DrawerEditor.tsx"), "utf8");
    assert.match(editor, /className="nz-a-icon-btn" onClick=\{onClose\} aria-label=\{`Close \$\{title\}`\}/);
    assert.match(editor, /className="nz-a-scrim" dismissOnOutsideClick/);
  });

  it("every docked evidence panel says what its close does", () => {
    const panels = files.flatMap((file) => tagsOf(file.source, "EvidenceDrawer").map((tag) => ({ file: file.name, tag })));
    assert.ok(panels.length >= 9, `only ${panels.length} EvidenceDrawer call sites found`);
    assert.deepEqual(panels.filter((panel) => !/\bonClose=/.test(panel.tag)).map((panel) => panel.file), [], "an evidence panel with no close");
  });
});
