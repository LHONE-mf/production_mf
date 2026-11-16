-- Additive room use. Existing received issues are custody; outcomes remain the
-- single quantity settlement stream for consumption, returns and scrap.
BEGIN;
CREATE TABLE inventory_slurry_consumptions (
 operation_id uuid PRIMARY KEY, organization_id uuid NOT NULL, actor_id uuid NOT NULL, device_id uuid NOT NULL,
 production_batch_id uuid NOT NULL, step_number integer NOT NULL, source_id text NOT NULL CHECK(length(source_id) BETWEEN 1 AND 200),
 room_id text NOT NULL DEFAULT 'slurry' CHECK(room_id='slurry'), epoch uuid NOT NULL,
 request_payload jsonb NOT NULL, result_payload jsonb NOT NULL, recorded_at timestamptz NOT NULL,
 stock_effect boolean GENERATED ALWAYS AS (false) STORED,
 UNIQUE(organization_id,source_id),
 FOREIGN KEY(organization_id,actor_id) REFERENCES users(organization_id,id),
 FOREIGN KEY(organization_id,device_id) REFERENCES devices(organization_id,id),
 FOREIGN KEY(organization_id,production_batch_id) REFERENCES production_batches(organization_id,id)
);
CREATE TRIGGER room_consumption_immutable BEFORE UPDATE OR DELETE ON inventory_slurry_consumptions FOR EACH ROW EXECUTE FUNCTION forbid_inventory_operation_rewrite();
ALTER TABLE inventory_issue_outcomes ADD COLUMN consumption_id uuid REFERENCES inventory_slurry_consumptions(operation_id), ADD COLUMN component_id text;
ALTER TABLE inventory_issue_outcomes DROP CONSTRAINT inventory_issue_outcomes_kind_check;
ALTER TABLE inventory_issue_outcomes ADD CHECK(kind IN ('return','scrap','consume'));
ALTER TABLE inventory_issue_outcomes DROP CONSTRAINT inventory_issue_outcomes_check1;
ALTER TABLE inventory_issue_outcomes ADD CHECK((kind='return' AND return_stock_id IS NOT NULL AND condition='untouched_unused' AND result_stock IS NOT NULL) OR (kind IN ('scrap','consume') AND return_stock_id IS NULL AND condition IS NULL AND result_stock IS NULL));
ALTER TABLE inventory_issue_outcomes ADD CHECK((kind='consume' AND consumption_id IS NOT NULL AND length(component_id) BETWEEN 1 AND 200) OR (kind<>'consume' AND consumption_id IS NULL AND component_id IS NULL));
CREATE OR REPLACE FUNCTION enforce_inventory_issue_outcome() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE issued inventory_issues%ROWTYPE; settled bigint; n bigint;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':inventory-sequence',0));
 IF NEW.kind='consume' THEN
  IF NOT EXISTS(SELECT 1 FROM inventory_slurry_consumptions c JOIN users u ON u.organization_id=c.organization_id AND u.id=NEW.actor_id JOIN devices d ON d.organization_id=u.organization_id AND d.user_id=u.id AND d.id=NEW.device_id AND d.revoked_at IS NULL
   JOIN inventory_issues i ON i.organization_id=c.organization_id AND i.id=NEW.issue_id
   WHERE c.operation_id=NEW.consumption_id AND c.organization_id=NEW.organization_id AND c.actor_id=NEW.actor_id AND c.device_id=NEW.device_id AND u.active
    AND c.production_batch_id=i.production_batch_id AND c.step_number=i.step_number AND i.unit='mg'
    AND (u.role='chief' OR (u.id=i.recipient_id OR u.role='master') AND EXISTS(SELECT 1 FROM user_workshop_memberships m WHERE m.organization_id=u.organization_id AND m.user_id=u.id AND m.workshop_id=i.workshop_id))
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(c.request_payload->'allocations') a WHERE a->>'operationId'=NEW.operation_id::text AND a->>'issueId'=NEW.issue_id::text AND a->>'componentId'=NEW.component_id AND (a->>'quantity')::bigint=NEW.quantity AND (a->>'expectedSettlementRevision')::bigint=NEW.expected_revision AND a->>'materialId'=i.material_id::text)) THEN RAISE EXCEPTION 'room_consumption_provenance_required'; END IF;
  IF NOT inventory_package_released(NEW.organization_id,NEW.source_stock_id) THEN RAISE EXCEPTION 'room_source_held'; END IF;
 ELSE
 IF NOT EXISTS(SELECT 1 FROM users u JOIN devices d ON d.organization_id=u.organization_id AND d.user_id=u.id AND d.id=NEW.device_id AND d.revoked_at IS NULL WHERE u.organization_id=NEW.organization_id AND u.id=NEW.actor_id AND u.active AND (u.role='chief' OR EXISTS(SELECT 1 FROM inventory_access a WHERE a.organization_id=u.organization_id AND a.user_id=u.id AND a.active AND (a.level='manager' OR NEW.kind='return' AND a.level='operator')))) THEN RAISE EXCEPTION 'outcome_warehouse_authority_required'; END IF;
 END IF;
 SELECT * INTO issued FROM inventory_issues WHERE organization_id=NEW.organization_id AND id=NEW.issue_id;
 IF NOT FOUND OR issued.state<>'received' OR issued.stock_id<>NEW.source_stock_id OR issued.production_batch_id<>NEW.production_batch_id THEN RAISE EXCEPTION 'accepted_issue_provenance_required'; END IF;
 SELECT count(*),COALESCE(sum(quantity),0) INTO n,settled FROM inventory_issue_outcomes WHERE organization_id=NEW.organization_id AND issue_id=NEW.issue_id;
 IF NEW.expected_revision<>n+1 OR NEW.quantity>issued.quantity-settled THEN RAISE EXCEPTION 'issue_outstanding_changed'; END IF;
 IF NEW.kind='return' AND (NOT inventory_package_released(NEW.organization_id,NEW.source_stock_id) OR (issued.source_snapshot->>'expiresAt')::timestamptz<=clock_timestamp()) THEN RAISE EXCEPTION 'return_source_ineligible'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION enforce_inventory_issue_intent_id() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE other record;incoming_effect boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.operation_id::text,1));
 -- Generated columns are NULL in BEFORE INSERT triggers. Derive their effect
 -- explicitly so SQL three-valued logic cannot allow a zero-stock ID to pair.
 incoming_effect:=CASE
  WHEN TG_TABLE_NAME IN ('inventory_operations','inventory_output_acceptances') THEN true
  WHEN TG_TABLE_NAME IN ('inventory_output_submissions','inventory_cell_submissions','inventory_slurry_consumptions') THEN false
  WHEN TG_TABLE_NAME='inventory_issue_outcomes' THEN to_jsonb(NEW)->>'kind'='return'
  WHEN TG_TABLE_NAME='inventory_count_events' THEN to_jsonb(NEW)->>'kind'='correct'
  ELSE (to_jsonb(NEW)->>'stock_effect')::boolean END;
 FOR other IN
  SELECT 'inventory_operations' AS owner,organization_id,actor_id,device_id,request_payload,true AS stock_effect FROM inventory_operations WHERE operation_id=NEW.operation_id AND TG_TABLE_NAME<>'inventory_operations'
  UNION ALL SELECT 'inventory_issue_events',organization_id,actor_id,device_id,request_payload,stock_effect FROM inventory_issue_events WHERE operation_id=NEW.operation_id AND TG_TABLE_NAME<>'inventory_issue_events'
  UNION ALL SELECT 'inventory_issue_outcomes',organization_id,actor_id,device_id,request_payload,stock_effect FROM inventory_issue_outcomes WHERE operation_id=NEW.operation_id AND TG_TABLE_NAME<>'inventory_issue_outcomes'
  UNION ALL SELECT 'inventory_count_events',organization_id,actor_id,device_id,request_payload,stock_effect FROM inventory_count_events WHERE operation_id=NEW.operation_id AND TG_TABLE_NAME<>'inventory_count_events'
  UNION ALL SELECT 'inventory_output_submissions',organization_id,actor_id,device_id,request_payload,stock_effect FROM inventory_output_submissions WHERE operation_id=NEW.operation_id AND TG_TABLE_NAME<>'inventory_output_submissions'
  UNION ALL SELECT 'inventory_cell_submissions',organization_id,actor_id,device_id,request_payload,stock_effect FROM inventory_cell_submissions WHERE operation_id=NEW.operation_id AND TG_TABLE_NAME<>'inventory_cell_submissions'
  UNION ALL SELECT 'inventory_output_acceptances',organization_id,actor_id,device_id,request_payload,stock_effect FROM inventory_output_acceptances WHERE operation_id=NEW.operation_id AND TG_TABLE_NAME<>'inventory_output_acceptances'
  UNION ALL SELECT 'inventory_slurry_consumptions',organization_id,actor_id,device_id,request_payload,false FROM inventory_slurry_consumptions WHERE operation_id=NEW.operation_id AND TG_TABLE_NAME<>'inventory_slurry_consumptions'
 LOOP
  IF other.organization_id<>NEW.organization_id OR other.actor_id<>NEW.actor_id OR other.device_id IS DISTINCT FROM NEW.device_id OR other.request_payload<>NEW.request_payload OR other.stock_effect IS DISTINCT FROM true OR incoming_effect IS DISTINCT FROM true OR TG_TABLE_NAME<>'inventory_operations' AND other.owner<>'inventory_operations' THEN RAISE EXCEPTION 'operation_id_reused' USING ERRCODE='23505'; END IF;
 END LOOP;RETURN NEW;
END $$;
CREATE TRIGGER room_consumption_namespace BEFORE INSERT ON inventory_slurry_consumptions FOR EACH ROW EXECUTE FUNCTION enforce_inventory_issue_intent_id();

CREATE FUNCTION require_room_consumption_pair() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item jsonb; component jsonb;
BEGIN
 IF COALESCE(jsonb_array_length(NEW.request_payload->'allocations'),0) NOT BETWEEN 1 AND 100 OR COALESCE(jsonb_array_length(NEW.request_payload->'source'->'components'),0) NOT BETWEEN 1 AND 100 OR NEW.request_payload->>'operationId' IS DISTINCT FROM NEW.operation_id::text OR NEW.request_payload->>'deviceId' IS DISTINCT FROM NEW.device_id::text OR NEW.request_payload->>'productionBatchId' IS DISTINCT FROM NEW.production_batch_id::text OR NEW.request_payload->'source'->>'id' IS DISTINCT FROM NEW.source_id
  OR jsonb_array_length(NEW.request_payload->'allocations') NOT BETWEEN 1 AND 100
  OR NEW.result_payload->'source' IS DISTINCT FROM NEW.request_payload->'source'
  OR NEW.result_payload->'allocations' IS DISTINCT FROM NEW.request_payload->'allocations'
  OR NEW.result_payload->>'actorId' IS DISTINCT FROM NEW.actor_id::text THEN RAISE EXCEPTION 'room_consumption_pair_required'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(NEW.request_payload->'allocations') LOOP
  IF NOT EXISTS(SELECT 1 FROM inventory_issue_outcomes o WHERE o.consumption_id=NEW.operation_id AND o.operation_id::text=item->>'operationId' AND o.organization_id=NEW.organization_id AND o.kind='consume') THEN RAISE EXCEPTION 'room_consumption_pair_required'; END IF;
 END LOOP;
 IF (SELECT count(*) FROM inventory_issue_outcomes WHERE consumption_id=NEW.operation_id)<>jsonb_array_length(NEW.request_payload->'allocations') THEN RAISE EXCEPTION 'room_consumption_pair_required'; END IF;
 FOR component IN SELECT value FROM jsonb_array_elements(NEW.request_payload->'source'->'components') LOOP
  IF (component->>'actualMg')::numeric IS DISTINCT FROM (SELECT COALESCE(sum((a->>'quantity')::numeric),0) FROM jsonb_array_elements(NEW.request_payload->'allocations') a WHERE a->>'componentId'=component->>'componentId') THEN RAISE EXCEPTION 'room_measured_allocation_required'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.request_payload->'allocations') a WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.request_payload->'source'->'components') c WHERE c->>'componentId'=a->>'componentId')) THEN RAISE EXCEPTION 'room_measured_allocation_required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM production_batches b JOIN production_orders o ON o.organization_id=b.organization_id AND o.id=b.order_id JOIN process_route_steps s ON s.organization_id=o.organization_id AND s.route_id=o.route_id AND s.route_version=o.route_version AND s.step_number=NEW.step_number AND s.electrode_line=CASE WHEN b.material_line='cell' THEN 'common' ELSE b.material_line END WHERE b.organization_id=NEW.organization_id AND b.id=NEW.production_batch_id AND s.stage='slurry') THEN RAISE EXCEPTION 'slurry_route_required'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER room_consumption_pair AFTER INSERT ON inventory_slurry_consumptions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_room_consumption_pair();
COMMIT;
