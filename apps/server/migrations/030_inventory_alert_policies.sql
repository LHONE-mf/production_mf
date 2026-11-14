BEGIN;
-- S8 durable per-material warning thresholds. These are configuration, not stock.
CREATE TABLE inventory_alert_policies (
 organization_id uuid NOT NULL REFERENCES organizations(id),
 material_id uuid NOT NULL,
 low_available bigint NOT NULL DEFAULT 0 CHECK(low_available BETWEEN 0 AND 9007199254740991),
 expiry_days integer NOT NULL DEFAULT 30 CHECK(expiry_days BETWEEN 0 AND 365),
 active boolean NOT NULL DEFAULT true,
 revision integer NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 2147483646),
 updated_by uuid NOT NULL,updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,material_id),
 FOREIGN KEY(organization_id,material_id) REFERENCES inventory_materials(organization_id,id),
 FOREIGN KEY(organization_id,updated_by) REFERENCES users(organization_id,id)
);
CREATE TABLE inventory_alert_policy_events (
 change_id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES organizations(id),
 material_id uuid NOT NULL,
 actor_id uuid NOT NULL,device_id uuid NOT NULL,
 epoch uuid NOT NULL,expected_revision integer NOT NULL,
 request_payload jsonb NOT NULL,result_payload jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(organization_id,material_id) REFERENCES inventory_materials(organization_id,id),
 FOREIGN KEY(organization_id,actor_id) REFERENCES users(organization_id,id),
 FOREIGN KEY(organization_id,device_id) REFERENCES devices(organization_id,id)
);
CREATE INDEX inventory_alert_policy_events_history ON inventory_alert_policy_events(organization_id,material_id,recorded_at);
CREATE TRIGGER inventory_alert_policy_events_immutable BEFORE UPDATE OR DELETE ON inventory_alert_policy_events FOR EACH ROW EXECUTE FUNCTION forbid_inventory_operation_rewrite();
COMMIT;
