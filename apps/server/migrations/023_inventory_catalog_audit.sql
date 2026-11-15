-- Additive audit for catalogue creation. Existing identities, stock and queues stay intact.
BEGIN;
CREATE TABLE IF NOT EXISTS inventory_catalog_events (
  change_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  resource_id uuid NOT NULL,
  resource_type text NOT NULL CHECK(resource_type IN ('material','location')),
  actor_id uuid NOT NULL,
  device_id uuid NOT NULL,
  request_payload jsonb NOT NULL,
  result_payload jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(organization_id,actor_id) REFERENCES users(organization_id,id),
  FOREIGN KEY(organization_id,device_id) REFERENCES devices(organization_id,id)
);
CREATE INDEX IF NOT EXISTS inventory_catalog_events_by_org ON inventory_catalog_events(organization_id,recorded_at,change_id);
DROP TRIGGER IF EXISTS inventory_catalog_event_immutable ON inventory_catalog_events;
CREATE TRIGGER inventory_catalog_event_immutable BEFORE UPDATE OR DELETE ON inventory_catalog_events FOR EACH ROW EXECUTE FUNCTION forbid_inventory_operation_rewrite();
ALTER TABLE inventory_access_events ADD COLUMN IF NOT EXISTS device_id uuid;
ALTER TABLE inventory_access_events ADD COLUMN IF NOT EXISTS epoch uuid;
COMMIT;
