BEGIN;
ALTER TABLE inventory_stocks ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE inventory_stocks ADD COLUMN IF NOT EXISTS manufactured_on text CHECK(manufactured_on IS NULL OR manufactured_on ~ '^\d{4}-\d{2}-\d{2}$');
ALTER TABLE inventory_stocks ADD COLUMN IF NOT EXISTS disposition text CHECK(disposition IS NULL OR disposition IN('release','hold','block','reject'));
ALTER TABLE inventory_operations DROP CONSTRAINT IF EXISTS inventory_operations_quantity_check;
ALTER TABLE inventory_operations ADD CONSTRAINT inventory_operations_quantity_check CHECK((kind='quality_change' AND quantity=0) OR (kind<>'quality_change' AND quantity>0));
CREATE TABLE IF NOT EXISTS inventory_quality_dispositions(
  operation_id uuid PRIMARY KEY REFERENCES inventory_operations(operation_id),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  stock_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  device_id uuid NOT NULL,
  disposition text NOT NULL CHECK(disposition IN('release','hold','block','reject')),
  reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 2000),
  evidence text NOT NULL CHECK(length(trim(evidence)) BETWEEN 1 AND 2000),
  expected_revision integer NOT NULL CHECK(expected_revision>0),
  resulting_revision integer NOT NULL CHECK(resulting_revision=expected_revision+1),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(organization_id,stock_id) REFERENCES inventory_stocks(organization_id,id),
  FOREIGN KEY(organization_id,actor_id) REFERENCES users(organization_id,id),
  FOREIGN KEY(organization_id,device_id) REFERENCES devices(organization_id,id)
);
CREATE INDEX IF NOT EXISTS inventory_quality_by_stock ON inventory_quality_dispositions(organization_id,stock_id,recorded_at,operation_id);
CREATE OR REPLACE FUNCTION enforce_inventory_chief_quality() RETURNS trigger LANGUAGE plpgsql AS $quality_guard$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM users u JOIN devices d ON d.organization_id=u.organization_id AND d.user_id=u.id WHERE u.organization_id=NEW.organization_id AND u.id=NEW.actor_id AND u.role='chief' AND u.active AND d.id=NEW.device_id AND d.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'chief_quality_required';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM inventory_operations o WHERE o.operation_id=NEW.operation_id AND o.organization_id=NEW.organization_id AND o.stock_id=NEW.stock_id AND o.actor_id=NEW.actor_id AND o.device_id=NEW.device_id AND o.kind='quality_change' AND o.expected_revision=NEW.expected_revision AND o.resulting_revision=NEW.resulting_revision AND o.request_payload->>'disposition'=NEW.disposition AND o.request_payload->>'evidence'=NEW.evidence AND o.reason=NEW.reason AND o.result_stock->>'disposition'=NEW.disposition AND o.result_stock->>'quality'=CASE WHEN NEW.disposition='release' THEN 'released' ELSE 'blocked' END) THEN
    RAISE EXCEPTION 'quality_ledger_required';
  END IF;
  IF NEW.disposition='release' AND (EXISTS(SELECT 1 FROM inventory_stocks s WHERE s.organization_id=NEW.organization_id AND s.id=NEW.stock_id AND s.expires_at<=clock_timestamp()) OR EXISTS(SELECT 1 FROM inventory_quality_dispositions q WHERE q.organization_id=NEW.organization_id AND q.stock_id=NEW.stock_id AND q.disposition='reject')) THEN
    RAISE EXCEPTION 'quality_release_ineligible';
  END IF;
  RETURN NEW;
END $quality_guard$;
DROP TRIGGER IF EXISTS inventory_quality_chief ON inventory_quality_dispositions;
CREATE TRIGGER inventory_quality_chief BEFORE INSERT ON inventory_quality_dispositions FOR EACH ROW EXECUTE FUNCTION enforce_inventory_chief_quality();
DROP TRIGGER IF EXISTS inventory_quality_immutable ON inventory_quality_dispositions;
CREATE TRIGGER inventory_quality_immutable BEFORE UPDATE OR DELETE ON inventory_quality_dispositions FOR EACH ROW EXECUTE FUNCTION forbid_inventory_operation_rewrite();
CREATE OR REPLACE FUNCTION require_inventory_quality_pair() RETURNS trigger LANGUAGE plpgsql AS $quality_pair$
BEGIN
  IF NEW.kind='quality_change' AND NOT EXISTS(SELECT 1 FROM inventory_quality_dispositions q WHERE q.operation_id=NEW.operation_id AND q.organization_id=NEW.organization_id AND q.stock_id=NEW.stock_id) THEN
    RAISE EXCEPTION 'quality_disposition_required';
  END IF;
  RETURN NEW;
END $quality_pair$;
DROP TRIGGER IF EXISTS inventory_quality_pair ON inventory_operations;
CREATE CONSTRAINT TRIGGER inventory_quality_pair AFTER INSERT ON inventory_operations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_inventory_quality_pair();
COMMIT;
