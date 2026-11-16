-- Exact measured collector-foil use shares the existing return/scrap settlement stream.
-- No old record, unit, warehouse balance or Slurry measurement is rewritten.
BEGIN;
CREATE TABLE inventory_coating_foil_consumptions (
 operation_id uuid PRIMARY KEY, organization_id uuid NOT NULL, actor_id uuid NOT NULL, device_id uuid NOT NULL,
 production_batch_id uuid NOT NULL, step_number integer NOT NULL, material_id uuid NOT NULL,
 unit text NOT NULL CHECK(unit IN ('mg','mm')), actual_quantity bigint NOT NULL CHECK(actual_quantity BETWEEN 1 AND 9007199254740991),
 epoch uuid NOT NULL, request_payload jsonb NOT NULL, result_payload jsonb NOT NULL, recorded_at timestamptz NOT NULL,
 stock_effect boolean GENERATED ALWAYS AS (false) STORED,
 UNIQUE(organization_id,operation_id),
 FOREIGN KEY(organization_id,actor_id) REFERENCES users(organization_id,id),
 FOREIGN KEY(organization_id,device_id) REFERENCES devices(organization_id,id),
 FOREIGN KEY(organization_id,production_batch_id) REFERENCES production_batches(organization_id,id),
 FOREIGN KEY(organization_id,material_id) REFERENCES inventory_materials(organization_id,id)
);
CREATE INDEX coating_foil_history ON inventory_coating_foil_consumptions(organization_id,operation_id);
CREATE TRIGGER coating_foil_immutable BEFORE UPDATE OR DELETE ON inventory_coating_foil_consumptions FOR EACH ROW EXECUTE FUNCTION forbid_inventory_operation_rewrite();
ALTER TABLE inventory_issue_outcomes ADD COLUMN foil_consumption_id uuid;
ALTER TABLE inventory_issue_outcomes ADD CONSTRAINT foil_consumption_parent FOREIGN KEY(organization_id,foil_consumption_id) REFERENCES inventory_coating_foil_consumptions(organization_id,operation_id);
ALTER TABLE inventory_issue_outcomes DROP CONSTRAINT inventory_issue_outcomes_check3;
ALTER TABLE inventory_issue_outcomes ADD CONSTRAINT inventory_issue_outcome_consumption_parent CHECK(
 (kind='consume' AND ((consumption_id IS NOT NULL AND component_id IS NOT NULL AND length(component_id) BETWEEN 1 AND 200 AND foil_consumption_id IS NULL)
   OR (foil_consumption_id IS NOT NULL AND consumption_id IS NULL AND component_id IS NULL)))
 OR (kind<>'consume' AND consumption_id IS NULL AND component_id IS NULL AND foil_consumption_id IS NULL));

-- VOLATILE sees preceding rows in one multi-row allocation statement.
CREATE FUNCTION coating_foil_source(org uuid,issue uuid) RETURNS jsonb LANGUAGE sql VOLATILE AS $$
 SELECT jsonb_build_object('issue',e.result_issue,'settlement',jsonb_build_object(
 'revision',a.n+1,'issued',i.quantity,'returned',a.returned,'scrapped',a.scrapped,'consumed',a.consumed,'outstanding',i.quantity-a.returned-a.scrapped-a.consumed))
 FROM inventory_issues i JOIN inventory_issue_events e ON e.organization_id=i.organization_id AND e.operation_id=i.receipt_operation_id AND e.kind='receive'
 CROSS JOIN LATERAL(SELECT count(*) AS n,COALESCE(sum(quantity) FILTER(WHERE kind='return'),0) AS returned,COALESCE(sum(quantity) FILTER(WHERE kind='scrap'),0) AS scrapped,COALESCE(sum(quantity) FILTER(WHERE kind='consume'),0) AS consumed FROM inventory_issue_outcomes WHERE organization_id=org AND issue_id=i.id) a
 WHERE i.organization_id=org AND i.id=issue AND i.state='received'
 -- An issue row is a repairable projection. Its identity and capacity must
 -- still agree with the original immutable receive ACK before it can be used.
 AND e.result_issue @> jsonb_build_object('id',i.id,'materialId',i.material_id,'productionBatchId',i.production_batch_id,
 'stepNumber',i.step_number,'workshopId',i.workshop_id,'recipientId',i.recipient_id,'requestedBy',i.requested_by,
 'quantity',i.quantity,'unit',i.unit,'state',i.state,'revision',i.revision,'stockId',i.stock_id,'source',i.source_snapshot,
 'approvalOperationId',i.approved_operation_id,'approvedStockRevision',i.approved_stock_revision,'approvedBy',i.approved_by,
 'approvedDeviceId',i.approved_device_id,'dispatchOperationId',i.dispatch_operation_id,'receiptOperationId',i.receipt_operation_id)
$$;
CREATE FUNCTION guard_coating_foil_consumption() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':inventory-sequence',0));
 IF jsonb_typeof(NEW.request_payload->'allocations') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'foil_measured_allocation_required'; END IF;
 IF NEW.request_payload->>'operationId' IS DISTINCT FROM NEW.operation_id::text OR NEW.request_payload->>'deviceId' IS DISTINCT FROM NEW.device_id::text
 OR NEW.request_payload->>'productionBatchId' IS DISTINCT FROM NEW.production_batch_id::text OR (NEW.request_payload->>'stepNumber')::integer IS DISTINCT FROM NEW.step_number
 OR NEW.request_payload->>'materialId' IS DISTINCT FROM NEW.material_id::text OR NEW.request_payload->>'unit' IS DISTINCT FROM NEW.unit
 OR (NEW.request_payload->>'actualQuantity')::bigint IS DISTINCT FROM NEW.actual_quantity
 OR NOT COALESCE((NEW.request_payload->>'observedAt')::numeric>0,false)
 OR NOT COALESCE(length(btrim(NEW.request_payload->>'reference')) BETWEEN 1 AND 2000,false)
 OR NOT COALESCE(length(btrim(NEW.request_payload->>'specificationReference')) BETWEEN 1 AND 2000,false)
 OR jsonb_array_length(NEW.request_payload->'allocations') NOT BETWEEN 1 AND 100
 OR (SELECT sum((a->>'quantity')::numeric) FROM jsonb_array_elements(NEW.request_payload->'allocations') a) IS DISTINCT FROM NEW.actual_quantity::numeric
 OR (SELECT count(DISTINCT a->>'issueId') FROM jsonb_array_elements(NEW.request_payload->'allocations') a)<>jsonb_array_length(NEW.request_payload->'allocations')
 OR (SELECT count(DISTINCT a->>'operationId') FROM jsonb_array_elements(NEW.request_payload->'allocations') a)<>jsonb_array_length(NEW.request_payload->'allocations')
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.request_payload->'allocations') a WHERE a->>'operationId'=NEW.operation_id::text)
 OR (NEW.result_payload-ARRAY['room','actorId','recordedAt','warehouseEffect','sources']) IS DISTINCT FROM NEW.request_payload
 OR NEW.result_payload->>'room' IS DISTINCT FROM 'coating' OR NEW.result_payload->>'warehouseEffect' IS DISTINCT FROM 'none'
 OR NEW.result_payload->>'actorId' IS DISTINCT FROM NEW.actor_id::text OR (NEW.result_payload->>'recordedAt')::timestamptz IS DISTINCT FROM NEW.recorded_at
 THEN RAISE EXCEPTION 'foil_measured_allocation_required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM production_batches b JOIN production_orders o ON o.organization_id=b.organization_id AND o.id=b.order_id
 JOIN process_route_steps s ON s.organization_id=o.organization_id AND s.route_id=o.route_id AND s.route_version=o.route_version AND s.step_number=NEW.step_number AND s.electrode_line=CASE WHEN b.material_line='cell' THEN 'common' ELSE b.material_line END
 JOIN users u ON u.organization_id=b.organization_id AND u.id=NEW.actor_id AND u.active
 JOIN devices d ON d.organization_id=u.organization_id AND d.user_id=u.id AND d.id=NEW.device_id AND d.revoked_at IS NULL
 JOIN inventory_materials m ON m.organization_id=b.organization_id AND m.id=NEW.material_id AND m.active AND m.base_unit=NEW.unit AND m.category IN ('raw_material','component') AND m.tape_specification IS NULL
 WHERE b.organization_id=NEW.organization_id AND b.id=NEW.production_batch_id AND b.status IN ('created','in_progress') AND o.status IN ('released','in_progress') AND s.stage='coating'
 AND (u.role='chief' OR EXISTS(SELECT 1 FROM user_workshop_memberships w WHERE w.organization_id=u.organization_id AND w.user_id=u.id AND w.workshop_id=s.workshop_id))) THEN RAISE EXCEPTION 'foil_source_or_authority_changed'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER coating_foil_guard BEFORE INSERT ON inventory_coating_foil_consumptions FOR EACH ROW EXECUTE FUNCTION guard_coating_foil_consumption();

CREATE FUNCTION guard_coating_foil_allocation(entry inventory_issue_outcomes) RETURNS void LANGUAGE plpgsql AS $$
DECLARE c inventory_coating_foil_consumptions; i inventory_issues; item jsonb; before jsonb; after jsonb; original jsonb;
BEGIN
 SELECT * INTO c FROM inventory_coating_foil_consumptions WHERE organization_id=entry.organization_id AND operation_id=entry.foil_consumption_id;
 SELECT * INTO i FROM inventory_issues WHERE organization_id=entry.organization_id AND id=entry.issue_id;
 SELECT a.value INTO item FROM jsonb_array_elements(c.request_payload->'allocations') a WHERE a.value->>'operationId'=entry.operation_id::text;
 SELECT s.value INTO original FROM jsonb_array_elements(c.result_payload->'sources') s WHERE s.value->'issue'->>'id'=entry.issue_id::text;
 before:=coating_foil_source(entry.organization_id,entry.issue_id);
 IF c.operation_id IS NULL OR i.id IS NULL OR item IS NULL OR before IS NULL OR original IS DISTINCT FROM before
 OR c.actor_id<>entry.actor_id OR c.device_id<>entry.device_id OR c.epoch<>entry.epoch OR c.recorded_at<>entry.recorded_at
 OR c.production_batch_id<>i.production_batch_id OR c.step_number<>i.step_number OR c.material_id<>i.material_id OR c.unit<>i.unit
 OR item->>'issueId' IS DISTINCT FROM i.id::text OR (item->>'quantity')::bigint IS DISTINCT FROM entry.quantity OR (item->>'expectedSettlementRevision')::bigint IS DISTINCT FROM entry.expected_revision
 OR entry.request_payload IS DISTINCT FROM (jsonb_build_object('consumptionId',c.operation_id)||item)
 OR entry.reason IS DISTINCT FROM c.request_payload->>'reason' OR entry.evidence IS DISTINCT FROM c.request_payload->>'evidence'
 OR NOT EXISTS(SELECT 1 FROM users u JOIN user_workshop_memberships w ON w.organization_id=u.organization_id AND w.user_id=u.id AND w.workshop_id=i.workshop_id WHERE u.organization_id=entry.organization_id AND u.id=entry.actor_id AND (u.role='master' OR i.recipient_id=u.id) UNION ALL SELECT 1 FROM users WHERE organization_id=entry.organization_id AND id=entry.actor_id AND role='chief')
 OR NOT inventory_package_released(entry.organization_id,i.stock_id) OR (i.source_snapshot->>'expiresAt')::timestamptz<=clock_timestamp()
 THEN RAISE EXCEPTION 'foil_source_or_settlement_changed'; END IF;
 after:=(before->'settlement')||jsonb_build_object('revision',entry.resulting_revision,'consumed',((before->'settlement'->>'consumed')::bigint+entry.quantity),'outstanding',((before->'settlement'->>'outstanding')::bigint-entry.quantity));
 IF entry.result_payload->'settlement' IS DISTINCT FROM after OR entry.result_payload->>'operationId' IS DISTINCT FROM entry.operation_id::text
 OR entry.result_payload->'outcome' IS DISTINCT FROM jsonb_build_object('operationId',entry.operation_id,'issueId',i.id,'productionBatchId',i.production_batch_id,'sourceStockId',i.stock_id,'actorId',entry.actor_id,'deviceId',entry.device_id,'kind','consume','quantity',entry.quantity,'stockId',NULL,'condition',NULL,'expectedRevision',entry.expected_revision,'resultingRevision',entry.resulting_revision,'reason',entry.reason,'evidence',entry.evidence,'recordedAt',c.result_payload->>'recordedAt')
 THEN RAISE EXCEPTION 'foil_ack_required'; END IF;
END $$;
CREATE OR REPLACE FUNCTION enforce_inventory_issue_outcome() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE issued inventory_issues%ROWTYPE; settled bigint; n bigint;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':inventory-sequence',0));
 IF NEW.kind='consume' AND NEW.foil_consumption_id IS NOT NULL THEN
  PERFORM guard_coating_foil_allocation(NEW);
 ELSIF NEW.kind='consume' THEN
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

CREATE FUNCTION require_coating_foil_pair() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item jsonb;
BEGIN
 IF jsonb_typeof(NEW.result_payload->'sources') IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.result_payload->'sources')<>jsonb_array_length(NEW.request_payload->'allocations')
 OR (SELECT count(*) FROM inventory_issue_outcomes WHERE organization_id=NEW.organization_id AND foil_consumption_id=NEW.operation_id)<>jsonb_array_length(NEW.request_payload->'allocations') THEN RAISE EXCEPTION 'foil_allocation_pair_required'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(NEW.request_payload->'allocations') LOOP
  IF NOT EXISTS(SELECT 1 FROM inventory_issue_outcomes o WHERE o.organization_id=NEW.organization_id AND o.foil_consumption_id=NEW.operation_id AND o.operation_id::text=item->>'operationId' AND o.kind='consume') THEN RAISE EXCEPTION 'foil_allocation_pair_required'; END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER coating_foil_pair AFTER INSERT ON inventory_coating_foil_consumptions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_coating_foil_pair();
CREATE OR REPLACE FUNCTION enforce_inventory_issue_intent_id() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE other record;incoming_effect boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.operation_id::text,1));
 -- Generated columns are NULL in BEFORE INSERT triggers. Derive their effect
 -- explicitly so SQL three-valued logic cannot allow a zero-stock ID to pair.
 incoming_effect:=CASE
  WHEN TG_TABLE_NAME IN ('inventory_operations','inventory_output_acceptances') THEN true
  WHEN TG_TABLE_NAME IN ('inventory_output_submissions','inventory_cell_submissions','inventory_slurry_consumptions','inventory_room_outputs','inventory_room_handoffs','inventory_room_handoff_events','inventory_coating_consumptions','inventory_coating_allocations','inventory_coating_foil_consumptions') THEN false
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
  UNION ALL SELECT 'inventory_room_outputs',organization_id,actor_id,device_id,request_payload,false FROM inventory_room_outputs WHERE operation_id=NEW.operation_id AND TG_TABLE_NAME<>'inventory_room_outputs'
  UNION ALL SELECT 'inventory_room_handoffs',organization_id,actor_id,device_id,request_payload,false FROM inventory_room_handoffs WHERE operation_id=NEW.operation_id AND TG_TABLE_NAME<>'inventory_room_handoffs'
  UNION ALL SELECT 'inventory_room_handoff_events',organization_id,actor_id,device_id,request_payload,false FROM inventory_room_handoff_events WHERE operation_id=NEW.operation_id AND TG_TABLE_NAME<>'inventory_room_handoff_events'
  UNION ALL SELECT 'inventory_coating_consumptions',organization_id,actor_id,device_id,request_payload,false FROM inventory_coating_consumptions WHERE operation_id=NEW.operation_id AND TG_TABLE_NAME<>'inventory_coating_consumptions'
  UNION ALL SELECT 'inventory_coating_allocations',organization_id,actor_id,device_id,request_payload,false FROM inventory_coating_allocations WHERE operation_id=NEW.operation_id AND TG_TABLE_NAME<>'inventory_coating_allocations'
  UNION ALL SELECT 'inventory_coating_foil_consumptions',organization_id,actor_id,device_id,request_payload,false FROM inventory_coating_foil_consumptions WHERE operation_id=NEW.operation_id AND TG_TABLE_NAME<>'inventory_coating_foil_consumptions'
 LOOP
  IF other.organization_id<>NEW.organization_id OR other.actor_id<>NEW.actor_id OR other.device_id IS DISTINCT FROM NEW.device_id OR other.request_payload<>NEW.request_payload OR other.stock_effect IS DISTINCT FROM true OR incoming_effect IS DISTINCT FROM true OR TG_TABLE_NAME<>'inventory_operations' AND other.owner<>'inventory_operations' THEN RAISE EXCEPTION 'operation_id_reused' USING ERRCODE='23505'; END IF;
 END LOOP;RETURN NEW;
END $$;
CREATE TRIGGER coating_foil_namespace BEFORE INSERT ON inventory_coating_foil_consumptions FOR EACH ROW EXECUTE FUNCTION enforce_inventory_issue_intent_id();
COMMIT;
