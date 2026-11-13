-- M1 workshop membership foundation. Schema only: no new authorization is enabled
-- until task-level read/write scope rules and migration compatibility are tested.
-- Workshop identifiers remain text to match existing TaskPayloadV1.workshopId.
BEGIN;
CREATE TABLE IF NOT EXISTS workshops (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  id text NOT NULL CHECK (length(id) BETWEEN 1 AND 120),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id)
);
-- Composite foreign keys prevent membership from linking a user in another tenant.
CREATE UNIQUE INDEX IF NOT EXISTS users_org_id_unique ON users(organization_id, id);
CREATE TABLE IF NOT EXISTS user_workshop_memberships (
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  workshop_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id, workshop_id),
  FOREIGN KEY (organization_id, user_id) REFERENCES users(organization_id, id),
  FOREIGN KEY (organization_id, workshop_id) REFERENCES workshops(organization_id, id)
);
CREATE INDEX IF NOT EXISTS user_workshop_memberships_workshop_idx
  ON user_workshop_memberships(organization_id, workshop_id, user_id);
COMMIT;
