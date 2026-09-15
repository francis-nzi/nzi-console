import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

/**
 * Reduction Strategies. The rules worth holding: the library is Admin-managed and the plan
 * is not; levers are a many-to-many categorisation and control level is a separate axis;
 * removing keeps history; the plan never borrows the authority of the measurement half; and
 * nothing fabricates a reduction figure.
 */
describe("Reduction Strategies", () => {
  // 0075 created the model; 0078 restructured it. Constraints live where they were created,
  // so assertions read whichever file actually holds the thing being asserted.
  const created = read("packages/isolated-backend/migrations/0075_action_lever_library.sql");
  const restructured = read("packages/isolated-backend/migrations/0078_reduction_strategies.sql");
  const backend = read("packages/isolated-backend/src/reductionStrategies.ts");
  const contract = read("packages/contracts/src/reductionStrategies.ts");
  const commands = read("packages/contracts/src/commands.ts");
  const area = read("apps/console/app/clients/[clientId]/ReductionStrategiesArea.tsx");
  const forms = read("apps/console/app/clients/[clientId]/StrategyForms.tsx");

  it("keeps the library Admin-managed and the plan consultant-managed", () => {
    // A consultant builds a plan from the library but does not get to redefine the library
    // while doing it — different jobs, different blast radii.
    for (const key of ["strategy.library.upsert", "strategy.library.deactivate"]) {
      assert.match(commands, new RegExp(`"${key}": \\{ key: "${key}"[^}]*permission: "admin\\.lookups"`), key);
    }
    for (const key of ["client.strategy.assign", "client.strategy.update", "client.strategy.remove"]) {
      assert.match(commands, new RegExp(`"${key}": \\{ key: "${key}"[^}]*permission: "strategy\\.manage"`), key);
    }
    const permissions = read("packages/contracts/src/permissions.ts");
    const consultant = /consultant: \{([\s\S]*?)\n  \},/.exec(permissions)?.[1] ?? "";
    assert.ok(consultant.includes("strategy.manage"), "a consultant builds the plan");
    assert.ok(!consultant.includes("admin.lookups"), "and does not edit the library");
  });

  it("renames the capability as a new matrix version rather than editing one", () => {
    // A principal resolved against an earlier version must keep meaning what it meant.
    assert.match(read("packages/contracts/src/permissions.ts"), /PERMISSION_MATRIX_VERSION = 3/);
    const v3 = read("packages/isolated-backend/migrations/0079_strategy_capability.sql");
    assert.match(v3, /INSERT INTO nzi_console\.staff_capability_matrix_versions[\s\S]*VALUES \(3,/);
    assert.match(v3, /\(3, 'consultant', 'strategy\.manage', 'all'\)/);
    // The frozen earlier versions still say what they said.
    assert.match(read("packages/isolated-backend/migrations/0073_training_capabilities.sql"), /'actions\.manage'/);
  });

  it("nothing in the app still calls them Actions", () => {
    for (const source of [area, forms, contract, backend]) {
      assert.doesNotMatch(source, /\bactions\.manage\b/);
      assert.doesNotMatch(source, /\bActionsArea\b/);
    }
    assert.match(read("apps/console/app/clients/[clientId]/clientAreas.ts"), /strategies: "Reduction Strategies"/);
    // And it is never bare "Strategies" — `Strategy` is already an SRS pillar.
    assert.match(area, /never bare "Strategies"/);
  });

  it("makes levers a many-to-many categorisation, with control level a separate axis", () => {
    assert.match(restructured, /CREATE TABLE nzi_console\.levers/);
    assert.match(restructured, /CREATE TABLE nzi_console\.strategy_levers/);
    assert.match(restructured, /PRIMARY KEY \(organisation_id, strategy_id, lever_id\)/);
    assert.match(contract, /export type Lever = \{/);
    assert.match(contract, /leverIds: string\[\]/);
    // Control level survives as its own single-value axis.
    assert.match(contract, /export const strategyControlLevels = \["direct_control", "supply_chain", "influence"\]/);
    assert.match(restructured, /Control level stays a \*\*separate single-value axis\*\*/);
  });

  it("shows a strategy under every lever it belongs to", () => {
    // That is what a many-to-many grouping means; hiding it from one of its themes would
    // make the grouping lie.
    assert.match(contract, /strategy\.leverIds\.includes\(lever\.id\)/);
    assert.match(contract, /appears under both/);
  });

  it("never drops a strategy whose lever was withdrawn", () => {
    // A plan grouped by lever would otherwise get quietly shorter than the one agreed.
    assert.match(contract, /export function strategiesWithoutLever/);
    assert.match(area, /strategiesWithoutLever\(plan, levers\)/);
    assert.match(area, /Not yet allocated to a lever/);
  });

  it("collapses lever sections per the collapsible-cards convention", () => {
    assert.match(area, /aria-expanded=\{!collapsed\}/);
    assert.match(area, /aria-controls=\{bodyId\}/);
    assert.match(area, /Open all/);
    assert.match(area, /Collapse all/);
    // A collapsed group still says how much is inside it.
    assert.match(area, /\{strategies\.length\} \{strategies\.length === 1 \? "strategy" : "strategies"\}/);
    // Per-viewer convenience, never load-bearing.
    assert.match(area, /never load-bearing/);
  });

  it("deactivates rather than deletes, everywhere that carries history", () => {
    for (const table of ["reduction_strategies", "client_strategies"]) {
      assert.match(created, new RegExp(`REVOKE DELETE ON nzi_console\\.${table.replace("reduction_strategies", "action_levers").replace("client_strategies", "client_actions")}`), table);
    }
    assert.match(restructured, /REVOKE DELETE ON nzi_console\.levers/);
    assert.match(backend, /SET active=false/);
    assert.match(commands, /"client\.strategy\.remove"[^}]*reasonRequired: true/);
    assert.match(commands, /"strategy\.library\.deactivate"[^}]*reasonRequired: true/);
    // The join is the exception, and says why: re-allocating is an edit, not a record.
    assert.match(restructured, /GRANT SELECT, INSERT, DELETE ON nzi_console\.strategy_levers/);
    assert.match(restructured, /carries no history of its own/);
  });

  it("keeps a withdrawn library strategy on the plans that hold it", () => {
    assert.match(backend, /WITHDRAWN/);
    assert.match(contract, /not offered to anyone new/);
  });

  it("holds one meaning of done, in the database and in the form", () => {
    assert.match(created, /CHECK \(\(status = 'complete'\) = \(progress_pct = 100\)\)/);
    assert.match(commands, /A complete action is at 100%, and an action at 100% is complete/);
    assert.match(forms, /strategyProgressForStatus|strategyStatusForProgress/);
  });

  it("refuses the same library strategy twice on one plan", () => {
    assert.match(created, /CREATE UNIQUE INDEX client_actions_one_live_per_lever_idx/);
    assert.match(restructured, /_one_live_per_lever_', '_one_live_per_strategy_'/);
    assert.match(backend, /ALREADY_ASSIGNED/);
  });

  it("takes a library strategy's wording from the library, not a stale copy", () => {
    assert.match(backend, /LEFT JOIN nzi_console\.reduction_strategies l ON \(l\.organisation_id, l\.strategy_id\) = \(a\.organisation_id, a\.strategy_id\)/);
    assert.match(backend, /title: row\.strategy_title \?\? row\.bespoke_title/);
    assert.match(created, /CONSTRAINT client_actions_lever_or_bespoke CHECK/);
  });

  it("never fabricates a reduction figure", () => {
    assert.match(created, /CONSTRAINT action_levers_modelled_impact_sourced/);
    const seed = /INSERT INTO nzi_console\.action_levers[\s\S]*?ON CONFLICT DO NOTHING;/.exec(created)?.[0] ?? "";
    assert.ok(seed.length > 0 && !seed.includes("modelled_"), "no seeded strategy claims an impact");
    // The screen now carries a quantified layer (NZC-078), so "nothing here estimates it" is
    // no longer the claim. What must still hold is the distinction it was protecting: an
    // estimate is labelled an estimate, progress is not a reduction, and neither is measured.
    assert.match(area, /not a modelled reduction/);
    assert.match(area, /consultant <b>estimate<\/b> per strategy/);
    assert.match(area, /it is never measured/);
    const projection = read("apps/console/app/clients/[clientId]/StrategyProjection.tsx");
    assert.match(projection, /consultant estimates<\/b>, not measurements/);
    assert.match(projection, /compared — never combined/);
  });

  it("keeps the plan distinct from the measurement", () => {
    assert.match(area, /PLAN half of a CRP/);
    const strip = (text: string) => text.replace(/^\s*--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(strip(backend), /scope_rows|factor_id|quality_tier/);
    assert.doesNotMatch(strip(restructured), /scope_rows|factor_id|quality_tier/);
  });

  it("uses the curated icon set, not emoji", () => {
    assert.match(area, /NziIcon/);
    for (const source of [area, forms]) {
      assert.doesNotMatch(source, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    }
    const iconFile = read("packages/ui/src/NziIcon.tsx");
    const seeded = [...restructured.matchAll(/'(energy|building|vehicle|handshake|tools|recycle|policy)'/g)].map(([, key]) => key);
    assert.ok(seeded.length > 0, "levers are seeded with icon keys");
    for (const key of new Set(seeded)) assert.match(iconFile, new RegExp(`\\b${key}:`), `${key} must exist in NziIcon`);
  });

  it("renders as a real area rather than the unavailable placeholder", () => {
    assert.match(read("apps/console/app/clients/[clientId]/clientAreas.ts"), /BUILT_AREAS[\s\S]*?"strategies"/);
    const view = read("apps/console/app/clients/[clientId]/ClientWorkspaceView.tsx");
    assert.match(view, /area === "strategies" \? <ReductionStrategiesArea/);
    assert.match(view, /useEditAccess\("strategy\.manage", writeEnabled\)/);
  });

  it("leaves 'sphere of influence' to the SBTi framework", () => {
    const mentions = [...contract.matchAll(/sphere/gi)].length;
    assert.equal(mentions, 1, "only the note distinguishing the two concepts may say 'sphere'");
    assert.match(read("packages/contracts/src/portalActions.ts"), /sphere/i, "the SBTi framework still owns the term");
  });

  it("says an empty plan is empty rather than showing a zeroed summary", () => {
    assert.match(area, /summary\.total === 0/);
    assert.match(area, /This client has no reduction plan yet/);
  });

  /* ── Phase 2: SRS alignment and the report flag ──────────────────────────────────── */

  const alignment = read("packages/isolated-backend/migrations/0081_strategy_srs_alignment.sql");

  it("holds 'at least one requirement' in the database, not only in the form", () => {
    // A CHECK cannot span tables and an immediate trigger fires before the alignment rows
    // exist, so the rule is a deferred constraint trigger: the transaction is judged as a
    // whole, at commit, when both halves are present.
    assert.match(alignment, /CREATE CONSTRAINT TRIGGER client_strategy_alignment_required/);
    assert.match(alignment, /DEFERRABLE INITIALLY DEFERRED/);
    // Deactivated strategies are exempt — the rule is about a plan, and a removed strategy
    // has left the plan while staying on the record.
    assert.match(alignment, /client_strategy_requires_alignment/);
  });

  it("refuses an unaligned strategy at the command as well", () => {
    // The database rule is the guarantee; the command rule is what makes the refusal
    // legible. A person who hits only the trigger gets a constraint name, not a sentence.
    for (const key of ["client.strategy.assign", "client.strategy.update"]) {
      assert.match(commands, new RegExp(`"${key}": \\{.*srsRequirementIds: string\\[\\]`), key);
    }
    assert.match(commands, /Align this strategy to at least one UK SRS requirement\./);
    // And the backend refuses ids the framework does not know, rather than writing nothing
    // and reporting success.
    assert.match(backend, /UNKNOWN_REQUIREMENT/);
    assert.match(backend, /setStrategyAlignment/);
  });

  it("offers the requirements grouped by pillar, not as one list of forty-eight", () => {
    assert.match(forms, /requirementsByPillar\(framework\)/);
    assert.match(read("packages/contracts/src/srsReadiness.ts"), /export function requirementsByPillar/);
    // Both add paths and the edit path carry an alignment, and none can be submitted without
    // one.
    assert.match(forms, /srsRequirementIds\.length === 0 \? "Align this strategy to at least one UK SRS requirement\."/);
    // No framework means nothing to align to — said, rather than shown as a dead form.
    assert.match(forms, /No UK SRS framework is published for this organisation yet/);
  });

  it("shows the codes, never the generated ids", () => {
    assert.match(area, /codes\.get\(id\)/);
    assert.match(forms, /nz-tag srs/);
    // A requirement retired from the framework has no code to print, so the chip is dropped
    // rather than rendered as a raw id.
    assert.match(area, /code is string/);
  });

  it("makes the report flag a live field that a report freezes, not a live read", () => {
    assert.match(alignment, /include_in_report boolean NOT NULL DEFAULT true/);
    assert.match(commands, /"client\.strategy\.update": \{.*includeInReport: boolean/);
    // One flag, two surfaces, and the copy says which is live and which is frozen: the
    // portal plan updates on the client's next load, the report keeps what it was issued
    // with. A consultant clearing this must know it reaches the portal too.
    assert.match(forms, /Show this to the client/);
    assert.match(forms, /their portal plan, which updates live/);
    assert.match(forms, /reports issued from\s+now on/);
    // The plan section of an issued report is composed at issue and frozen with everything
    // else — so a strategy held back next week does not vanish from a report already sent.
    const compositions = read("packages/isolated-backend/src/reportCompositions.ts");
    assert.match(compositions, /composeReportPlan\(strategies, levers, requirementCodes\)/);
    assert.match(read("packages/contracts/src/reportComposition.ts"), /strategy\.includeInReport/);
  });

  it("makes a library add confirm its alignment rather than inherit it silently", () => {
    // Alignment's worth is that someone judged it. A default applied without a look produces
    // nominal alignments nobody stands behind, which is worse than none — it reads as
    // consideration. Pre-filled from the catalogue, so agreeing is one click, but a click.
    assert.match(forms, /startAdd\(entry\)/);
    assert.match(forms, /setSelected\(defaults\(entry\)\)/);
    assert.match(forms, /Confirm what this advances for/);
    // The posted alignment is what the person confirmed, not what the catalogue said.
    assert.match(forms, /srsRequirementIds: selected/);
    assert.doesNotMatch(forms, /srsRequirementIds: defaults\(entry\)/);
    // And a change away from the catalogue's default is visible as a change.
    assert.match(forms, /Changed from the catalogue&rsquo;s alignment for this client\./);
  });

  it("says on the plan itself what the client will not be shown", () => {
    // Otherwise the only place the omission is visible is the client's own surface, which is
    // the one place it is too late to notice. Worded for both surfaces now that the flag
    // gates the live portal plan as well as the report.
    assert.match(area, /held back from the client/);
    assert.match(area, /absent\s+from their portal plan and from reports issued from now on/);
    assert.match(area, /not shown to client/);
    assert.doesNotMatch(area, /not in report</, "the tag no longer understates what the flag hides");
  });
});

/**
 * Phase 3a — deadline signals. Derived at read time from the date the client set: nothing
 * is recorded, nothing is sent, and no date is invented. The sending half (the outbox
 * drainer and the log that makes it idempotent) is 3b and deliberately absent here.
 */
describe("strategy deadline signals", () => {
  const contract = read("packages/contracts/src/reductionStrategies.ts");
  const area = read("apps/console/app/clients/[clientId]/ReductionStrategiesArea.tsx");
  const portal = read("apps/console/app/portal/PortalReductionPlan.tsx");
  const portalModel = read("packages/isolated-backend/src/portalStrategies.ts");
  const portalRoute = read("apps/console/app/api/portal/strategies/route.ts");

  it("derives one answer that every surface reads", () => {
    // Staff console, client portal and (in 3b) the reminder worker must not be able to
    // disagree about whether something is overdue.
    assert.match(contract, /export function strategyDeadline\(/);
    assert.match(area, /strategyDeadlineSignals\(plan, today\)/);
    assert.match(portalModel, /strategyDeadlineSignals\(plan, input\.today\)/);
  });

  it("invents no date and raises nothing without one", () => {
    assert.match(contract, /if \(targetDate === null \|\| targetDate === ""\) return \{ state: "none" \}/);
    // A complete strategy's date is when it happened, not a deadline.
    assert.match(contract, /strategy\.status === "complete"\) return \{ state: "none" \}/);
    // And an unreadable date is not silently treated as today.
    assert.match(contract, /if \(days === null\) return \{ state: "none" \}/);
  });

  it("stores nothing — the signal stays a derivation", () => {
    // 3b added strategy_automation_log for *sends*. The read-time signal still records
    // nothing: what the console and the portal show is derived from the date the client
    // set, so a surface that started writing would have quietly become a second source of
    // truth about what is overdue.
    for (const source of [area, portal, portalModel]) {
      for (const verb of ["INSERT", "UPDATE ", "postBrowserCommand", "patchBrowserCommand"]) {
        assert.ok(!source.includes(verb), `a read-time signal must not write (${verb})`);
      }
    }
    // And neither surface reads the send log: a reminder having gone out is not the same
    // fact as a date having passed, and showing one for the other would be a lie on a slow
    // clock.
    for (const source of [area, portal, portalModel]) {
      assert.ok(!source.includes("strategy_automation_log"), "the signal does not depend on what was sent");
    }
  });

  it("takes today from the server, never the reader's clock", () => {
    // A client's device clock must not get to decide whether their own plan is overdue,
    // and a client component calling new Date() would also differ across hydration.
    assert.match(portalRoute, /timeZone: "Europe\/London"/);
    assert.doesNotMatch(portal, /new Date\(\)/);
    assert.doesNotMatch(area, /new Date\(\)/);
    assert.match(area, /today: string;/);
  });

  it("keeps the portal read-only and session-scoped", () => {
    assert.match(portalRoute, /user\.clientId/);
    assert.doesNotMatch(portalRoute, /params|searchParams/);
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      assert.doesNotMatch(portalRoute, new RegExp(`export async function ${method}\b`), method);
    }
    assert.match(portalRoute, /withTenantRead/);
  });

  it("shows the client only what the report would show them", () => {
    // include_in_report is the consultant's control over what this client is presented
    // with; a strategy held back may be unagreed or sensitive, so the portal fails closed.
    assert.match(portalModel, /strategy\.active && strategy\.includeInReport/);
  });

  it("distinguishes loading, failed and nothing-due in the portal", () => {
    // "We could not load your plan" and "nothing is due" look identical as an empty panel
    // and mean opposite things.
    assert.match(portal, /nz-portal-state failed/);
    assert.match(portal, /nz-portal-state loading/);
    // The deadlines panel still appears only when something is actually due — it is a
    // warning, and a warning that fires on good news is noise. What changed is what sits
    // below it: the plan itself now renders whether or not anything is due, so "nothing due"
    // is no longer the same as "nothing to show".
    assert.match(portal, /model\.highlights\.length>0\?<section/);
    assert.match(portal, /Your reduction plan is being built with your consultant/,
      "and no plan at all is stated, not left blank");
  });

  it("uses the danger token, not Scope 1's coral", () => {
    // --s1 / --coral carry Scope 1 identity. Overdue is a state, not a measurement, and
    // the two resolving to the same colour today is exactly why the token must be right.
    const css = read("packages/ui/src/styles.css");
    const block = /\.nz-deadline\.late\{[^}]*\}/.exec(css)?.[0] ?? "";
    assert.match(block, /var\(--danger\)/);
    assert.ok(!block.includes("--coral") && !block.includes("--s1") && !block.includes("#FF5C48"));
  });

  it("documents the window where the cadence is configured", () => {
    assert.match(contract, /export const strategyReminderWindowDays = 30/);
    assert.match(read("docs/DEPLOYMENT.md"), /strategyReminderWindowDays/);
  });
});

/**
 * Phase 3b — the email channel. The properties that matter are about what CANNOT happen:
 * staging cannot mail a real client, the clock cannot double-send, and the standing outbox
 * backlog cannot become email.
 */
describe("strategy deadline email", () => {
  const worker = read("packages/isolated-backend/src/strategyReminderWorker.ts");
  const mailer = read("packages/isolated-backend/src/mailer.ts");
  const migration = read("packages/isolated-backend/migrations/0083_strategy_automation_log.sql");
  const render = read("render.yaml");

  it("claims before it sends, so a crash cannot double-send", () => {
    // A log row written after a successful send cannot prevent a duplicate: the crash that
    // loses it happens in the window between the send and the write.
    assert.match(migration, /CREATE UNIQUE INDEX strategy_automation_log_once_idx/);
    assert.match(migration, /client_strategy_id, kind, target_date, recipient_email/);
    assert.match(worker, /ON CONFLICT \(organisation_id, client_strategy_id, kind, target_date, recipient_email\) DO NOTHING/);
    // The claim is taken, then the outbox row is enqueued — never the other way round.
    // Bounded by the next declaration: the function's own parameter type closes with a
    // brace in column 0, so matching to the first of those stops inside the signature.
    const scan = /export async function scanClientReminders[\s\S]*?async function listReminderContacts/.exec(worker)?.[0] ?? "";
    assert.ok(scan.length > 0, "the scan function is found");
    assert.ok(scan.indexOf("strategy_automation_log") < scan.indexOf("transactional_outbox"));
  });

  it("cannot turn the 0001 outbox backlog into email", () => {
    // Every command has written an outbox row since the first migration and nothing has
    // ever drained one. Safety is by construction: no handler, no mail.
    assert.match(worker, /if \(row\.topic !== REMINDER_TOPIC\)/);
    assert.match(worker, /state='skipped'/);
    // 'skipped', not 'sent' — the audit trail must not claim a delivery that never happened.
    assert.match(migration, /CHECK \(state IN \('pending','processing','sent','skipped','failed'\)\)/);
  });

  it("fails closed on three independent conditions", () => {
    assert.match(mailer, /boundaryToken === "isolated-non-production"/);
    assert.match(mailer, /appEnv !== "production"/);
    assert.match(mailer, /mailMode !== "send"/);
    // The boundary is read first, so nothing else can override the isolation rule.
    assert.ok(mailer.indexOf("isolated-non-production") < mailer.indexOf('appEnv !== "production"'));
  });

  it("never writes a secret down", () => {
    // Not in code, not in comments, not in the deployment file.
    for (const source of [mailer, worker, render, read("packages/isolated-backend/src/smtpMailer.ts")]) {
      assert.ok(!/smtp\.office365\.com/i.test(source), "no host value is hardcoded");
      assert.ok(!/SMTP_PASS\s*=\s*["'][^"']+["']/.test(source), "no password literal");
    }
    // Every SMTP variable is dashboard-supplied rather than committed.
    for (const key of ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"]) {
      assert.match(render, new RegExp(`- key: ${key}\\s+sync: false`), key);
    }
    // And a configuration error names the variable without echoing any value.
    assert.match(mailer, /Missing SMTP configuration: \$\{missing\.join/);
  });

  it("leaves the send switch off in the deployed worker", () => {
    // NZI_MAIL_MODE is absent rather than set false-y: adding it is the one edit that could
    // put mail on the wire from this service.
    assert.match(render, /type: worker/);
    assert.match(render, /name: nzi-console-reminders/);
    assert.doesNotMatch(render, /^\s+- key: NZI_MAIL_MODE/m);
    assert.match(render, /NZI_DATABASE_BOUNDARY\s*\n\s*value: isolated-non-production/);
  });

  it("re-derives against live state before sending", () => {
    // The gap between the scan and the send is where a client gets told they are late for
    // something they finished.
    assert.match(worker, /the strategy is no longer on the plan/);
    assert.match(worker, /the target date has moved/);
    assert.match(worker, /no longer has a deadline to raise/);
  });

  it("holds on absent consent rather than assuming it", () => {
    assert.match(migration, /email_consent text NOT NULL DEFAULT 'unknown'/);
    assert.match(read("packages/contracts/src/strategyReminders.ts"), /contact\.emailConsent !== "granted"\) continue/);
  });

  it("runs as the worker role, which cannot edit a plan", () => {
    // A worker running as nzi_console_app could change a client's plan while reminding
    // them about it.
    assert.match(read("packages/isolated-backend/src/postgres.ts"), /withTenantWorker/);
    assert.match(migration, /GRANT SELECT ON nzi_console\.client_strategies TO nzi_console_worker/);
    assert.doesNotMatch(migration, /GRANT[^;]*(INSERT|UPDATE|DELETE)[^;]*ON nzi_console\.client_strategies TO nzi_console_worker/);
  });
});

/**
 * The strategy drawers follow the side-panel anatomy of the job scope-row panel
 * (DESIGN_CONVENTIONS §3.4). Found on staging: with the SRS pillars open the body overflowed
 * with no scroll, and "Add to plan" became unreachable.
 */
describe("strategy drawers follow the side-panel anatomy", () => {
  const forms = read("apps/console/app/clients/[clientId]/StrategyForms.tsx");
  const area = read("apps/console/app/clients/[clientId]/ReductionStrategiesArea.tsx");
  const css = read("packages/ui/src/styles.css");
  const conventions = read("docs/DESIGN_CONVENTIONS.md");
  const count = (source: string, needle: string) => source.split(needle).length - 1;

  it("keeps the primary action reachable: fixed header, scrolling body, pinned footer", () => {
    // Four views — the library list, its confirm step, bespoke, edit — each with exactly one
    // header, one scrollable body and one pinned footer.
    assert.equal(count(forms, 'className="nz-db"'), 4, "every drawer view has a scrollable body");
    assert.equal(count(forms, 'className="nz-df"'), 4, "and a pinned footer");
    assert.equal(count(forms, "<DrawerHeader "), 4, "and the fixed eyebrow + title + subtitle header");
    // The old single block that could not scroll is gone.
    assert.ok(!forms.includes("nz-drawer-form"), "no non-scrolling form wrapper");
    assert.ok(!forms.includes("nz-drawer-actions"), "no in-body action row that scrolls away");
    // The body is the scroll region and the footer is outside it.
    assert.ok(css.includes(".nz-db{padding:16px 20px;overflow-y:auto;flex:1"), "the body scrolls");
  });

  it("shows an action's error next to the action", () => {
    assert.equal(count(forms, "<FooterError error={error} />"), 4);
    assert.ok(css.includes(".nz-df>.nz-banner{flex:1 0 100%;margin:0}"));
  });

  it("collapses the SRS pillars by default with the shared chevron", () => {
    assert.ok(forms.includes("<Collapsible key={group.pillar.key}"), "pillars are @nzi/ui Collapsible sections");
    assert.ok(forms.includes("count={`${count} of ${group.requirements.length}`}"), "the header says where the selections are");
    // Collapsible is collapsed unless told otherwise, and the picker no longer opens them all.
    assert.ok(!forms.includes("defaultOpen"), "nothing opens a pillar by default");
    assert.ok(!forms.includes("new Set(groups.map"), "no all-open initial state");
  });

  it("never uses a tick as a section affordance", () => {
    // A check means selected or complete; an open section is neither.
    for (const [name, source] of [["StrategyForms", forms], ["ReductionStrategiesArea", area]] as const) {
      assert.ok(!source.includes('name="check"'), `${name} renders no check glyph`);
    }
    assert.ok(!css.includes("nz-srs-chev"), "the hand-rolled pillar chevron is gone");
  });

  it("puts the lever chevron on the left and rotates it like Collapsible", () => {
    const head = area.slice(area.indexOf('className="nz-lever-head"'), area.indexOf("</button>", area.indexOf('className="nz-lever-head"')));
    assert.ok(head.indexOf("nz-lever-chev") > -1 && head.indexOf("nz-lever-chev") < head.indexOf("nz-lever-icon"), "chevron comes first");
    assert.ok(head.includes('d="M9 6l6 6-6 6"'), "the same glyph as .nz-collapsible-chev");
    assert.ok(css.includes(".nz-lever.collapsed .nz-lever-chev{transform:none}"), "points right when closed");
  });

  it("records the convention so it cannot recur", () => {
    assert.ok(conventions.includes("### 3.4 Drawer / side-panel (locked)"));
    assert.ok(conventions.includes("Canonical example: the job scope-row panel"));
    assert.ok(conventions.includes("Never a tick or check as a section affordance."));
    assert.ok(conventions.includes("never scrolls out of view"));
  });
});

/**
 * The client-facing plan view on the portal. Read-only, live, and carrying nothing the
 * client should not see.
 */
describe("the portal plan view", () => {
  const portal = read("apps/console/app/portal/PortalReductionPlan.tsx");
  const model = read("packages/isolated-backend/src/portalStrategies.ts");
  const route = read("apps/console/app/api/portal/strategies/route.ts");
  const home = read("apps/console/app/portal/PortalHome.tsx");

  it("is read-only — there is no way to change the plan from the portal", () => {
    // The plan is agreed with the consultant; a portal write would fork one plan into two.
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      assert.doesNotMatch(route, new RegExp(`export async function ${method}\b`), method);
    }
    for (const verb of ["postBrowserCommand", "patchBrowserCommand", "INSERT", "UPDATE "]) {
      assert.ok(!portal.includes(verb), `the view must not write (${verb})`);
      assert.ok(!model.includes(verb), `nor the read model (${verb})`);
    }
    assert.ok(!portal.includes("<button"), "and offers no control that implies it could");
  });

  it("resolves live rather than from a frozen composition", () => {
    // A plan is not a measurement: the published-snapshot rule does not apply, and a stale
    // deadline is worse than a live one.
    assert.match(model, /listClientStrategies\(db, input\.clientId\)/);
    // Asserted against what it calls and queries, not against the prose above it — the
    // comment explaining the exemption naturally names the thing being ruled out.
    assert.ok(!model.includes("getReportComposition"), "never reads a frozen composition");
    assert.doesNotMatch(model, /FROM nzi_console\.report_compositions/);
    assert.match(portal, /cache:"no-store"/);
  });

  it("applies the one client-facing gate and no second flag", () => {
    assert.match(model, /strategy\.active && strategy\.includeInReport/);
    // One flag, one meaning. A portal-only visibility flag would let the two surfaces
    // disagree about what the client was told.
    assert.ok(!model.includes("includeInPortal"), "no portal-only visibility flag");
    assert.ok(!model.includes("show_on_portal"));
  });

  it("keeps the internal fields off the wire entirely", () => {
    // The shapes themselves, not the prose around them: neither type declares the field, so
    // there is nothing to serialise even by accident.
    for (const shape of ["PortalStrategyHighlight", "PortalPlanStrategy"]) {
      const block = new RegExp(`export type ${shape} = \\{[\\s\\S]*?\\n\\};`).exec(model)?.[0] ?? "";
      assert.ok(block.length > 0, `${shape} is declared`);
      assert.doesNotMatch(block, /^\s*owner\??:/m, `${shape} carries no owner`);
      assert.doesNotMatch(block, /^\s*notes\??:/m, `${shape} carries no notes`);
    }
    assert.doesNotMatch(portal, /\.owner/, "and the view never reaches for it");
    assert.doesNotMatch(portal, /\.notes/, "nor the consultant's working notes");
  });

  it("states an empty plan rather than drawing an empty list", () => {
    assert.match(portal, /Your reduction plan is being built with your consultant/);
    assert.match(portal, /model\.total===0\)return/);
  });

  it("shows a date only when one was set", () => {
    assert.match(portal, /strategy\.targetDate!==null\?/);
    assert.match(portal, /formatDate\(strategy\.targetDate\)/, "dd/mm/yyyy through the shared formatter");
    assert.doesNotMatch(portal, /new Date\(\)/, "and never the reader's clock");
  });

  it("groups by lever with the shared collapsible, not a bespoke one", () => {
    assert.match(portal, /import \{Collapsible\} from "@nzi\/ui"/);
    assert.match(model, /strategyPlanByLever\(plan, levers\)/);
    assert.match(model, /strategiesWithoutLever\(plan, levers\)/);
    assert.match(model, /label: "Other"/);
  });

  it("is theme-aware — the portal follows the viewer, unlike the report", () => {
    const css = read("packages/ui/src/styles.css");
    const block = /\.nz-portal-plan\{[\s\S]*?\.nz-portal-plan-srs ul\{[^}]*\}/.exec(css)?.[0] ?? "";
    assert.ok(block.length > 0, "the plan styles exist");
    assert.doesNotMatch(block, /#[0-9A-Fa-f]{6}/, "no hard-coded colour — tokens only");
    assert.match(block, /var\(--/);
  });

  it("sits on the portal home, above the portfolio", () => {
    assert.match(home, /<PortalReductionPlan\/>/);
    assert.match(home, /import \{PortalReductionPlan\}/);
  });
});
