# NZI Console — deployment record

Isolated staging environment for the redesigned NZI Pro front-end. **Additive only** — separate repo,
service and (future) database. Does not touch the live NZI Pro platform, its production database, or the
FuelCap services.

## Render service (verified 25 August 2026)

- **Service name:** `nzi-console`
- **Service ID:** `srv-d6o8snvgi27c73frfta0`
- **Type / plan:** Web Service · Node · Starter
- **Repo / branch:** `francis-nzi/nzi-console` · `main`
- **Root Directory:** blank (repo root — required so `@nzi/ui` / `@nzi/mock-data` resolve)
- **Build command:** `npm install && npm run build -w @nzi/console`
- **Start command:** `npm run start -w @nzi/console`
- **Health check path:** `/api/health`
- **Auto-Deploy:** on commit to `main`
- **Public URL:** `https://nzi-pro-api-prod.onrender.com`
- **Latest accepted implementation commit:** `d49eb7d` — "Prove complete CRP workflow lifecycle"

## Environment variables

| Key | Value |
|---|---|
| `NODE_VERSION` | `20.18.0` |
| `NEXT_PUBLIC_APP_ENV` | `staging` |
| `NZI_DATA_MODE` | `isolated-api` |
| `NZI_DATABASE_BOUNDARY` | `isolated-non-production` |
| `NZI_DEMO_ORGANISATION_ID` | `demo-nzi-console` |
| `NZI_ISOLATED_API_URL` | `https://nzi-pro-api-prod.onrender.com` |
| `NZI_ISOLATED_DATABASE_URL` | Secret non-production Supabase session-pooler URL; Render only |
| `NZI_PORTAL_AUTH_ENABLED` | Set to `true` when independent client portal sign-in is enabled |
| `NZI_PORTAL_SESSION_SECRET` | Dedicated random secret of at least 32 bytes; never reuse the staff session secret |
| `NZI_PORTAL_IDLE_LIMIT_MINUTES` | Optional. Idle auto-logout window for portal sessions (server-enforced); default `30`. The client warning countdown reads this via `/api/portal/auth/me`. |
| `NZI_PORTAL_TERMS_VERSION` | Optional. Current portal terms-of-access version; default `2026-v1`. `resolvePortalPrincipal` flags `mustAcceptTerms` until an acceptance row for this version exists — **bump this string to re-prompt every existing portal user** (update `portalTermsContent.ts` copy at the same time). Set to empty only to disable the gate. |
| `NEXT_PUBLIC_FEATURE_PORTAL` | Comma-separated portal Phase 2 UI flags (`portal-analytics`, `portal-actions`). Build-time inlined, dashboard-authoritative — a flip is a dashboard edit + **Clear build cache & deploy**. `portal-actions` is the A2-lite qualitative tracker and depends on `portal-analytics` for its assured baseline context. Unset = every portal analytics surface OFF. |
| `NZI_TRAINEE_AUTH_ENABLED` | Set to `true` when the trainee portal (the third identity realm) is enabled. Unset = the realm returns 503 and its pages are unreachable. |
| `NZI_TRAINEE_SESSION_SECRET` | Dedicated random secret of at least 32 bytes. **Never reuse the staff or portal session secret** — the realms are separated by cookie *and* secret, and the middleware also checks the session's `principal`, so a shared secret would still not cross realms; it would just remove one of the two walls. |
| `NZI_TRAINEE_IDLE_LIMIT_MINUTES` | Optional. Idle auto-logout window for trainee sessions (server-enforced); default `30`. |
| `NZI_TRAINEE_CONSENT_VERSION` | Optional. The consent wording currently in force; default `2026-09`. Stamped alongside a trainee's answer so a recorded consent always says what was agreed to — **bump this when the wording changes**, so old answers stay attached to the text they were given. |
| `NEXT_PUBLIC_FEATURE_JOB_MODULES` | Comma-separated job-family module flags (`job-module-lca`, `job-module-training`). Own variable, parallel to the data-entry and report flag sets, flipped the same way (dashboard edit + **Clear build cache & deploy**). Unset = every module OFF and `FamilyWorkspace` serves that family. |
| `NZI_VERIFY_RATE_SALT` | Random secret used to key the public verify endpoint's per-caller rate limit. Bucket keys are `sha256(salt:address)` so the counter works **without storing anyone's IP address**; an unsalted hash would be reversible, IPv4 being a small space. Changing it resets every live window (harmless). Unset = an empty salt, which still limits but no longer protects the addresses — set it. |
| `NZI_TRUSTED_PROXY_HOPS` | Optional. How many of **our own** proxies sit in front of the app; default `1` (Render's load balancer). The real client is that many entries from the right of `X-Forwarded-For`, because each proxy *appends* what it saw and the leftmost entry is whatever the client chose to send. Raise this only if a proxy is added in front — setting it too high keys on a client-supplied value, too low collapses every caller into one bucket. |
| `NZI_AUTH_ENABLED` | `true` |
| `NZI_AUTH_REQUIRED` | `true` |
| `NZI_CONSOLE_SESSION_SECRET` | Dedicated Render-only secret |
| `NZI_CONSOLE_MFA_ENCRYPTION_KEY` | Dedicated Render-only secret |
| `NZI_WRITE_API_ENABLED` | Explicit independent gate for authenticated command routes |
| `NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2` | Comma-separated list of enabled data-entry / workspace UI flags (`spend`, `spend-import`, `portal-spend`, `commuting`, `vehicle`, `client-factors`, `data-entry-accordion`, `job-stage-sections`, …). Unset = every flag OFF, generic path is default. Per-flag rollout gate — see `docs/REDESIGN_ROLLOUT.md`; do not enable a flag until it has passed its rendered acceptance. **`NEXT_PUBLIC_*` is inlined at `next build`, and this service's value is currently set in the Render dashboard (not synced from `render.yaml`) — so a flip is a dashboard edit + rebuild. See "Feature-flag flips" below.** |
| `NEXT_PUBLIC_FEATURE_REPORT_STUDIO` | Comma-separated list of enabled Report Studio (R-track) UI flags (`report-svg-charts`, later `report-sections`, `report-tokens`, `report-edit`, `report-paged`). Own variable, parallel to `NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2` and flipped the same way (dashboard edit + rebuild). Unset = the current report path. See `docs/REPORT_PRINTING_UX.md` and the per-slice acceptance docs. |
| `DVLA_VES_API_KEY` | Optional. DVLA Vehicle Enquiry Service key for the UX1 registration lookup (`/api/*/jobs/{id}/vehicle-lookup`). **Unset on isolated staging** — with `NEXT_PUBLIC_APP_ENV=staging` the service returns a deterministic stub vehicle so the two-step flow is exercisable without a real key or plate. The registration is transient: never persisted, never logged. |

Clients, Jobs, and individual Job workspace screens use the isolated Supabase schema and expose
authenticated client/job creation plus versioned job-stage transitions through the transactional command
boundary. The independent client portal also uses the isolated boundary for enrolment, sessions, grants,
published reports, collaboration, deliverables, and constrained data entry. CRP jobs read and edit canonical
`job_scope_rows`; `J000712` uses an explicit fictional evidence seed and newly created CRP jobs begin in a
truthful empty state. Other staff workspaces remain on synthetic `@nzi/mock-data` fixtures. The service retains unrelated legacy environment variables from its earlier
use; the Console boundary ignores generic `DATABASE_URL` and accepts only `NZI_ISOLATED_DATABASE_URL`.

## Feature-flag flips (`NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2`)

**The Render dashboard value is authoritative on this service, not `render.yaml`.** The env var was edited
manually in the dashboard during an earlier rollout, and Render then stops syncing that key from the
blueprint. `render.yaml` is kept in step **for continuity only** — merging a `render.yaml` change **does
nothing to the running build**.

`NEXT_PUBLIC_*` values are **inlined into the client bundle at `next build`**, and several flag-gated
surfaces (`CrpScopeWorkspace`, the accordion, `CrpStageSections`, `ClientFactorPanel`) are client
components — so a flip is not a restart, it is a **rebuild**.

**To flip a UI flag ON:**

1. In the Render dashboard for `nzi-console` (`srv-d6o8snvgi27c73frfta0`) → Environment, **append** the new
   token to `NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2` (keep the existing tokens; comma-separated, no spaces).
2. Save — Render triggers a rebuild + deploy. Confirm `/api/health` is green and the surface renders.
3. In the **same PR that added the flag**, append the token to `render.yaml`'s value too (continuity), so
   the two never diverge in intent.
4. Roll back = remove the token from the dashboard value + rebuild. Flag-gated UI is additive; the legacy
   path returns.

Current dashboard value (3 Sep 2026):
`spend,spend-import,portal-spend,commuting,vehicle,client-factors,data-entry-accordion,job-stage-sections`
— `job-stage-sections` (UX1e-1) was appended and the rebuild is live; acceptance recorded in
`docs/STAGING_ACCEPTANCE_UX1E.md`. `render.yaml` carries the same token set for continuity.

**Longer-term fix:** blueprint-link the service (Render dashboard → the service → "Link to Blueprint", or
recreate it from `render.yaml`) so `render.yaml` becomes authoritative and env changes ship as reviewed
commits. Until then, every `NEXT_PUBLIC_*` flip is the manual dashboard step above.

**Other flag variables.** The Report Studio (R-track) slices use their own build-inlined variable
`NEXT_PUBLIC_FEATURE_REPORT_STUDIO` (tokens: `report-svg-charts`, …) — same dashboard-edit-plus-rebuild
procedure as above. Current dashboard value (3 Sep 2026): `report-svg-charts` (R1, live;
`docs/STAGING_ACCEPTANCE_R1.md`).

Job-family modules (Track C, NZC-024) use a third variable, `NEXT_PUBLIC_FEATURE_JOB_MODULES` (tokens:
`job-module-lca`, …), same procedure. **Flipped 5 Sep 2026** — `job-module-lca` is set on the dashboard and
the rebuild is live; the three LCA e2e specs (`lca-inventory` / `lca-transport-legs` / `lca-calc-review`)
were un-skipped in the flip PR and are now hard preconditions. Staging seed: jobs `714` (Verdant Foods, lca)
and `715` (Quaymed Devices, pcf) carry a full worked example — Model Register → inventory → transport legs
(with the live freight shortlist) → calc-ready factors (`packages/isolated-backend/seeds/0005`–`0008`).
`render.yaml` carries the value for continuity. Roll back = remove the token from the dashboard value +
rebuild; `lca`/`pcf` jobs return to `FamilyWorkspace`, no data change.

## ⚠️ Notes / follow-ups

- **Public URL is misleadingly named** `nzi-pro-api-prod.onrender.com` — this is a **staging redesign UI with
  an isolated non-production data boundary**, not a production API. Before anyone bookmarks or references it: confirm this service was not
  previously serving a real NZI Pro API, and that nothing else points at that URL. The `.onrender.com`
  subdomain is fixed at service creation and can't be changed by renaming; for a clean name, create a fresh
  service (`nzi-console.onrender.com`) or attach a custom domain (`console.netzero.international`).
- `NEXT_PUBLIC_APP_ENV=staging` is the authoritative in-app signal that this is not production.
- Browser-side Supabase keys are not used; database access is server-only through the dedicated
  non-production session pooler.

## Reduction-strategy deadline signals (phase 3a)

Approaching/overdue strategy dates are **derived at read time** and shown in the staff console and the
client portal. Nothing is stored, nothing is sent, and no date is invented — a strategy with no
`target_date` raises nothing, and a completed strategy raises nothing.

| Setting | Where | Value |
|---|---|---|
| Reminder window | `strategyReminderWindowDays` in `@nzi/contracts/reductionStrategies` | `30` days |
| "Today" | resolved server-side, `Europe/London` calendar date | client workspace page; `/api/portal/strategies` |

The window is a code constant rather than an environment variable **on purpose**: it changes what a
client is told, so it belongs in a reviewed commit, not a dashboard field. Changing it is a one-line
edit plus the usual PR.

"Today" is London, not UTC — overdue turns over at UK midnight — and is resolved on the server so a
client's device clock cannot decide whether their own plan is late.

## Reminder worker and email (phase 3b)

A second Render service, `nzi-console-reminders` (`type: worker`), drains
`nzi_console.transactional_outbox` on a clock and sends deadline reminders.

### This service sends nothing, by design

`mailDelivery()` requires **all three** of the following, and the default of every one of them is
silence:

| Condition | On `nzi-console-reminders` | Effect |
|---|---|---|
| `NZI_DATABASE_BOUNDARY` ≠ `isolated-non-production` | it **is** isolated | suppress |
| `NEXT_PUBLIC_APP_ENV` = `production` | `staging` | suppress |
| `NZI_MAIL_MODE` = `send` (exact string) | unset | suppress |

The boundary token is checked first, so **no combination of the other two can make this service email
a real client**. `NZI_MAIL_MODE` is deliberately absent from `render.yaml` rather than set to a false-y
value: adding it is the single edit that could put mail on the wire, and it must never be made here.

Suppressed is a *successful* outcome, not a skipped one: the message is composed in full, written to
`strategy_automation_log` with `state='suppressed'`, and logged. "We would have sent this" stays
inspectable.

### Idempotency

`strategy_automation_log` is claimed **before** a send is attempted, never written after one succeeds —
a row written afterwards cannot stop a duplicate, because the crash that loses it happens between the
send and the write. The unique index on `(organisation_id, client_strategy_id, kind, target_date,
recipient_email)` is the guarantee:

- the clock can run as often as you like; a given reminder sends once
- a **moved** target date is a new deadline and earns a new reminder
- a transient SMTP failure retries (backoff, `MAX_SEND_ATTEMPTS = 4`) without duplicating a delivered
  message
- delivery status lives on the log row (`claimed` → `sent` | `suppressed` | `failed`, with `attempts`
  and `last_error`)

### The standing outbox backlog

`transactional_outbox` has been written by **every command since migration `0001`** and drained by
nothing, so it holds a long tail of `pending` rows. The drainer clears them without sending: delivery is
keyed on a handler lookup, and a topic no handler recognises is marked **`skipped`** — a new state added
in `0083`, because marking them `sent` would record deliveries that never happened. Nothing in that
backlog has a mail handler, so none of it can become email.

### SMTP (Office 365, matching live)

Read from the environment, never committed, never logged: `SMTP_HOST`, `SMTP_PORT` (default `587`),
`SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SMTP_TLS` (TLS is required unless the value is exactly `false`).
Each service supplies its own values in the Render dashboard. On this worker they may be left unset
entirely — the suppressing mailer is chosen before any transport is built.

### Consent

`client_contacts.email_consent` (`unknown` | `granted` | `declined`, default `unknown`) follows the
training model: **`unknown` holds**. Only `granted` is written to, so no contact receives mail until
someone has recorded that they may. Inactive contacts and duplicate addresses are excluded.

### Tick

`NZI_REMINDER_TICK_SECONDS` (default `900`) controls only how promptly a newly-due date is noticed, not
how often anyone is written to — the unique index is what stops a second send.

## Rollback / teardown

For an immediate application rollback, set `NZI_DATA_MODE=fixture` on service
`srv-d6o8snvgi27c73frfta0` and trigger a deploy. This disconnects the application from Postgres and returns
Clients and Jobs to bundled fixtures without deleting isolated data. Entire teardown remains additive.

## Migrations and deploys — the gate (NZC-077)

Schema and code must not ship apart. On **15 September 2026** they did: #176 merged, auto-deploy
shipped code that read the `0084` `client_contact_consent_events` table, `render.yaml` had no
migration step, and every client workspace returned **503** — over a consent card nobody was
looking at. Two independent faults, addressed separately: this section is the deploy gate; the
resilience half is in `DESIGN_CONVENTIONS` §11 (adjunct reads fail soft).

### Staging — auto-apply before cutover ✅ LIVE, and proven

**The gate is on, and it works.** It is configured in the **Render dashboard**, as the staging web
service's **Pre-Deploy Command**:

```
npm run migrate -w @nzi/isolated-backend
```

It proved itself on its first real job: migration `0085` (#182) was applied by the pre-deploy step
on deploy, confirmed in the deploy log. That is the whole point of NZC-077 — the migration that
closed the 15 September gap was the last one that had to be applied by hand.

> **The mechanism is the dashboard setting, not `render.yaml`.** The staging service is **not
> Blueprint-managed**, so Render does not read `render.yaml` for it and a `preDeployCommand` line
> there would have changed nothing while appearing to. The YAML below is **documentation and
> future-proofing for a Blueprint rebuild** — if the service is ever recreated from the blueprint,
> this is the line that carries the gate across. It is not the active mechanism today.
>
> **The corollary is worth knowing:** any other behaviour `render.yaml` claims to govern for this
> service — the feature-flag env vars among them, which the file's own comment calls "the single
> source of truth" — is equally not in force from the file. The dashboard is authoritative. That is
> a wider discrepancy than this section, and worth a pass of its own.

The YAML that would carry the gate across a Blueprint rebuild, for the **staging web service only**
(`nzi-console`). Nothing here touches the live service, which is not in this blueprint at all.

```diff
   - type: web
     name: nzi-console
     runtime: node
     region: frankfurt
     plan: starter
     branch: main
     # Build from the monorepo root so workspace packages (@nzi/ui, @nzi/mock-data) resolve.
     buildCommand: npm install && npm run build -w @nzi/console
+    # Apply pending migrations before the new release serves traffic (NZC-077).
+    #
+    # Fails closed by construction: Render runs this after the build and before cutover, and
+    # "if any command fails or times out, the entire deploy fails … your service continues
+    # running its most recent successful deploy, with zero downtime". So a migration that
+    # cannot complete leaves the PREVIOUS code serving the OLD schema — consistent — rather
+    # than new code against a database it does not match.
+    #
+    # Safe to run on every deploy: the runner is ledger-based and idempotent, applies pending
+    # files in order, and refuses gaps or a checksum mismatch. An up-to-date database is a no-op.
+    preDeployCommand: npm run migrate -w @nzi/isolated-backend
     startCommand: npm run start -w @nzi/console
```

**Two standing constraints — they apply to the dashboard setting too, not just the YAML.**

- A pre-deploy command **requires a paid instance type** — it is unavailable on Render's Free
  instance. `nzi-console` is on `starter`, so it qualifies. If the service is ever moved to Free,
  the step silently stops being available and **the gate goes with it**, without an error.
- The pre-deploy step runs with the **service's own environment**, so it uses the same
  `DATABASE_URL` and introduces no new secret. That is also why it can only ever migrate the
  database the service itself talks to.

**The worker (`nzi-console-reminders`) deliberately gets no gate.** Two services racing to apply
the same migrations is a worse failure than the one being fixed; the web service is the one that
owns the schema, and the worker follows it.

**Behaviour:**

| Case | Expected | Status |
|---|---|---|
| No pending migrations | Pre-deploy is a no-op; deploy proceeds | Seen on every deploy since |
| Pending migration applies cleanly | Applied before cutover; new code serves against current schema | **Proven — `0085` on #182** |
| Migration fails | **Deploy aborts.** Previous version keeps serving, on the schema it was written for | Not yet observed |

The failure path is the one still taken on trust: it rests on Render's documented contract that a
failed pre-deploy fails the whole deploy and leaves the previous version serving. Worth proving
once with a knowingly-bad migration on a throwaway branch, so the abort is something we have
watched rather than something we have read.

### Production — a hard check, never an auto-apply (prepared; wired at go-live)

Production takes the **opposite** posture, and deliberately. Staging is isolated and optimises for
velocity; a production schema change stays a human act, done knowingly, with someone watching.

The live service is **not configured by this work**. The procedure below is written down now and
wired to the live service **at go-live**, as its own reviewed step.

Production's pre-deploy runs the **status** command, not the apply:

```
npm run migrate:status -w @nzi/isolated-backend
```

`status` is read-only and exits non-zero when anything is pending, so the deploy **fails closed**
if the schema is behind — it refuses to cut over rather than applying anything itself.

**The go-live sequence for a migration-carrying release to production:**

1. **Apply the migration first**, deliberately: open the **Render Shell on the live service** and run
   `npm run migrate -w @nzi/isolated-backend`. Secrets stay in the service's environment — never
   pasted into a shell, a ticket or a chat.
2. **Confirm it landed**: `npm run migrate:status -w @nzi/isolated-backend` reports nothing pending.
3. **Deploy the code.** The hard check confirms the schema is current and cutover proceeds.

If step 1 is skipped, step 3 fails closed and the previous version keeps serving. That is the point:
the only way to ship code against a stale production schema is to defeat the check on purpose.

### Interim discipline — closed for staging, still the rule for production

**Staging no longer needs it.** The gate applies pending migrations on every deploy, so a
migration-carrying PR to staging can simply be merged. `0084` was the last one applied by hand;
`0085` was the first applied by the gate.

**Production still needs it, and always will** — by design, not by omission. There the pre-deploy
is a *check*, never an apply, so the sequence above (apply via the runner in the live Shell, confirm
`migrate:status` clean, then deploy) remains the procedure. Production schema changes stay a
deliberate human act.

Should the staging gate ever be lost — the service moved to a Free instance, or recreated without
the dashboard setting — the old discipline is the fallback:

```
npm run migrate:status -w @nzi/isolated-backend   # read-only: what is applied, what is pending
npm run migrate -w @nzi/isolated-backend          # applies it, in order, with the ledger
```

## Staff enrolment (0129)

How a real person gets sign-in to the console. Nobody but that person ever holds their password or their
authenticator secret — not the operator, not the database in the clear.

1. **They are on the roster.** `seed:reference-data` (in the Render Shell, with `NZI_DEMO_ORGANISATION_ID` set to the
   target organisation) creates each member at the least-privilege role, name and address sealed. Raising a role is
   a separate, audited act.
2. **Issue their link** in the Render Shell of the console service:

   ```
   npm run enrol:staff -w @nzi/isolated-backend -- <userId> --actor <your name> --base-url https://<console host>
   ```

   It prints a single-use link, valid for 72 hours, **once** — the token is stored only as a hash. Send it to the
   person privately. Issuing again revokes the previous link; `--revoke` withdraws it outright. Every issue and revoke
   is audited under `operator:<your name>`.
3. **They enrol** at `/enrol`: set their own password, add the key the page shows to their authenticator, and confirm
   a code. Only that confirmation writes their credential; five wrong codes end the link. They then sign in at `/login`.

The link carries its token in the URL fragment, so it never reaches a server log. Mail is suppressed on this service by
design (see *This service sends nothing*), which is why the operator delivers the link. Someone with Render Shell
access could use a link they issued — but that person already holds the database, and the audit trail and the
single-use link make it visible: the real person's link would no longer work.

**Not covered yet:** recovery for someone who already has working sign-in (a lost device). Enrolment refuses to
replace an enabled credential; recovery is its own, deliberate build.
