-- Initial authoritative identities and durable synchronization ledger.
-- Apply using psql -v ON_ERROR_STOP=1 -f migrations/001_foundation.sql
BEGIN;
CREATE TABLE IF NOT EXISTS organizations (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  login text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('chief', 'master', 'technologist', 'worker')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, login)
);
CREATE TABLE IF NOT EXISTS devices (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid REFERENCES users(id),
  public_key text,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sync_operations (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation_id uuid NOT NULL UNIQUE,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  device_id uuid NOT NULL REFERENCES devices(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  operation_type text NOT NULL,
  expected_revision integer,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sync_operations_org_sequence ON sync_operations(organization_id, sequence);
COMMIT;
