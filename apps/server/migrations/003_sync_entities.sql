BEGIN;
CREATE TABLE IF NOT EXISTS sync_entities (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, entity_type, entity_id)
);
ALTER TABLE sync_operations ADD COLUMN IF NOT EXISTS revision integer;
ALTER TABLE sync_operations ADD COLUMN IF NOT EXISTS result_payload jsonb;
CREATE INDEX IF NOT EXISTS sync_operations_device_idx ON sync_operations(device_id, sequence);
COMMIT;
