# Hybrid MES: server foundation

This branch adds a separate backend without changing the existing offline-first Android app.

## Local development

1. Copy `infra/.env.example` to `infra/.env` and set a strong unique password.
2. Start PostgreSQL: `docker compose --env-file infra/.env -f infra/docker-compose.yml up -d postgres`.
3. Apply migration: `docker compose --env-file infra/.env -f infra/docker-compose.yml exec -T postgres psql -U production_mf -d production_mf < apps/server/migrations/001_foundation.sql` (run from repository root).
4. `cd apps/server && npm install && DATABASE_URL=postgres://production_mf:<password>@localhost:5432/production_mf npm run dev` (expose port 5432 locally if using this path), **or** start the server container with `docker compose --env-file infra/.env -f infra/docker-compose.yml up --build -d`.
5. Check `http://localhost:3001/health/live` and `/health/ready`.

The database port is intentionally not published by Compose. For migrations, use the exec command above. The application port is bound to localhost; use a properly configured TLS reverse proxy for remote access.

## Current scope and limitations

- Liveness and database readiness endpoints only. No unauthenticated business writes are exposed.
- Tables for organization, user, device identity and idempotent sync operation ledger are created, but authentication and sync API endpoints are **not implemented yet**.
- Migration is manual and should be automated in a later increment.
- Existing Dexie data is unchanged and is **not yet migrated**.
- Production deployment requires TLS, backup/restore tests, credential rotation, and monitoring.

## Next increment

Implement authenticated device enrollment and a transactional push/pull API with revision checking and cursor-based replication; then wire Dexie outbox on Android.

## Authentication increment

Apply `apps/server/migrations/002_sessions.sql` after the first migration. Run `npm run bootstrap -- 'Workshop' chief '<strong-password>'` from `apps/server` with DATABASE_URL set, on a new empty database only. Avoid putting real passwords into shell history; use an appropriately secured provisioning process before production.

Endpoints: POST `/auth/login` with organizationId, login, password; GET `/auth/me`; POST `/auth/logout`; POST `/devices` (chief only, publicKey and optional userId); POST `/devices/:id/revoke` (chief only). Bearer tokens are random, stored only as SHA-256 hashes in the database, and expire after 12 hours. Login has an in-process rate limit, not a distributed limiter.

**Not production-ready:** no refresh/offline session flow, audit logging, automated migrations, trusted device proof-of-possession, or distributed rate limiting. Device public keys are currently registration metadata only and do not authorize sync requests.

## Task synchronization prototype

Apply `apps/server/migrations/003_sync_entities.sql` after migrations 001 and 002.

- `POST /sync/push`: Bearer-authenticated chief/master only. Accepts `{operations:[{operationId,deviceId,entityType:"task",entityId,operationType:"upsert",expectedRevision:0,payload:{title,status,assigneeId?}}]}` (1–50 operations). A new entity uses expectedRevision 0; updates use the last acknowledged revision.
- `GET /sync/pull?cursor=0&limit=100`: Bearer-authenticated chief/master only. Returns ordered changes and nextCursor.
- A device must be enrolled to the current user and organization and not revoked.
- The first protocol slice intentionally rejects all non-task entity types. No arbitrary SQL or generic entity writes are exposed.
- Writes use a transaction and organization-scoped advisory lock to serialize commit order for the cursor stream. Repeated operation IDs are recognized and revision conflicts returned rather than overwritten.

**Not yet production-ready:** sync is not integrated with Android, no device private-key proof, worker-scoped sync or domain authorization on individual task assignments, and no database-backed integration tests. The sync endpoint is intentionally limited to managers until task-level access control is built. For large organizations, replace the organization-wide lock with a transactional outbox / commit-order mechanism.
