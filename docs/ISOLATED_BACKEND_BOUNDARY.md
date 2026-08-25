# Isolated backend boundary

Phase 3 preparation introduces interfaces and executable safety tests only. The deployed Console remains
in `NZI_DATA_MODE=fixture`, reports `isolation=no-database`, and holds no database credentials.

The future `isolated-api` mode requires an explicit non-production URL and is refused when the application
environment is `production`. Repository access always requires an organisation ID and keys every record by
`organisation_id + id`. Commands run in one transaction with optimistic versions, organisation-scoped
idempotency, an audit record and a transactional outbox event. Any thrown error rolls all four back.

Before introducing Postgres: provision a separate non-production project, add migration-owned tables and
composite tenant foreign keys, enable least-privilege RLS, then run the same two-tenant and forced-rollback
tests against that adapter. Production NZI Pro credentials and data are prohibited.

## Provisioning gate

Migrations `0001`, `0002`, and `0003` define the prepared schema, RLS boundary, and pooler-to-runtime-role
membership but are not executed by the web
service. A future migration job must receive only `NZI_ISOLATED_DATABASE_URL`, with
`NZI_DATABASE_BOUNDARY=isolated-non-production` and a non-production application environment. The guard
rejects missing confirmation and every production environment. Schema owners run migrations; the runtime
roles are `NOSUPERUSER`, `NOBYPASSRLS`, and cannot alter or delete audit history.
