import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * Actions A3 in the console and the worker's service: the reminder settings sit beside the message templates under the
 * same capability; a consultant sets an action's own lead on the plan, and the plan says what each action's reminder will
 * do — or why it cannot (R3); the worker links to the portal at the console's own address and logs counts, never people.
 */
const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(join(here, "..", path), "utf8");
const repo = (path: string) => readFileSync(join(here, "..", "..", "..", path), "utf8");
const route = read("app/api/isolated/reminder-settings/route.ts");
const page = read("app/admin/message-templates/page.tsx");
const card = read("app/admin/message-templates/ReminderSettingsCard.tsx");
const area = read("app/clients/[clientId]/ReductionStrategiesArea.tsx");
const forms = read("app/clients/[clientId]/StrategyForms.tsx");
const worker = repo("packages/isolated-backend/scripts/reminder-worker.ts");
const render = repo("render.yaml");

describe("Admin: the switch and the default lead, beside the templates (R6)", () => {
  it("is written only through the gated, audited command", () => {
    assert.match(route, /requireCommandPrincipal\(request, "admin\.reminders\.update"\)/);
    assert.match(route, /export async function PUT/);
    assert.match(card, /putBrowserCommand\("\/api\/isolated\/reminder-settings",\s*\{ enabled, defaultLeadDays: leadDays, expectedVersion: settings\.version \}/);
  });

  it("is on the message templates page, editable only where the templates are", () => {
    assert.match(page, /readReminderSettings\(db, access\.organisationId\)/);
    assert.match(page, /<ReminderSettingsCard settings=\{data\.reminders\} editing=\{editing\} \/>/);
    assert.match(card, /disabled=\{readOnly \|\| saving\}/);
  });
});

describe("the plan: an action's own lead, and what its reminder will do (R1, R3)", () => {
  it("sends the lead with the action — blank for the organisation's default", () => {
    assert.match(forms, /const reminderLeadDays = reminderLead\.trim\(\) === "" \? null : Number\(reminderLead\);/);
    assert.match(forms, /srsRequirementIds, includeInReport, reminderLeadDays \}/);
  });

  it("says why a reminder that is owed cannot go, rather than dropping it", () => {
    assert.match(area, /<ReminderLine status=\{reminder\} \/>/);
    assert.match(area, /className=\{blocked \? "sub nz-reminder-line blocked" : "sub nz-reminder-line"\}/);
    assert.match(area, /strategyReminderStatusLabel\(status\)/);
  });
});

describe("the worker's service", () => {
  it("links to the portal at the console's own address, set on the worker as on the console", () => {
    assert.match(worker, /consoleOrigin: process\.env\.NZI_ISOLATED_API_URL/);
    const workerBlock = render.slice(render.indexOf("name: nzi-console-reminders"));
    assert.match(workerBlock.slice(0, workerBlock.indexOf("- type:", 10) === -1 ? undefined : workerBlock.indexOf("- type:", 10)),
      /- key: NZI_ISOLATED_API_URL\s+value: https:\/\/nzi-pro-api-prod\.onrender\.com/);
  });

  it("logs the reminder scan as counts — no address, name or title reaches the log", () => {
    assert.match(worker, /dueReminders: dueReminders\.ok \? dueReminders\.summary : \{ failed: dueReminders\.error \}/);
  });
});
