# Isolated backend boundary

Phase 3 now includes a guarded Postgres read adapter and server-only `/api/isolated/clients` and
`/api/isolated/jobs` routes. The deployed staging Console now runs those two read paths in
`NZI_DATA_MODE=isolated-api` and reports `isolation=non-production-only`; other screens remain fixtures.

The `isolated-api` mode requires an explicit non-production URL and is refused when the application
environment is `production`. Repository access always requires an organisation ID and keys every record by
`organisation_id + id`. Commands run in one transaction with optimistic versions, organisation-scoped
idempotency, an audit record and a transactional outbox event. Any thrown error rolls all four back.

Before introducing Postgres: provision a separate non-production project, add migration-owned tables and
composite tenant foreign keys, enable least-privilege RLS, then run the same two-tenant and forced-rollback
tests against that adapter. Production NZI Pro credentials and data are prohibited.

## Provisioning gate

Migrations `0001`–`0007` define the schema, RLS boundary, pooler-to-runtime-role membership, constrained
client/job screen fields, staff roles, isolated authentication tables/role, and the credential-scoped membership lookup. They are not executed by the web
service. A future migration job must receive only `NZI_ISOLATED_DATABASE_URL`, with
`NZI_DATABASE_BOUNDARY=isolated-non-production` and a non-production application environment. The guard
rejects missing confirmation and every production environment. Schema owners run migrations; the runtime
roles are `NOSUPERUSER`, `NOBYPASSRLS`, and cannot alter or delete audit history.

## Read-path gate

The isolated routes require `NZI_DATA_MODE=isolated-api`, the database boundary variables above, and a
server-owned `NZI_DEMO_ORGANISATION_ID`. Tenant identity is never accepted from a browser header or query
parameter. Each request opens a read-only transaction, assumes `nzi_console_app`, sets the local tenant
context used by forced RLS, and releases the pooled connection after commit or rollback. The first read
models expose canonical stored fields only. Clients and Jobs now share a server-side fixture/API loader;
isolated mode renders those two list screens from the typed API.

The repeatable seed at `packages/isolated-backend/seeds/0001_synthetic_demo.sql` owns the fictional
`demo-nzi-console` tenant. It contains organisation, client, and cross-family job records only, reserves
the established `J000712`–`J000716` demonstrator range, uses only reserved `.invalid` contact addresses,
and advances the global allocator to `J000717`.
It is an explicit provisioning action and is never invoked by an application request or service startup.

## Write-path gate

The Postgres command executor supports typed client/job creation inside one tenant-scoped transaction.
It serialises each organisation/idempotency key, rejects reuse with a different request hash, allocates the
official job number in the caller transaction, and records the entity, audit event, outbox event, and stored
outcome atomically. A real Supabase rollback test proves `J000717` remains available after forced rollback.

The client/job command routes are deny-by-default. They require the explicit write feature flag, exact
same-origin POST, a valid signed and expiring `nzi_console_session` cookie, an active tenant membership,
and the named command permission for its role. Tenant and actor headers are never trusted as identity.
The Clients and Jobs screens now submit through these routes with browser-generated idempotency and
correlation IDs. Tenant, actor and permission identity still come only from the server session. The
feature flag remains independently controlled, so database and UI readiness never enable mutations.

## Staff authentication gate

Staff identity remains separate email/password plus TOTP MFA. Passwords use per-credential scrypt hashes;
TOTP secrets use AES-256-GCM with a dedicated Render-only encryption key. Password success creates a
single-use five-minute MFA challenge; MFA success creates an eight-hour revocable database session and a
signed `HttpOnly; Secure; SameSite=Strict` cookie. Five failed password attempts lock sign-in for 15 minutes.

Authentication activation is deliberately two-stage: `NZI_AUTH_ENABLED` permits login APIs, then
`NZI_AUTH_REQUIRED` protects pages/APIs. Both are enabled after an end-to-end administrator login test;
dedicated Render session/encryption secrets and the initial credential are provisioned. Legacy
`NZI_JWT_SECRET`, `MFA_ENCRYPTION_KEY`, and Microsoft variables are never read.
