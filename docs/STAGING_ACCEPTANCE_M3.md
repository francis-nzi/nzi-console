# M3 staff workspace staging acceptance record

**Environment:** isolated staging only

**URL:** `https://nzi-pro-api-prod.onrender.com`

**Accepted implementation revision:** `cb3a532`

**Recorded:** 28 August 2026

## Accepted scope

The canonical Clients, Jobs, Reports, Datasets, and Platform workspaces now read tenant-bound records through the isolated API. They cover client relationships and sites, cross-family engagements, governed CRP preparation and immutable publication, factor provenance and selection exceptions, audit history, enforced permissions, live membership counts, and verified application/database checks without substituting mock business records.

## Automated evidence

- `npm run test:staff` covers staff-role permissions, mutation-free read-only access, cross-tenant denial, mandatory tenant context, RLS transaction setup, live workspace boundaries, honest failure states, keyboard foundations, responsive breakpoints, reduced motion, dataset provenance, membership counts, and immutable report reads.
- `npm test -w @nzi/isolated-backend`: 121 passed, 0 failed at the accepted implementation revision.
- `npm run typecheck`: passed across all workspaces.
- `npm run build`: passed and generated dynamic routes for all five staff workspaces and their isolated APIs.
- The staging health endpoint returned `status=ok`, `env=staging`, `dataMode=isolated-api`, `writes=enabled`, `authentication=enabled`, and `authenticationRequired=true` after deployment.

## Browser-observed evidence still required

No controllable browser was connected when this acceptance pass ran. The browser runtime reported no available browser instances. Therefore the following remain explicitly unaccepted:

- rendered keyboard order and focus visibility;
- screen-reader announcements and landmark traversal;
- contrast inspection and reduced-motion observation;
- phone, tablet, laptop, and wide-desktop layout review;
- authenticated end-to-end journeys through all five staff workspaces.

Source contracts and production compilation support these behaviours, but they are not substitutes for rendered observation. M3 remains browser-acceptance pending until a browser is connected and these checks are recorded.

## Rollback

Revision `3342217` is the previous green deployment and remains the rollback target for the Datasets and Platform release. Roll back through a new revert commit, deploy it through `main`, then rerun `npm run test:staff`, typecheck, build, and the staging health check. No rollback was required.
