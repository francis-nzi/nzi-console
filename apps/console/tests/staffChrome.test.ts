import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CHROME_CHECKING, CHROME_SIGNED_OUT, chromeUserFor, greetingNameFor, initialsOf } from "../app/lib/staffChrome";

/**
 * The console chrome shows the signed-in member of staff (identity display fix): the rail chip and the Control Room greeting come from the
 * authenticated principal, never from a constant. A hard-coded "Francis Doherty" made every staff user read as the administrator.
 */
(globalThis as { React?: unknown }).React = React;
const components = async () => ({ ...(await import("@nzi/ui")), ...(await import("../app/lib/StaffRail")), ...(await import("../app/lib/StaffGreeting")) });
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? (name === "node_modules" || name === ".next" ? [] : walk(path)) : /\.(ts|tsx)$/.test(name) ? [path] : [];
});

describe("the console chrome shows the signed-in principal", () => {
  it("derives name, initials and role from the principal - a different principal, a different chip", () => {
    const sam = chromeUserFor({ userId: "u-sam", displayName: "Sam Staff", role: "consultant" });
    const bea = chromeUserFor({ userId: "u-bea", displayName: "Bea Brown-Jones", role: "admin" });
    assert.deepEqual(sam, { initials: "SS", name: "Sam Staff", role: "Consultant" });
    assert.deepEqual(bea, { initials: "BB", name: "Bea Brown-Jones", role: "Administrator" });
    assert.deepEqual(chromeUserFor({ userId: "u-rev", displayName: "Rae Reviewer", role: "reviewer" }).role, "Reviewer");
    assert.equal(chromeUserFor({ userId: "u-vic", displayName: "Vic Viewer", role: "viewer" }).role, "Viewer");
    assert.equal(chromeUserFor({ userId: "u-fin", displayName: "Fin", role: "finance" }).role, "Finance");
  });

  it("never invents a person: no recorded name falls back to the user id; checking and signed-out are neutral and name nobody", () => {
    assert.deepEqual(chromeUserFor({ userId: "u-x9", displayName: null, role: "viewer" }), { initials: "U", name: "u-x9", role: "Viewer" });
    assert.deepEqual(chromeUserFor({ userId: "u-x9", displayName: "   ", role: "viewer" }).name, "u-x9");
    for (const neutral of [chromeUserFor(undefined), chromeUserFor("signed-out"), chromeUserFor(null)]) assert.doesNotMatch(JSON.stringify(neutral), /Francis|Doherty|Administrator/);
    assert.equal(chromeUserFor(undefined), CHROME_CHECKING);
    assert.equal(chromeUserFor("signed-out"), CHROME_SIGNED_OUT);
    assert.equal(initialsOf("Cher"), "C");
    assert.equal(initialsOf("  Mary Jane Watson "), "MW");
    assert.equal(initialsOf(""), "?");
  });

  it("greets by the principal's first name, and by no name when there is none", () => {
    assert.equal(greetingNameFor({ userId: "u", displayName: "Sam Staff", role: "viewer" }), "Sam");
    assert.equal(greetingNameFor({ userId: "u", displayName: null, role: "viewer" }), null);
    for (const none of [undefined, "signed-out", null] as const) assert.equal(greetingNameFor(none), null);
  });

  it("renders the rail with whoever is signed in, and the rail before sign-in is neutral", async () => {
    const { WorkspaceRail, StaffRail, StaffGreeting } = await components();
    const nav = (await import("../app/lib/nav")).NAV;
    const asSam = renderToStaticMarkup(createElement(WorkspaceRail, { sections: nav, activeId: "clients", user: chromeUserFor({ userId: "u-sam", displayName: "Sam Staff", role: "consultant" }) }));
    const asBea = renderToStaticMarkup(createElement(WorkspaceRail, { sections: nav, activeId: "clients", user: chromeUserFor({ userId: "u-bea", displayName: "Bea Brown-Jones", role: "admin" }) }));
    assert.match(asSam, /Sam Staff/); assert.match(asSam, /Consultant/); assert.doesNotMatch(asSam, /Francis|Doherty|Administrator|Bea/);
    assert.match(asBea, /Bea Brown-Jones/); assert.match(asBea, /Administrator/); assert.doesNotMatch(asBea, /Francis|Doherty|Sam Staff/);
    const before = renderToStaticMarkup(createElement(StaffRail, { activeId: "clients" }));
    assert.doesNotMatch(before, /Francis|Doherty|Administrator/, "before the session is known the chip names no one");
    assert.match(before, /Checking sign-in/);
    assert.equal(renderToStaticMarkup(createElement(StaffGreeting, { word: "Good morning" })), "Good morning", "no principal yet: no name");
  });

  it("has no hard-coded user left anywhere in the console: no USER constant, no literal name in the greeting, and every rail is the signed-in one", () => {
    assert.doesNotMatch(read("app/lib/nav.ts"), /\bUSER\b|Francis|Doherty/);
    const offenders: string[] = [];
    for (const file of walk(resolve(root, "app"))) {
      const text = readFileSync(file, "utf8");
      const code = text.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, "$1");
      if (/\bUSER\b\s*[,}]|user=\{USER\}|import\s*\{[^}]*\bUSER\b/.test(code)) offenders.push(`${file}: USER`);
      if (/<WorkspaceRail\b/.test(code) && !file.endsWith("StaffRail.tsx")) offenders.push(`${file}: WorkspaceRail used directly`);
    }
    assert.deepEqual(offenders, []);
    const controlRoom = read("app/page.tsx");
    assert.doesNotMatch(controlRoom.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""), /Good (morning|afternoon|evening)[^"`]*Francis|,\s*Francis\b/);
    assert.match(controlRoom, /<StaffGreeting word=\{greeting\(\)\} \/>/);
    assert.match(read("app/lib/StaffRail.tsx"), /chromeUserFor\(useStaffMe\(true\)\)|const me = useStaffMe\(true\);[\s\S]*chromeUserFor\(me\)/);
  });

  it("takes the name from the authenticated principal's own record, in the one place the chrome asks (/api/auth/me)", () => {
    const route = read("app/api/auth/me/route.ts");
    assert.match(route, /const principal = await currentStaff\(request\)/);
    assert.match(route, /displayName: await staffDisplayName\(isolatedPool\(\), principal\)/);
    assert.match(read("app/lib/useEditAccess.ts"), /displayName\?: string \| null/);
  });
});

describe("the v7-imported banner on the staff job view", () => {
  it("is gone from the code, not hidden behind a flag: an imported period shows no QA banner", () => {
    const source = read("app/jobs/CrpScopeWorkspace.tsx");
    assert.ok(!source.includes("Imported from NZ Insights Pro v7: this period"), "the notice text is removed");
    assert.match(source, /const qaNotice: \{ kind: "ok" \| "warn"; text: string \} \| null = qa\.migratedRows > 0\s+\? null/);
    // The other two QA messages are untouched.
    assert.match(source, /QA ready: all \$\{qa\.enabled\} enabled rows/);
    assert.match(source, /QA pending: \$\{qa\.calculationMissing\} calculations missing/);
  });
});
