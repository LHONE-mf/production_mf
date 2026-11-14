-- One explicit authorized repack creates one child; repeat for additional children.
-- Parent identity and reservations remain; no arbitrary pooling/merge is introduced.
BEGIN;
ALTER TABLE inventory_operations DROP CONSTRAINT inventory_operations_kind_check;
ALTER TABLE inventory_operations ADD CONSTRAINT inventory_operations_kind_check CHECK(kind IN ('receive','reserve','release_reservation','issue','return','transfer','adjust','quality_change','scrap','split_out','split_in'));
CREATE TABLE inventory_splits (
 operation_id uuid PRIMARY KEY REFERENCES inventory_operations(operation_id),
 child_operation_id uuid NOT NULL UNIQUE REFERENCES inventory_operations(operation_id),
 sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 organization_id uuid NOT NULL,parent_stock_id uuid NOT NULL,child_stock_id uuid NOT NULL UNIQUE,
 actor_id uuid NOT NULL,device_id uuid NOT NULL,epoch uuid NOT NULL,
 quantity bigint NOT NULL CHECK(quantity BETWEEN 1 AND 9007199254740991),
 expected_revision integer NOT NULL CHECK(expected_revision BETWEEN 1 AND 2147483646),
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 2000),
 evidence text NOT NULL CHECK(length(trim(evidence)) BETWEEN 1 AND 2000),
 request_payload jsonb NOT NULL,parent_before jsonb NOT NULL,parent_after jsonb NOT NULL,child_after jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(operation_id<>child_operation_id AND parent_stock_id<>child_stock_id),
 FOREIGN KEY(organization_id,parent_stock_id) REFERENCES inventory_stocks(organization_id,id),
 FOREIGN KEY(organization_id,child_stock_id) REFERENCES inventory_stocks(organization_id,id),
 FOREIGN KEY(organization_id,actor_id) REFERENCES users(organization_id,id),
 FOREIGN KEY(organization_id,device_id) REFERENCES devices(organization_id,id)
);
CREATE INDEX inventory_splits_parent ON inventory_splits(organization_id,parent_stock_id,sequence);
CREATE INDEX inventory_splits_history ON inventory_splits(organization_id,sequence);
CREATE TRIGGER inventory_split_immutable BEFORE UPDATE OR DELETE ON inventory_splits FOR EACH ROW EXECUTE FUNCTION forbid_inventory_operation_rewrite();
CREATE FUNCTION enforce_inventory_split() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p inventory_stocks%ROWTYPE;c inventory_stocks%ROWTYPE;a inventory_operations%ROWTYPE;b inventory_operations%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':inventory-sequence',0));
 IF NOT EXISTS(SELECT 1 FROM users u JOIN devices d ON d.organization_id=u.organization_id AND d.user_id=u.id AND d.id=NEW.device_id AND d.revoked_at IS NULL WHERE u.organization_id=NEW.organization_id AND u.id=NEW.actor_id AND u.active AND (u.role='chief' OR EXISTS(SELECT 1 FROM inventory_access x WHERE x.organization_id=u.organization_id AND x.user_id=u.id AND x.active AND x.level='manager'))) THEN RAISE EXCEPTION 'split_manager_required'; END IF;
 SELECT * INTO p FROM inventory_stocks WHERE organization_id=NEW.organization_id AND id=NEW.parent_stock_id;
 SELECT * INTO c FROM inventory_stocks WHERE organization_id=NEW.organization_id AND id=NEW.child_stock_id;
 SELECT * INTO a FROM inventory_operations WHERE operation_id=NEW.operation_id;
 SELECT * INTO b FROM inventory_operations WHERE operation_id=NEW.child_operation_id;
 IF a.organization_id IS DISTINCT FROM NEW.organization_id OR b.organization_id IS DISTINCT FROM NEW.organization_id OR a.kind IS DISTINCT FROM 'split_out' OR b.kind IS DISTINCT FROM 'split_in'
  OR a.stock_id IS DISTINCT FROM p.id OR b.stock_id IS DISTINCT FROM c.id OR a.actor_id<>NEW.actor_id OR b.actor_id<>NEW.actor_id OR a.device_id IS DISTINCT FROM NEW.device_id OR b.device_id IS DISTINCT FROM NEW.device_id
  OR a.quantity<>NEW.quantity OR b.quantity<>NEW.quantity OR a.expected_revision<>NEW.expected_revision OR a.resulting_revision<>NEW.expected_revision+1 OR b.expected_revision<>0 OR b.resulting_revision<>1
  OR a.request_payload<>NEW.request_payload OR b.request_payload<>NEW.request_payload OR a.result_stock<>NEW.parent_after OR b.result_stock<>NEW.child_after
  OR (NEW.parent_before->>'revision')::integer IS DISTINCT FROM NEW.expected_revision OR (NEW.parent_before->>'onHand')::bigint-NEW.quantity IS DISTINCT FROM p.on_hand
  OR (NEW.parent_before->>'reserved')::bigint IS DISTINCT FROM p.reserved OR p.on_hand<p.reserved OR c.on_hand<>NEW.quantity OR c.reserved<>0 OR c.revision<>1 OR p.revision<>NEW.expected_revision+1
  OR p.material_id<>c.material_id OR p.manufacturer_lot<>c.manufacturer_lot OR p.quality<>c.quality OR p.disposition IS DISTINCT FROM c.disposition OR p.expires_at IS DISTINCT FROM c.expires_at OR p.manufactured_on IS DISTINCT FROM c.manufactured_on
  OR (NEW.parent_before-ARRAY['onHand','available','revision'])<>(NEW.parent_after-ARRAY['onHand','available','revision'])
  OR (NEW.parent_after-ARRAY['stockId','locationId','onHand','reserved','available','revision'])<>(NEW.child_after-ARRAY['stockId','locationId','onHand','reserved','available','revision'])
  OR (NEW.child_after->>'onHand')::bigint IS DISTINCT FROM c.on_hand OR (NEW.child_after->>'reserved')::bigint IS DISTINCT FROM 0 OR (NEW.child_after->>'available')::bigint IS DISTINCT FROM c.on_hand OR (NEW.child_after->>'revision')::integer IS DISTINCT FROM 1
  OR (NEW.child_after->>'stockId')::uuid IS DISTINCT FROM c.id OR (NEW.child_after->>'locationId')::uuid IS DISTINCT FROM c.location_id OR (NEW.parent_after->>'stockId')::uuid IS DISTINCT FROM p.id OR (NEW.parent_after->>'locationId')::uuid IS DISTINCT FROM p.location_id
  OR (NEW.parent_after->>'onHand')::bigint IS DISTINCT FROM p.on_hand OR (NEW.parent_after->>'reserved')::bigint IS DISTINCT FROM p.reserved OR (NEW.parent_after->>'available')::bigint IS DISTINCT FROM p.on_hand-p.reserved OR (NEW.parent_after->>'revision')::integer IS DISTINCT FROM p.revision
  OR NOT EXISTS(SELECT 1 FROM inventory_operations prior WHERE prior.organization_id=NEW.organization_id AND prior.stock_id=p.id AND prior.resulting_revision=NEW.expected_revision AND prior.result_stock=NEW.parent_before)
  OR EXISTS(SELECT 1 FROM inventory_operations prior WHERE prior.organization_id=NEW.organization_id AND prior.stock_id=c.id AND prior.operation_id<>NEW.child_operation_id)
 THEN RAISE EXCEPTION 'inventory_split_conservation_required'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_split_guard BEFORE INSERT ON inventory_splits FOR EACH ROW EXECUTE FUNCTION enforce_inventory_split();
CREATE FUNCTION require_inventory_split_pair() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.kind='split_out' AND NOT EXISTS(SELECT 1 FROM inventory_splits WHERE operation_id=NEW.operation_id) OR NEW.kind='split_in' AND NOT EXISTS(SELECT 1 FROM inventory_splits WHERE child_operation_id=NEW.operation_id) THEN RAISE EXCEPTION 'inventory_split_pair_required'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER inventory_split_pair AFTER INSERT ON inventory_operations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_inventory_split_pair();

CREATE OR REPLACE FUNCTION inventory_package_released(org uuid,package uuid) RETURNS boolean LANGUAGE sql AS $$
 WITH RECURSIVE edges(child,parent) AS (
  SELECT return_stock_id,source_stock_id FROM inventory_issue_outcomes WHERE organization_id=org AND kind='return'
  UNION ALL SELECT child_stock_id,parent_stock_id FROM inventory_splits WHERE organization_id=org
 ),lineage(id,depth) AS (
  SELECT id,0 FROM inventory_stocks WHERE organization_id=org AND id=package
  UNION ALL SELECT e.parent,l.depth+1 FROM lineage l JOIN edges e ON e.child=l.id WHERE l.depth<100
 ) SELECT count(*)>0 AND COALESCE(bool_and(s.quality='released' AND (s.expires_at IS NULL OR s.expires_at>clock_timestamp())),false) AND COALESCE(max(l.depth),100)<100
 FROM lineage l JOIN inventory_stocks s ON s.organization_id=org AND s.id=l.id
$$;
CREATE OR REPLACE FUNCTION enforce_returned_package_quality() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.disposition='release' AND (
  EXISTS(SELECT 1 FROM inventory_issue_outcomes o WHERE o.organization_id=NEW.organization_id AND o.return_stock_id=NEW.stock_id AND NOT inventory_package_released(NEW.organization_id,o.source_stock_id))
  OR EXISTS(SELECT 1 FROM inventory_splits s WHERE s.organization_id=NEW.organization_id AND s.child_stock_id=NEW.stock_id AND NOT inventory_package_released(NEW.organization_id,s.parent_stock_id))
 ) THEN RAISE EXCEPTION 'quality_release_ineligible'; END IF;
 RETURN NEW;
END $$;
COMMIT;
