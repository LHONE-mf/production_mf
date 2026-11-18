-- Actual measured Calendaring length use settles received physical roll custody, never warehouse stock.
BEGIN;
CREATE TABLE inventory_calendaring_consumptions (
 operation_id uuid PRIMARY KEY,organization_id uuid NOT NULL,actor_id uuid NOT NULL,device_id uuid NOT NULL,
 production_batch_id uuid NOT NULL,step_number integer NOT NULL CHECK(step_number>0),
 material_id uuid NOT NULL,
 actual_length_mm bigint NOT NULL CHECK(actual_length_mm BETWEEN 1 AND 9007199254740991),
 epoch uuid NOT NULL,request_payload jsonb NOT NULL,result_payload jsonb NOT NULL,recorded_at timestamptz NOT NULL,
 stock_effect boolean GENERATED ALWAYS AS(false) STORED,
 UNIQUE(organization_id,operation_id),
 FOREIGN KEY(organization_id,actor_id) REFERENCES users(organization_id,id),
 FOREIGN KEY(organization_id,device_id) REFERENCES devices(organization_id,id),
 FOREIGN KEY(organization_id,production_batch_id) REFERENCES production_batches(organization_id,id),
 FOREIGN KEY(organization_id,material_id) REFERENCES inventory_materials(organization_id,id)
);
CREATE TABLE inventory_calendaring_allocations (
 operation_id uuid PRIMARY KEY,organization_id uuid NOT NULL,consumption_id uuid NOT NULL,receipt_id uuid NOT NULL,
 actor_id uuid NOT NULL,device_id uuid NOT NULL,quantity bigint NOT NULL CHECK(quantity BETWEEN 1 AND 9007199254740991),
 expected_revision bigint NOT NULL CHECK(expected_revision BETWEEN 1 AND 9007199254740990),
 source_snapshot jsonb NOT NULL,request_payload jsonb NOT NULL,
 stock_effect boolean GENERATED ALWAYS AS(false) STORED,
 UNIQUE(organization_id,consumption_id,receipt_id),
 FOREIGN KEY(organization_id,consumption_id) REFERENCES inventory_calendaring_consumptions(organization_id,operation_id),
 FOREIGN KEY(organization_id,receipt_id) REFERENCES inventory_room_handoff_events(organization_id,operation_id),
 FOREIGN KEY(organization_id,actor_id) REFERENCES users(organization_id,id),
 FOREIGN KEY(organization_id,device_id) REFERENCES devices(organization_id,id)
);
CREATE INDEX calendaring_allocation_source ON inventory_calendaring_allocations(organization_id,receipt_id);
CREATE TRIGGER calendaring_use_immutable BEFORE UPDATE OR DELETE ON inventory_calendaring_consumptions FOR EACH ROW EXECUTE FUNCTION forbid_inventory_operation_rewrite();
CREATE TRIGGER calendaring_allocation_immutable BEFORE UPDATE OR DELETE ON inventory_calendaring_allocations FOR EACH ROW EXECUTE FUNCTION forbid_inventory_operation_rewrite();

-- VOLATILE preserves the allocation guard within multi-row INSERT statements.
CREATE FUNCTION calendaring_roll_balance(org uuid,receipt uuid) RETURNS jsonb LANGUAGE sql VOLATILE AS $$
 SELECT jsonb_build_object('receipt',e.result_payload,'received',length_mm,'consumed',a.consumed,
  'remaining',length_mm-a.consumed,'revision',a.n+1,'capacityBasis','coating_measured_roll_length')
 FROM inventory_room_handoff_events e
 CROSS JOIN LATERAL(SELECT (e.result_payload->'sourceSnapshot'->'sourceSnapshot'->'roll'->>'measuredLengthMm')::bigint AS length_mm) measurement
 LEFT JOIN LATERAL(SELECT count(*) AS n,COALESCE(sum(quantity::numeric),0) AS consumed FROM inventory_calendaring_allocations WHERE organization_id=e.organization_id AND receipt_id=e.operation_id) a ON true
 WHERE e.organization_id=org AND e.operation_id=receipt AND e.kind='receive' AND e.result_payload->>'unit'='rolls' AND e.observed_quantity=1
$$;
CREATE FUNCTION calendaring_roll_eligible(org uuid,receipt uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT COALESCE(bool_and(e.kind='receive' AND e.observed_quantity=1 AND e.result_payload->>'unit'='rolls'
  AND b.status IN ('created','in_progress') AND o.status IN ('released','in_progress')
  AND s.stage='calendaring' AND s.workshop_id=h.recipient_workshop_id AND m.active AND m.base_unit='rolls' AND m.category='electrode'
  AND coating_roll_inputs_eligible(org,c.request_payload)),false)
 FROM inventory_room_handoff_events e JOIN inventory_room_handoffs h ON h.organization_id=e.organization_id AND h.operation_id=e.handoff_id
 JOIN inventory_room_output_lots l ON l.organization_id=h.organization_id AND l.id=h.output_lot_id
 JOIN inventory_coating_outputs c ON c.organization_id=l.organization_id AND c.operation_id=l.coating_declaration_id
 JOIN inventory_materials m ON m.organization_id=l.organization_id AND m.id=l.material_id
 JOIN production_batches b ON b.organization_id=h.organization_id AND b.id=h.production_batch_id
 JOIN production_orders o ON o.organization_id=b.organization_id AND o.id=b.order_id
 JOIN process_route_steps s ON s.organization_id=o.organization_id AND s.route_id=o.route_id AND s.route_version=o.route_version AND s.step_number=h.destination_step AND s.electrode_line=CASE WHEN b.material_line='cell' THEN 'common' ELSE b.material_line END
 WHERE e.organization_id=org AND e.operation_id=receipt
$$;
CREATE FUNCTION guard_calendaring_consumption() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE total numeric;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':inventory-sequence',0));
 IF NOT EXISTS(SELECT 1 FROM inventory_streams WHERE organization_id=NEW.organization_id AND epoch=NEW.epoch AND posting_enabled) THEN RAISE EXCEPTION 'inventory_epoch_changed'; END IF;
 IF NOT EXISTS(SELECT 1 FROM users u JOIN devices d ON d.organization_id=u.organization_id AND d.user_id=u.id AND d.id=NEW.device_id AND d.revoked_at IS NULL
  JOIN production_batches b ON b.organization_id=u.organization_id AND b.id=NEW.production_batch_id
  JOIN production_orders o ON o.organization_id=b.organization_id AND o.id=b.order_id
  JOIN process_route_steps s ON s.organization_id=o.organization_id AND s.route_id=o.route_id AND s.route_version=o.route_version AND s.step_number=NEW.step_number AND s.electrode_line=CASE WHEN b.material_line='cell' THEN 'common' ELSE b.material_line END
  WHERE u.organization_id=NEW.organization_id AND u.id=NEW.actor_id AND u.active AND s.stage='calendaring'
   AND b.status IN ('created','in_progress') AND o.status IN ('released','in_progress')
   AND (u.role='chief' OR EXISTS(SELECT 1 FROM user_workshop_memberships w WHERE w.organization_id=u.organization_id AND w.user_id=u.id AND w.workshop_id=s.workshop_id))) THEN RAISE EXCEPTION 'calendaring_consumption_authority_required'; END IF;
 SELECT sum((v->>'quantity')::numeric) INTO total FROM jsonb_array_elements(NEW.request_payload->'allocations') v;
 IF total IS DISTINCT FROM NEW.actual_length_mm::numeric OR COALESCE(jsonb_array_length(NEW.request_payload->'allocations'),0) NOT BETWEEN 1 AND 100
  OR NEW.request_payload->>'operationId' IS DISTINCT FROM NEW.operation_id::text OR NEW.request_payload->>'deviceId' IS DISTINCT FROM NEW.device_id::text
  OR NEW.request_payload->>'productionBatchId' IS DISTINCT FROM NEW.production_batch_id::text OR (NEW.request_payload->>'stepNumber')::numeric IS DISTINCT FROM NEW.step_number::numeric
  OR NEW.request_payload->>'materialId' IS DISTINCT FROM NEW.material_id::text OR (NEW.request_payload->>'actualLengthMm')::numeric IS DISTINCT FROM NEW.actual_length_mm::numeric
  OR COALESCE((NEW.request_payload->>'observedAt')::numeric,0)<=0
  OR COALESCE(length(trim(NEW.request_payload->>'reference')),0) NOT BETWEEN 1 AND 2000
  OR COALESCE(length(trim(NEW.request_payload->>'reason')),0) NOT BETWEEN 1 AND 2000
  OR COALESCE(length(trim(NEW.request_payload->>'evidence')),0) NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION 'calendaring_measured_length_required'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER calendaring_consumption_guard BEFORE INSERT ON inventory_calendaring_consumptions FOR EACH ROW EXECUTE FUNCTION guard_calendaring_consumption();
CREATE FUNCTION guard_calendaring_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c inventory_calendaring_consumptions%ROWTYPE;e inventory_room_handoff_events%ROWTYPE;h inventory_room_handoffs%ROWTYPE;balance jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':inventory-sequence',0));
 SELECT * INTO c FROM inventory_calendaring_consumptions WHERE organization_id=NEW.organization_id AND operation_id=NEW.consumption_id;
 SELECT * INTO e FROM inventory_room_handoff_events WHERE organization_id=NEW.organization_id AND operation_id=NEW.receipt_id AND kind='receive';
 SELECT * INTO h FROM inventory_room_handoffs WHERE organization_id=NEW.organization_id AND operation_id=e.handoff_id;
 IF c.operation_id IS NULL OR e.operation_id IS NULL OR NEW.actor_id<>c.actor_id OR NEW.device_id<>c.device_id OR NEW.request_payload IS DISTINCT FROM c.request_payload
  OR c.production_batch_id<>h.production_batch_id OR c.step_number<>h.destination_step
  OR NOT EXISTS(SELECT 1 FROM inventory_room_output_lots l WHERE l.organization_id=h.organization_id AND l.id=h.output_lot_id AND l.material_id=c.material_id AND l.unit='rolls')
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c.request_payload->'allocations') a WHERE a->>'operationId'=NEW.operation_id::text AND a->>'receiptId'=NEW.receipt_id::text AND (a->>'quantity')::numeric=NEW.quantity AND (a->>'expectedRevision')::numeric=NEW.expected_revision)
  THEN RAISE EXCEPTION 'calendaring_source_pair_required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM users u JOIN devices d ON d.organization_id=u.organization_id AND d.user_id=u.id AND d.id=NEW.device_id AND d.revoked_at IS NULL
  WHERE u.organization_id=NEW.organization_id AND u.id=NEW.actor_id AND u.active
  AND (u.role='chief' OR (u.id=h.recipient_id OR u.role='master') AND EXISTS(SELECT 1 FROM user_workshop_memberships w WHERE w.organization_id=u.organization_id AND w.user_id=u.id AND w.workshop_id=h.recipient_workshop_id)))
  OR NOT calendaring_roll_eligible(NEW.organization_id,NEW.receipt_id) THEN RAISE EXCEPTION 'calendaring_source_held'; END IF;
 balance:=calendaring_roll_balance(NEW.organization_id,NEW.receipt_id);
 IF NEW.expected_revision IS DISTINCT FROM (balance->>'revision')::bigint OR NEW.quantity>(balance->>'remaining')::numeric
  OR NEW.source_snapshot IS DISTINCT FROM balance THEN RAISE EXCEPTION 'calendaring_source_remaining_changed'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER calendaring_allocation_guard BEFORE INSERT ON inventory_calendaring_allocations FOR EACH ROW EXECUTE FUNCTION guard_calendaring_allocation();
CREATE FUNCTION require_calendaring_allocations() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sources jsonb;
BEGIN
 SELECT jsonb_agg(jsonb_build_object('allocationOperationId',a.operation_id,'source',a.source_snapshot) ORDER BY v.ordinality) INTO sources
 FROM jsonb_array_elements(NEW.request_payload->'allocations') WITH ORDINALITY v(item,ordinality)
 JOIN inventory_calendaring_allocations a ON a.organization_id=NEW.organization_id AND a.consumption_id=NEW.operation_id AND a.operation_id=(v.item->>'operationId')::uuid;
 IF (SELECT count(*) FROM inventory_calendaring_allocations WHERE organization_id=NEW.organization_id AND consumption_id=NEW.operation_id) IS DISTINCT FROM jsonb_array_length(NEW.request_payload->'allocations')::bigint
  OR NEW.result_payload IS DISTINCT FROM NEW.request_payload||jsonb_build_object('room','calendaring','unit','mm','actorId',NEW.actor_id,'recordedAt',NEW.result_payload->'recordedAt','sources',sources,'warehouseEffect','none')
  OR (NEW.result_payload->>'recordedAt')::timestamptz IS DISTINCT FROM NEW.recorded_at THEN RAISE EXCEPTION 'calendaring_allocation_pair_required'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER calendaring_consumption_pair AFTER INSERT ON inventory_calendaring_consumptions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_calendaring_allocations();
CREATE OR REPLACE FUNCTION enforce_inventory_issue_intent_id() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE other record;incoming_effect boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.operation_id::text,1));
 -- Generated columns are NULL in BEFORE INSERT triggers. Derive their effect
 -- explicitly so SQL three-valued logic cannot allow a zero-stock ID to pair.
 incoming_effect:=CASE
  WHEN TG_TABLE_NAME IN ('inventory_operations','inventory_output_acceptances') THEN true
  WHEN TG_TABLE_NAME IN ('inventory_output_submissions','inventory_cell_submissions','inventory_slurry_consumptions','inventory_room_outputs','inventory_room_handoffs','inventory_room_handoff_events','inventory_coating_consumptions','inventory_coating_allocations','inventory_coating_foil_consumptions','inventory_coating_outputs','inventory_calendaring_consumptions','inventory_calendaring_allocations') THEN false
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
  UNION ALL SELECT 'inventory_coating_outputs',organization_id,actor_id,device_id,request_payload,false FROM inventory_coating_outputs WHERE operation_id=NEW.operation_id AND TG_TABLE_NAME<>'inventory_coating_outputs'

  UNION ALL SELECT 'inventory_calendaring_consumptions',organization_id,actor_id,device_id,request_payload,false FROM inventory_calendaring_consumptions WHERE operation_id=NEW.operation_id AND TG_TABLE_NAME<>'inventory_calendaring_consumptions'
  UNION ALL SELECT 'inventory_calendaring_allocations',organization_id,actor_id,device_id,request_payload,false FROM inventory_calendaring_allocations WHERE operation_id=NEW.operation_id AND TG_TABLE_NAME<>'inventory_calendaring_allocations'
 LOOP
  IF other.organization_id<>NEW.organization_id OR other.actor_id<>NEW.actor_id OR other.device_id IS DISTINCT FROM NEW.device_id OR other.request_payload<>NEW.request_payload OR other.stock_effect IS DISTINCT FROM true OR incoming_effect IS DISTINCT FROM true OR TG_TABLE_NAME<>'inventory_operations' AND other.owner<>'inventory_operations' THEN RAISE EXCEPTION 'operation_id_reused' USING ERRCODE='23505'; END IF;
 END LOOP;RETURN NEW;
END $$;
CREATE TRIGGER calendaring_consumption_namespace BEFORE INSERT ON inventory_calendaring_consumptions FOR EACH ROW EXECUTE FUNCTION enforce_inventory_issue_intent_id();
CREATE TRIGGER calendaring_allocation_namespace BEFORE INSERT ON inventory_calendaring_allocations FOR EACH ROW EXECUTE FUNCTION enforce_inventory_issue_intent_id();
COMMIT;
