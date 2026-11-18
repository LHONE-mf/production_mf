-- Actual measured Coating use settles received Slurry custody, never warehouse stock.
BEGIN;
CREATE TABLE inventory_coating_consumptions (
 operation_id uuid PRIMARY KEY,organization_id uuid NOT NULL,actor_id uuid NOT NULL,device_id uuid NOT NULL,
 production_batch_id uuid NOT NULL,step_number integer NOT NULL CHECK(step_number>0),
 actual_mg bigint NOT NULL CHECK(actual_mg BETWEEN 1 AND 9007199254740991),
 epoch uuid NOT NULL,request_payload jsonb NOT NULL,result_payload jsonb NOT NULL,recorded_at timestamptz NOT NULL,
 stock_effect boolean GENERATED ALWAYS AS(false) STORED,
 UNIQUE(organization_id,operation_id),
 FOREIGN KEY(organization_id,actor_id) REFERENCES users(organization_id,id),
 FOREIGN KEY(organization_id,device_id) REFERENCES devices(organization_id,id),
 FOREIGN KEY(organization_id,production_batch_id) REFERENCES production_batches(organization_id,id)
);
CREATE UNIQUE INDEX room_receipt_identity ON inventory_room_handoff_events(organization_id,operation_id);
CREATE TABLE inventory_coating_allocations (
 operation_id uuid PRIMARY KEY,organization_id uuid NOT NULL,consumption_id uuid NOT NULL,receipt_id uuid NOT NULL,
 actor_id uuid NOT NULL,device_id uuid NOT NULL,quantity bigint NOT NULL CHECK(quantity BETWEEN 1 AND 9007199254740991),
 expected_revision bigint NOT NULL CHECK(expected_revision BETWEEN 1 AND 9007199254740990),
 source_snapshot jsonb NOT NULL,request_payload jsonb NOT NULL,
 stock_effect boolean GENERATED ALWAYS AS(false) STORED,
 UNIQUE(organization_id,consumption_id,receipt_id),
 FOREIGN KEY(organization_id,consumption_id) REFERENCES inventory_coating_consumptions(organization_id,operation_id),
 FOREIGN KEY(organization_id,receipt_id) REFERENCES inventory_room_handoff_events(organization_id,operation_id),
 FOREIGN KEY(organization_id,actor_id) REFERENCES users(organization_id,id),
 FOREIGN KEY(organization_id,device_id) REFERENCES devices(organization_id,id)
);
CREATE INDEX coating_allocation_source ON inventory_coating_allocations(organization_id,receipt_id);
CREATE TRIGGER coating_use_immutable BEFORE UPDATE OR DELETE ON inventory_coating_consumptions FOR EACH ROW EXECUTE FUNCTION forbid_inventory_operation_rewrite();
CREATE TRIGGER coating_allocation_immutable BEFORE UPDATE OR DELETE ON inventory_coating_allocations FOR EACH ROW EXECUTE FUNCTION forbid_inventory_operation_rewrite();

-- VOLATILE preserves the allocation guard within multi-row INSERT statements.
CREATE FUNCTION coating_slurry_balance(org uuid,receipt uuid) RETURNS jsonb LANGUAGE sql VOLATILE AS $$
 SELECT jsonb_build_object('receipt',e.result_payload,'received',e.observed_quantity,'consumed',a.consumed,
  'remaining',e.observed_quantity-a.consumed,'revision',a.n+1)
 FROM inventory_room_handoff_events e LEFT JOIN LATERAL(
  SELECT count(*) AS n,COALESCE(sum(quantity::numeric),0) AS consumed FROM inventory_coating_allocations
  WHERE organization_id=e.organization_id AND receipt_id=e.operation_id) a ON true
 WHERE e.organization_id=org AND e.operation_id=receipt AND e.kind='receive'
$$;
CREATE FUNCTION coating_slurry_eligible(org uuid,receipt uuid) RETURNS boolean LANGUAGE sql AS $$
 SELECT COALESCE(bool_and(e.kind='receive' AND b.status IN ('created','in_progress') AND o.status IN ('released','in_progress')
  AND m.active AND m.base_unit='mg' AND room_consumption_sources_eligible(org,(h.output_snapshot->>'consumptionId')::uuid)),false)
 FROM inventory_room_handoff_events e JOIN inventory_room_handoffs h ON h.organization_id=e.organization_id AND h.operation_id=e.handoff_id
 JOIN inventory_room_output_lots l ON l.organization_id=h.organization_id AND l.id=h.output_lot_id
 JOIN inventory_materials m ON m.organization_id=l.organization_id AND m.id=l.material_id
 JOIN production_batches b ON b.organization_id=h.organization_id AND b.id=h.production_batch_id
 JOIN production_orders o ON o.organization_id=b.organization_id AND o.id=b.order_id
 WHERE e.organization_id=org AND e.operation_id=receipt
$$;
CREATE FUNCTION guard_coating_consumption() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE total numeric;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':inventory-sequence',0));
 IF NOT EXISTS(SELECT 1 FROM users u JOIN devices d ON d.organization_id=u.organization_id AND d.user_id=u.id AND d.id=NEW.device_id AND d.revoked_at IS NULL
  JOIN production_batches b ON b.organization_id=u.organization_id AND b.id=NEW.production_batch_id
  JOIN production_orders o ON o.organization_id=b.organization_id AND o.id=b.order_id
  JOIN process_route_steps s ON s.organization_id=o.organization_id AND s.route_id=o.route_id AND s.route_version=o.route_version AND s.step_number=NEW.step_number AND s.electrode_line=CASE WHEN b.material_line='cell' THEN 'common' ELSE b.material_line END
  WHERE u.organization_id=NEW.organization_id AND u.id=NEW.actor_id AND u.active AND s.stage='coating'
   AND b.status IN ('created','in_progress') AND o.status IN ('released','in_progress')
   AND (u.role='chief' OR EXISTS(SELECT 1 FROM user_workshop_memberships w WHERE w.organization_id=u.organization_id AND w.user_id=u.id AND w.workshop_id=s.workshop_id))) THEN RAISE EXCEPTION 'coating_consumption_authority_required'; END IF;
 SELECT sum((v->>'quantity')::numeric) INTO total FROM jsonb_array_elements(NEW.request_payload->'allocations') v;
 IF total IS DISTINCT FROM NEW.actual_mg::numeric OR COALESCE(jsonb_array_length(NEW.request_payload->'allocations'),0) NOT BETWEEN 1 AND 100
  OR NEW.request_payload->>'operationId' IS DISTINCT FROM NEW.operation_id::text OR NEW.request_payload->>'deviceId' IS DISTINCT FROM NEW.device_id::text
  OR NEW.request_payload->>'productionBatchId' IS DISTINCT FROM NEW.production_batch_id::text OR (NEW.request_payload->>'stepNumber')::numeric IS DISTINCT FROM NEW.step_number::numeric
  OR (NEW.request_payload->>'actualMg')::numeric IS DISTINCT FROM NEW.actual_mg::numeric
  OR COALESCE((NEW.request_payload->>'observedAt')::numeric,0)<=0
  OR COALESCE(length(trim(NEW.request_payload->>'reference')),0) NOT BETWEEN 1 AND 2000
  OR COALESCE(length(trim(NEW.request_payload->>'reason')),0) NOT BETWEEN 1 AND 2000
  OR COALESCE(length(trim(NEW.request_payload->>'evidence')),0) NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION 'coating_measured_mass_required'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER coating_consumption_guard BEFORE INSERT ON inventory_coating_consumptions FOR EACH ROW EXECUTE FUNCTION guard_coating_consumption();
CREATE FUNCTION guard_coating_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c inventory_coating_consumptions%ROWTYPE;e inventory_room_handoff_events%ROWTYPE;h inventory_room_handoffs%ROWTYPE;balance jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':inventory-sequence',0));
 SELECT * INTO c FROM inventory_coating_consumptions WHERE organization_id=NEW.organization_id AND operation_id=NEW.consumption_id;
 SELECT * INTO e FROM inventory_room_handoff_events WHERE organization_id=NEW.organization_id AND operation_id=NEW.receipt_id AND kind='receive';
 SELECT * INTO h FROM inventory_room_handoffs WHERE organization_id=NEW.organization_id AND operation_id=e.handoff_id;
 IF c.operation_id IS NULL OR e.operation_id IS NULL OR NEW.actor_id<>c.actor_id OR NEW.device_id<>c.device_id OR NEW.request_payload IS DISTINCT FROM c.request_payload
  OR c.production_batch_id<>h.production_batch_id OR c.step_number<>h.destination_step
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c.request_payload->'allocations') a WHERE a->>'operationId'=NEW.operation_id::text AND a->>'receiptId'=NEW.receipt_id::text AND (a->>'quantity')::numeric=NEW.quantity AND (a->>'expectedRevision')::numeric=NEW.expected_revision)
  THEN RAISE EXCEPTION 'coating_source_pair_required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM users u JOIN devices d ON d.organization_id=u.organization_id AND d.user_id=u.id AND d.id=NEW.device_id AND d.revoked_at IS NULL
  WHERE u.organization_id=NEW.organization_id AND u.id=NEW.actor_id AND u.active
  AND (u.role='chief' OR (u.id=h.recipient_id OR u.role='master') AND EXISTS(SELECT 1 FROM user_workshop_memberships w WHERE w.organization_id=u.organization_id AND w.user_id=u.id AND w.workshop_id=h.recipient_workshop_id)))
  OR NOT coating_slurry_eligible(NEW.organization_id,NEW.receipt_id) THEN RAISE EXCEPTION 'coating_source_held'; END IF;
 balance:=coating_slurry_balance(NEW.organization_id,NEW.receipt_id);
 IF NEW.expected_revision IS DISTINCT FROM (balance->>'revision')::bigint OR NEW.quantity>(balance->>'remaining')::numeric
  OR NEW.source_snapshot IS DISTINCT FROM balance THEN RAISE EXCEPTION 'coating_source_remaining_changed'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER coating_allocation_guard BEFORE INSERT ON inventory_coating_allocations FOR EACH ROW EXECUTE FUNCTION guard_coating_allocation();
CREATE FUNCTION require_coating_allocations() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sources jsonb;
BEGIN
 SELECT jsonb_agg(jsonb_build_object('allocationOperationId',a.operation_id,'source',a.source_snapshot) ORDER BY v.ordinality) INTO sources
 FROM jsonb_array_elements(NEW.request_payload->'allocations') WITH ORDINALITY v(item,ordinality)
 JOIN inventory_coating_allocations a ON a.organization_id=NEW.organization_id AND a.consumption_id=NEW.operation_id AND a.operation_id=(v.item->>'operationId')::uuid;
 IF (SELECT count(*) FROM inventory_coating_allocations WHERE organization_id=NEW.organization_id AND consumption_id=NEW.operation_id) IS DISTINCT FROM jsonb_array_length(NEW.request_payload->'allocations')::bigint
  OR NEW.result_payload IS DISTINCT FROM NEW.request_payload||jsonb_build_object('room','coating','unit','mg','actorId',NEW.actor_id,'recordedAt',NEW.result_payload->'recordedAt','sources',sources,'warehouseEffect','none')
  OR (NEW.result_payload->>'recordedAt')::timestamptz IS DISTINCT FROM NEW.recorded_at THEN RAISE EXCEPTION 'coating_allocation_pair_required'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER coating_consumption_pair AFTER INSERT ON inventory_coating_consumptions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_coating_allocations();
CREATE OR REPLACE FUNCTION enforce_inventory_issue_intent_id() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE other record;incoming_effect boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.operation_id::text,1));
 -- Generated columns are NULL in BEFORE INSERT triggers. Derive their effect
 -- explicitly so SQL three-valued logic cannot allow a zero-stock ID to pair.
 incoming_effect:=CASE
  WHEN TG_TABLE_NAME IN ('inventory_operations','inventory_output_acceptances') THEN true
  WHEN TG_TABLE_NAME IN ('inventory_output_submissions','inventory_cell_submissions','inventory_slurry_consumptions','inventory_room_outputs','inventory_room_handoffs','inventory_room_handoff_events','inventory_coating_consumptions','inventory_coating_allocations') THEN false
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
 LOOP
  IF other.organization_id<>NEW.organization_id OR other.actor_id<>NEW.actor_id OR other.device_id IS DISTINCT FROM NEW.device_id OR other.request_payload<>NEW.request_payload OR other.stock_effect IS DISTINCT FROM true OR incoming_effect IS DISTINCT FROM true OR TG_TABLE_NAME<>'inventory_operations' AND other.owner<>'inventory_operations' THEN RAISE EXCEPTION 'operation_id_reused' USING ERRCODE='23505'; END IF;
 END LOOP;RETURN NEW;
END $$;
CREATE TRIGGER inventory_coating_consumptions_namespace BEFORE INSERT ON inventory_coating_consumptions FOR EACH ROW EXECUTE FUNCTION enforce_inventory_issue_intent_id();
CREATE TRIGGER inventory_coating_allocations_namespace BEFORE INSERT ON inventory_coating_allocations FOR EACH ROW EXECUTE FUNCTION enforce_inventory_issue_intent_id();
COMMIT;
