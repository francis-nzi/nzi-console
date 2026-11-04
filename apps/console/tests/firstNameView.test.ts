import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ClientContactReadModel } from "@nzi/contracts";

/**
 * A first name in the UI (0207): captured on the contact form and the team form, pre-filled from the full name and editable; and every place a
 * person is greeted reads the one rule (`callName`) rather than splitting a name on its own. (What the emails say is proved against a real database
 * in isolated-backend `firstNameReal` and `portalMessageNotificationsReal`.)
 */
(globalThis as { React?: unknown }).React = React;
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

const contact = (over: Partial<ClientContactReadModel> = {}): ClientContactReadModel => ({
  id: "k1", clientId: "c1", fullName: "Elizabeth Windsor", firstName: "Liz", jobTitle: null, email: "liz@client.example", phone: null, isPrimary: false, roles: [],
  status: "active", version: 3, updatedAt: "2026-11-01T00:00:00.000Z", updatedBy: "u", emailConsent: "unknown", ...over,
});

describe("the contact form", () => {
  it("shows the first name the contact is addressed by, beside the full name which it does not replace", async () => {
    const { ContactForm } = await import("../app/clients/[clientId]/ClientContacts");
    const html = renderToStaticMarkup(createElement(ContactForm, { clientId: "c1", contact: contact(), latestConsent: null, access: { state: "allowed" } as never, onClose: () => undefined, onSaved: () => undefined }));
    assert.match(html, /<span>First name<\/span><input[^>]*value="Liz"/);
    assert.match(html, /<span>Full name<span class="nz-req">\*<\/span><\/span><input[^>]*value="Elizabeth Windsor"/);
    assert.match(html, /Filled in from the full name; change it if they go by another name/);
  });

  it("starts empty for a new contact, and is never required - it fills itself from the full name as that is typed", async () => {
    const { ContactForm } = await import("../app/clients/[clientId]/ClientContacts");
    const html = renderToStaticMarkup(createElement(ContactForm, { clientId: "c1", contact: null, latestConsent: null, access: { state: "allowed" } as never, onClose: () => undefined, onSaved: () => undefined }));
    assert.match(html, /<span>First name<\/span><input[^>]*value=""/);
    assert.doesNotMatch(html, /First name<span class="nz-req">/);
    const source = read("apps/console/app/clients/[clientId]/ClientContacts.tsx");
    assert.match(source, /const changeFullName = \(value: string\) => \{ setFullName\(value\); if \(!firstNameEdited\) setFirstName\(firstWordOf\(value\) \?\? ""\); \}/, "follows the full name until edited");
    assert.match(source, /setFirstName\(event\.target\.value\); setFirstNameEdited\(true\)/, "an edit stops it following");
    assert.match(source, /firstName: firstName\.trim\(\) \|\| null/, "blank is sent as nothing: the server puts the default back");
  });
});

describe("the team form", () => {
  const source = read("apps/console/app/admin/team/TeamBoard.tsx");
  it("captures a first name on add and on edit, pre-filled from the name and following it until edited", () => {
    assert.match(source, /<TextField label="First name" value=\{draft\.firstName\}/);
    assert.match(source, /firstName: draft\.firstNameEdited \? draft\.firstName : firstWordOf\(displayName\) \?\? ""/);
    assert.match(source, /setDraft\(\{ \.\.\.draft, firstName, firstNameEdited: true \}\)/);
    assert.equal((source.match(/firstName: draft\.firstName\.trim\(\) \|\| null/g) ?? []).length, 2, "sent on both the add and the update");
    assert.match(source, /draft\.firstName\.trim\(\) !== \(row\.named \? row\.firstName \?\? "" : ""\)/, "a first-name-only edit is a change to save");
  });
});

describe("where a person is greeted", () => {
  it("the portal greets and names the signed-in client by first name - the welcome, the header chip and the rail chip", () => {
    const home = read("apps/console/app/portal/PortalHome.tsx");
    assert.match(home, /callName\(\{firstName:user\.firstName,fullName:user\.displayName\}\)/);
    assert.doesNotMatch(home, /displayName\.split/);
    assert.doesNotMatch(home, /<b>\{user\?\.displayName/, "the header chip is not the full name");
    assert.match(read("apps/console/app/portal/shell/PortalShellClient.tsx"), /name: callName\(\{ firstName: user\.firstName, fullName: user\.displayName \}\)/);
  });

  it("both identity feeds carry the first name, and keep the full name for the places that record who did something", () => {
    const staff = read("apps/console/app/api/auth/me/route.ts");
    assert.match(staff, /displayName: await staffDisplayName\(isolatedPool\(\), principal\), firstName: await staffChromeFirstName\(isolatedPool\(\), principal\)/);
    const portal = read("apps/console/app/api/portal/auth/me/route.ts");
    assert.match(portal, /portalUserFirstName\(db,user\.organisationId,user\.userId\)/);
    assert.match(portal, /\{\.\.\.identity,firstName,/);
    assert.match(portal, /displayName:user\.displayName/, "the full name is still in the identity");
  });

  it("no surface splits a name on its own: the first word comes from one rule (callName / firstWordOf / the SQL fragments), so two surfaces cannot disagree", () => {
    const allowed = new Set(["packages/contracts/src/firstName.ts", "apps/console/app/reports/[versionId]/composed5Helpers.ts"]); // the second reads "240 employees", not a person
    const offenders: string[] = [];
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((entry) => {
      if (["node_modules", ".next", "tests", "dist"].includes(entry)) return [];
      const full = join(dir, entry);
      return statSync(full).isDirectory() ? walk(full) : /\.(ts|tsx)$/.test(entry) ? [full] : [];
    });
    for (const base of ["apps/console/app", "packages/contracts/src", "packages/isolated-backend/src"]) {
      for (const file of walk(resolve(root, base))) {
        const name = relative(root, file).replace(/\\/g, "/");
        if (allowed.has(name)) continue;
        const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, "$1");
        if (/\.split\((?:\/\\s\+\/|" "|' ')\)\s*\[0\]/.test(code)) offenders.push(name);
      }
    }
    assert.deepEqual(offenders, [], "a surface derives a first name itself; use callName / firstWordOf (contracts) or staffFirstNameSql / portalUserFirstNameSql (addressName)");
  });
});
