-- Physical Slurry output and reserved/acknowledged direct Coating custody.
-- No warehouse projection or historical manufacturing row is rewritten.
BEGIN;
CREATE TABLE inventory_room_outputs (
 operation_id uuid PRIMARY KEY, organization_id uuid NOT NULL, actor_id uuid NOT NULL, device_id uuid NOT NULL,
 consumption_id uuid NOT NULL REFERENCES inventory_slurry_consumptions(operation_id),
 production_batch_id uuid NOT NULL, step_number integer NOT NULL, room_id text NOT NULL CHECK(room_id='slurry'),
 input_quantity bigint NOT NULL CHECK(input_quantity BETWEEN 1 AND 9007199254740991),
 source_snapshot jsonb NOT NULL, epoch uuid NOT NULL, request_payload jsonb NOT NULL, result_payload jsonb NOT NULL,
 recorded_at timestamptz NOT NULL, stock_effect boolean GENERATED ALWAYS AS (false) STORED,
 UNIQUE(organization_id,operation_id), UNIQUE(organization_id,consumption_id),
 FOREIGN KEY(organization_id,actor_id) REFERENCES users(organization_id,id),
 FOREIGN KEY(organization_id,device_id) REFERENCES devices(organization_id,id),
 FOREIGN KEY(organization_id,production_batch_id) REFERENCES production_batches(organization_id,id)
);
CREATE TABLE inventory_room_output_lots (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, declaration_id uuid NOT NULL, material_id uuid NOT NULL,
 quantity bigint NOT NULL CHECK(quantity BETWEEN 1 AND 9007199254740991), unit text NOT NULL CHECK(unit='mg'),
 UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,declaration_id) REFERENCES inventory_room_outputs(organization_id,operation_id),
 FOREIGN KEY(organization_id,material_id) REFERENCES inventory_materials(organization_id,id)
);
CREATE TABLE inventory_room_handoffs (
 operation_id uuid PRIMARY KEY, organization_id uuid NOT NULL, output_lot_id uuid NOT NULL,
 actor_id uuid NOT NULL, device_id uuid NOT NULL, production_batch_id uuid NOT NULL,
 destination_step integer NOT NULL, recipient_id uuid NOT NULL, recipient_workshop_id text NOT NULL,
 quantity bigint NOT NULL CHECK(quantity BETWEEN 1 AND 9007199254740991),
 expected_revision bigint NOT NULL CHECK(expected_revision BETWEEN 1 AND 9007199254740990),
 output_snapshot jsonb NOT NULL, epoch uuid NOT NULL, request_payload jsonb NOT NULL, result_payload jsonb NOT NULL,
 recorded_at timestamptz NOT NULL, stock_effect boolean GENERATED ALWAYS AS (false) STORED,
 UNIQUE(organization_id,operation_id),
 FOREIGN KEY(organization_id,output_lot_id) REFERENCES inventory_room_output_lots(organization_id,id),
 FOREIGN KEY(organization_id,actor_id) REFERENCES users(organization_id,id),
 FOREIGN KEY(organization_id,device_id) REFERENCES devices(organization_id,id),
 FOREIGN KEY(organization_id,recipient_id) REFERENCES users(organization_id,id),
 FOREIGN KEY(organization_id,production_batch_id) REFERENCES production_batches(organization_id,id),
 FOREIGN KEY(organization_id,recipient_workshop_id) REFERENCES workshops(organization_id,id)
);
CREATE TABLE inventory_room_handoff_events (
 operation_id uuid PRIMARY KEY, organization_id uuid NOT NULL, handoff_id uuid NOT NULL,
 actor_id uuid NOT NULL, device_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('receive','discrepancy')),
 observed_quantity bigint CHECK(observed_quantity BETWEEN 0 AND 9007199254740991),
 epoch uuid NOT NULL, request_payload jsonb NOT NULL, result_payload jsonb NOT NULL, recorded_at timestamptz NOT NULL,
 stock_effect boolean GENERATED ALWAYS AS (false) STORED,
 CHECK(kind<>'receive' OR observed_quantity IS NOT NULL AND observed_quantity>0),
 FOREIGN KEY(organization_id,handoff_id) REFERENCES inventory_room_handoffs(organization_id,operation_id),
 FOREIGN KEY(organization_id,actor_id) REFERENCES users(organization_id,id),
 FOREIGN KEY(organization_id,device_id) REFERENCES devices(organization_id,id)
);
CREATE UNIQUE INDEX room_handoff_received_once ON inventory_room_handoff_events(organization_id,handoff_id) WHERE kind='receive';
CREATE INDEX room_handoff_source ON inventory_room_handoffs(organization_id,output_lot_id);
CREATE INDEX room_handoff_history ON inventory_room_handoff_events(organization_id,handoff_id,recorded_at);
CREATE TRIGGER room_output_immutable BEFORE UPDATE OR DELETE ON inventory_room_outputs FOR EACH ROW EXECUTE FUNCTION forbid_inventory_operation_rewrite();
CREATE TRIGGER room_output_lot_immutable BEFORE UPDATE OR DELETE ON inventory_room_output_lots FOR EACH ROW EXECUTE FUNCTION forbid_inventory_operation_rewrite();
CREATE TRIGGER room_handoff_immutable BEFORE UPDATE OR DELETE ON inventory_room_handoffs FOR EACH ROW EXECUTE FUNCTION forbid_inventory_operation_rewrite();
CREATE TRIGGER room_handoff_event_immutable BEFORE UPDATE OR DELETE ON inventory_room_handoff_events FOR EACH ROW EXECUTE FUNCTION forbid_inventory_operation_rewrite();

CREATE FUNCTION room_consumption_sources_eligible(org uuid,consumption uuid) RETURNS boolean LANGUAGE sql AS $$
 SELECT count(*)>0 AND COALESCE(bool_and(inventory_package_released(org,o.source_stock_id) AND ((i.source_snapshot->>'expiresAt') IS NULL OR (i.source_snapshot->>'expiresAt')::timestamptz>clock_timestamp())),false)
 FROM inventory_issue_outcomes o JOIN inventory_issues i ON i.organization_id=o.organization_id AND i.id=o.issue_id
 WHERE o.organization_id=org AND o.consumption_id=consumption AND o.kind='consume'
$$;
CREATE FUNCTION room_slurry_source_snapshot(org uuid,consumption uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('consumption',c.result_payload,'parents',(
  SELECT jsonb_agg(jsonb_build_object('issueId',o.issue_id,'sourceStockId',o.source_stock_id,'materialId',i.material_id,
   'manufacturerLot',i.source_snapshot->>'manufacturerLot','receiptOperationId',i.receipt_operation_id,
   'componentId',o.component_id,'quantity',o.quantity,'unit','mg','consumptionOperationId',o.operation_id) ORDER BY o.operation_id)
  FROM inventory_issue_outcomes o JOIN inventory_issues i ON i.organization_id=o.organization_id AND i.id=o.issue_id
  WHERE o.organization_id=org AND o.consumption_id=c.operation_id AND o.kind='consume'))
 FROM inventory_slurry_consumptions c WHERE c.organization_id=org AND c.operation_id=consumption
$$;
CREATE FUNCTION room_output_snapshot(org uuid,lot uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('id',l.id,'declarationId',d.operation_id,'materialId',l.material_id,'quantity',l.quantity,
  'unit','mg','consumptionId',d.consumption_id,'declaration',d.result_payload)
 FROM inventory_room_output_lots l JOIN inventory_room_outputs d ON d.organization_id=l.organization_id AND d.operation_id=l.declaration_id
 WHERE l.organization_id=org AND l.id=lot
$$;

CREATE FUNCTION guard_room_output() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c inventory_slurry_consumptions%ROWTYPE; u users%ROWTYPE; total numeric; outputs numeric; scrap numeric; loss numeric; unknown_mass numeric;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':inventory-sequence',0));
 SELECT * INTO c FROM inventory_slurry_consumptions WHERE organization_id=NEW.organization_id AND operation_id=NEW.consumption_id;
 SELECT * INTO u FROM users WHERE organization_id=NEW.organization_id AND id=NEW.actor_id AND active;
 IF c.operation_id IS NULL OR u.id IS NULL OR NOT EXISTS(SELECT 1 FROM devices WHERE organization_id=NEW.organization_id AND id=NEW.device_id AND user_id=u.id AND revoked_at IS NULL)
  OR c.production_batch_id<>NEW.production_batch_id OR c.step_number<>NEW.step_number
  OR NOT EXISTS(SELECT 1 FROM production_batches b JOIN production_orders o ON o.organization_id=b.organization_id AND o.id=b.order_id
   JOIN process_route_steps s ON s.organization_id=o.organization_id AND s.route_id=o.route_id AND s.route_version=o.route_version AND s.step_number=c.step_number AND s.electrode_line=CASE WHEN b.material_line='cell' THEN 'common' ELSE b.material_line END
   WHERE b.organization_id=NEW.organization_id AND b.id=c.production_batch_id AND b.status IN ('created','in_progress') AND o.status IN ('released','in_progress') AND s.stage='slurry'
   AND (u.role='chief' OR (u.id=c.actor_id OR u.role='master') AND EXISTS(SELECT 1 FROM user_workshop_memberships m WHERE m.organization_id=u.organization_id AND m.user_id=u.id AND m.workshop_id=s.workshop_id))) THEN RAISE EXCEPTION 'room_output_authority_required'; END IF;
 IF NOT room_consumption_sources_eligible(NEW.organization_id,c.operation_id) OR NEW.source_snapshot IS DISTINCT FROM room_slurry_source_snapshot(NEW.organization_id,c.operation_id) THEN RAISE EXCEPTION 'room_source_held'; END IF;
 SELECT sum((v->>'actualMg')::numeric) INTO total FROM jsonb_array_elements(c.request_payload->'source'->'components') v;
 SELECT sum((v->>'quantity')::numeric) INTO outputs FROM jsonb_array_elements(NEW.request_payload->'outputs') v;
 scrap:=(NEW.request_payload->>'scrapMg')::numeric;loss:=(NEW.request_payload->>'measuredLossMg')::numeric;unknown_mass:=(NEW.request_payload->>'unknownMg')::numeric;
 IF scrap IS NULL OR loss IS NULL OR unknown_mass IS NULL OR scrap<0 OR loss<0 OR unknown_mass<0 OR scrap<>trunc(scrap) OR loss<>trunc(loss) OR unknown_mass<>trunc(unknown_mass) OR greatest(scrap,loss,unknown_mass)>9007199254740991 OR total IS DISTINCT FROM NEW.input_quantity::numeric OR total IS DISTINCT FROM outputs+(NEW.request_payload->>'scrapMg')::numeric+(NEW.request_payload->>'measuredLossMg')::numeric+(NEW.request_payload->>'unknownMg')::numeric
  OR NEW.request_payload->>'basis' IS DISTINCT FROM 'weighed-slurry-mass'
  OR COALESCE(jsonb_array_length(NEW.request_payload->'outputs'),0) NOT BETWEEN 1 AND 100
  OR COALESCE(length(trim(NEW.request_payload->>'specificationReference')),0) NOT BETWEEN 1 AND 2000
  OR NEW.request_payload->>'operationId' IS DISTINCT FROM NEW.operation_id::text OR NEW.request_payload->>'deviceId' IS DISTINCT FROM NEW.device_id::text
  OR NEW.request_payload->>'consumptionId' IS DISTINCT FROM c.operation_id::text THEN RAISE EXCEPTION 'room_output_mass_balance_required'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER room_output_guard BEFORE INSERT ON inventory_room_outputs FOR EACH ROW EXECUTE FUNCTION guard_room_output();
CREATE FUNCTION guard_room_output_lot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM inventory_room_outputs d JOIN inventory_materials m ON m.organization_id=d.organization_id AND m.id=NEW.material_id
  WHERE d.organization_id=NEW.organization_id AND d.operation_id=NEW.declaration_id AND m.active AND m.base_unit='mg'
  AND EXISTS(SELECT 1 FROM jsonb_array_elements(d.request_payload->'outputs') v WHERE v->>'id'=NEW.id::text AND v->>'materialId'=NEW.material_id::text AND (v->>'quantity')::numeric=NEW.quantity)) THEN RAISE EXCEPTION 'room_output_lot_pair_required'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER room_output_lot_guard BEFORE INSERT ON inventory_room_output_lots FOR EACH ROW EXECUTE FUNCTION guard_room_output_lot();
CREATE FUNCTION require_room_output_lots() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (SELECT count(*) FROM inventory_room_output_lots WHERE organization_id=NEW.organization_id AND declaration_id=NEW.operation_id) IS DISTINCT FROM jsonb_array_length(NEW.request_payload->'outputs')::bigint
  OR NEW.result_payload->'source' IS DISTINCT FROM NEW.source_snapshot
  OR NEW.result_payload->'outputs' IS DISTINCT FROM NEW.request_payload->'outputs'
  OR NEW.result_payload IS DISTINCT FROM NEW.request_payload||jsonb_build_object('productionBatchId',NEW.production_batch_id,'stepNumber',NEW.step_number,'inputQuantity',NEW.input_quantity,'source',NEW.source_snapshot,'actorId',NEW.actor_id,'recordedAt',NEW.result_payload->'recordedAt','qualityStatus','unreviewed','warehouseEffect','none') OR (NEW.result_payload->>'recordedAt')::timestamptz IS DISTINCT FROM NEW.recorded_at THEN RAISE EXCEPTION 'room_output_lot_pair_required'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER room_output_pair AFTER INSERT ON inventory_room_outputs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_room_output_lots();

CREATE FUNCTION guard_room_handoff() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE l inventory_room_output_lots%ROWTYPE; d inventory_room_outputs%ROWTYPE; c inventory_slurry_consumptions%ROWTYPE; u users%ROWTYPE; n bigint; reserved numeric; target_workshop text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':inventory-sequence',0));
 SELECT * INTO l FROM inventory_room_output_lots WHERE organization_id=NEW.organization_id AND id=NEW.output_lot_id;
 SELECT * INTO d FROM inventory_room_outputs WHERE organization_id=NEW.organization_id AND operation_id=l.declaration_id;
 SELECT * INTO c FROM inventory_slurry_consumptions WHERE organization_id=NEW.organization_id AND operation_id=d.consumption_id;
 SELECT * INTO u FROM users WHERE organization_id=NEW.organization_id AND id=NEW.actor_id AND active;
 IF l.id IS NULL OR u.id IS NULL OR NOT EXISTS(SELECT 1 FROM devices WHERE organization_id=u.organization_id AND id=NEW.device_id AND user_id=u.id AND revoked_at IS NULL) THEN RAISE EXCEPTION 'room_handoff_authority_required'; END IF;
 SELECT s.workshop_id INTO target_workshop FROM production_batches b JOIN production_orders o ON o.organization_id=b.organization_id AND o.id=b.order_id
 JOIN process_route_steps s ON s.organization_id=o.organization_id AND s.route_id=o.route_id AND s.route_version=o.route_version AND s.step_number=NEW.destination_step AND s.electrode_line=CASE WHEN b.material_line='cell' THEN 'common' ELSE b.material_line END
 WHERE b.organization_id=NEW.organization_id AND b.id=d.production_batch_id AND b.status IN ('created','in_progress') AND o.status IN ('released','in_progress') AND s.stage='coating'
 AND s.step_number=(SELECT min(p.step_number) FROM process_route_steps p WHERE p.organization_id=s.organization_id AND p.route_id=s.route_id AND p.route_version=s.route_version AND p.electrode_line=s.electrode_line AND p.step_number>d.step_number)
 AND (u.role='chief' OR (u.id=c.actor_id OR u.role='master') AND EXISTS(SELECT 1 FROM process_route_steps p JOIN user_workshop_memberships m ON m.organization_id=p.organization_id AND m.workshop_id=p.workshop_id AND m.user_id=u.id WHERE p.organization_id=s.organization_id AND p.route_id=s.route_id AND p.route_version=s.route_version AND p.step_number=d.step_number AND p.electrode_line=s.electrode_line));
 IF target_workshop IS NULL OR target_workshop<>NEW.recipient_workshop_id OR NEW.production_batch_id<>d.production_batch_id
 OR NOT EXISTS(SELECT 1 FROM user_workshop_memberships m JOIN users r ON r.organization_id=m.organization_id AND r.id=m.user_id AND r.active WHERE m.organization_id=NEW.organization_id AND m.user_id=NEW.recipient_id AND m.workshop_id=target_workshop) THEN RAISE EXCEPTION 'room_handoff_route_or_recipient_required'; END IF;
 IF NOT room_consumption_sources_eligible(NEW.organization_id,d.consumption_id) OR NOT EXISTS(SELECT 1 FROM inventory_materials WHERE organization_id=NEW.organization_id AND id=l.material_id AND active AND base_unit='mg') THEN RAISE EXCEPTION 'room_source_held'; END IF;
 SELECT count(*),COALESCE(sum(quantity::numeric),0) INTO n,reserved FROM inventory_room_handoffs WHERE organization_id=NEW.organization_id AND output_lot_id=l.id;
 IF NEW.expected_revision<>n+1 OR NEW.quantity>l.quantity-reserved THEN RAISE EXCEPTION 'room_output_remaining_changed'; END IF;
 IF NEW.output_snapshot IS DISTINCT FROM room_output_snapshot(NEW.organization_id,l.id)
 OR NEW.request_payload->>'operationId' IS DISTINCT FROM NEW.operation_id::text OR NEW.request_payload->>'deviceId' IS DISTINCT FROM NEW.device_id::text
 OR NEW.request_payload->>'outputLotId' IS DISTINCT FROM l.id::text OR (NEW.request_payload->>'quantity')::numeric IS DISTINCT FROM NEW.quantity::numeric
 OR NEW.request_payload->>'recipientId' IS DISTINCT FROM NEW.recipient_id::text OR (NEW.request_payload->>'expectedSourceRevision')::numeric IS DISTINCT FROM NEW.expected_revision::numeric
 OR (NEW.request_payload->>'destinationStepNumber')::integer IS DISTINCT FROM NEW.destination_step OR NEW.result_payload IS DISTINCT FROM NEW.request_payload||jsonb_build_object('productionBatchId',NEW.production_batch_id,'sourceRoom','slurry','destinationRoom','coating','recipientWorkshopId',NEW.recipient_workshop_id,'sourceSnapshot',NEW.output_snapshot,'actorId',NEW.actor_id,'recordedAt',NEW.result_payload->'recordedAt','unit','mg','warehouseEffect','none') OR (NEW.result_payload->>'recordedAt')::timestamptz IS DISTINCT FROM NEW.recorded_at THEN RAISE EXCEPTION 'room_handoff_snapshot_required'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER room_handoff_guard BEFORE INSERT ON inventory_room_handoffs FOR EACH ROW EXECUTE FUNCTION guard_room_handoff();
CREATE FUNCTION guard_room_handoff_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h inventory_room_handoffs%ROWTYPE; consumption uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':inventory-sequence',0));
 SELECT * INTO h FROM inventory_room_handoffs WHERE organization_id=NEW.organization_id AND operation_id=NEW.handoff_id;
 IF h.operation_id IS NULL OR h.recipient_id<>NEW.actor_id OR NOT EXISTS(SELECT 1 FROM users u JOIN devices d ON d.organization_id=u.organization_id AND d.user_id=u.id AND d.id=NEW.device_id AND d.revoked_at IS NULL JOIN user_workshop_memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id WHERE u.organization_id=NEW.organization_id AND u.id=NEW.actor_id AND u.active AND m.workshop_id=h.recipient_workshop_id) THEN RAISE EXCEPTION 'room_receiver_required'; END IF;
 IF EXISTS(SELECT 1 FROM inventory_room_handoff_events WHERE organization_id=NEW.organization_id AND handoff_id=h.operation_id AND kind='receive') THEN RAISE EXCEPTION 'room_handoff_already_received'; END IF;
 SELECT d.consumption_id INTO consumption FROM inventory_room_output_lots l JOIN inventory_room_outputs d ON d.organization_id=l.organization_id AND d.operation_id=l.declaration_id WHERE l.organization_id=NEW.organization_id AND l.id=h.output_lot_id;
 IF NEW.kind='receive' AND (NOT EXISTS(SELECT 1 FROM production_batches b JOIN production_orders o ON o.organization_id=b.organization_id AND o.id=b.order_id WHERE b.organization_id=NEW.organization_id AND b.id=h.production_batch_id AND b.status IN ('created','in_progress') AND o.status IN ('released','in_progress')) OR NEW.observed_quantity IS DISTINCT FROM h.quantity OR NOT room_consumption_sources_eligible(NEW.organization_id,consumption)
  OR NOT EXISTS(SELECT 1 FROM inventory_room_output_lots l JOIN inventory_materials m ON m.organization_id=l.organization_id AND m.id=l.material_id WHERE l.organization_id=NEW.organization_id AND l.id=h.output_lot_id AND m.active)) THEN RAISE EXCEPTION 'room_receipt_quantity_or_hold'; END IF;
 IF NEW.request_payload->>'operationId' IS DISTINCT FROM NEW.operation_id::text OR NEW.request_payload->>'deviceId' IS DISTINCT FROM NEW.device_id::text OR NEW.request_payload->>'handoffId' IS DISTINCT FROM h.operation_id::text
 OR NEW.request_payload->>'kind' IS DISTINCT FROM NEW.kind OR (NEW.request_payload->>'observedQuantity')::numeric IS DISTINCT FROM NEW.observed_quantity::numeric
 OR NEW.result_payload IS DISTINCT FROM NEW.request_payload||jsonb_build_object('sourceSnapshot',h.result_payload,'actorId',NEW.actor_id,'recordedAt',NEW.result_payload->'recordedAt','custodyEffect',CASE WHEN NEW.kind='receive' THEN 'received' ELSE 'none' END,'unit','mg','warehouseEffect','none') OR (NEW.result_payload->>'recordedAt')::timestamptz IS DISTINCT FROM NEW.recorded_at THEN RAISE EXCEPTION 'room_receipt_snapshot_required'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER room_handoff_event_guard BEFORE INSERT ON inventory_room_handoff_events FOR EACH ROW EXECUTE FUNCTION guard_room_handoff_event();
-- Shared operation-ID namespace is extended below; all these events have zero warehouse effect.
CREATE OR REPLACE FUNCTION enforce_inventory_issue_intent_id() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE other record;incoming_effect boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.operation_id::text,1));
 -- Generated columns are NULL in BEFORE INSERT triggers. Derive their effect
 -- explicitly so SQL three-valued logic cannot allow a zero-stock ID to pair.
 incoming_effect:=CASE
  WHEN TG_TABLE_NAME IN ('inventory_operations','inventory_output_acceptances') THEN true
  WHEN TG_TABLE_NAME IN ('inventory_output_submissions','inventory_cell_submissions','inventory_slurry_consumptions','inventory_room_outputs','inventory_room_handoffs','inventory_room_handoff_events') THEN false
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
 LOOP
  IF other.organization_id<>NEW.organization_id OR other.actor_id<>NEW.actor_id OR other.device_id IS DISTINCT FROM NEW.device_id OR other.request_payload<>NEW.request_payload OR other.stock_effect IS DISTINCT FROM true OR incoming_effect IS DISTINCT FROM true OR TG_TABLE_NAME<>'inventory_operations' AND other.owner<>'inventory_operations' THEN RAISE EXCEPTION 'operation_id_reused' USING ERRCODE='23505'; END IF;
 END LOOP;RETURN NEW;
END $$;
CREATE TRIGGER inventory_room_outputs_namespace BEFORE INSERT ON inventory_room_outputs FOR EACH ROW EXECUTE FUNCTION enforce_inventory_issue_intent_id();
CREATE TRIGGER inventory_room_handoffs_namespace BEFORE INSERT ON inventory_room_handoffs FOR EACH ROW EXECUTE FUNCTION enforce_inventory_issue_intent_id();
CREATE TRIGGER inventory_room_handoff_events_namespace BEFORE INSERT ON inventory_room_handoff_events FOR EACH ROW EXECUTE FUNCTION enforce_inventory_issue_intent_id();
COMMIT;
