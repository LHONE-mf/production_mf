-- Measured calendered output links actual Calendaring inputs once per declaration.
BEGIN;
CREATE TABLE inventory_calendaring_outputs (
 operation_id uuid PRIMARY KEY,organization_id uuid NOT NULL,actor_id uuid NOT NULL,device_id uuid NOT NULL,
 production_batch_id uuid NOT NULL,step_number integer NOT NULL CHECK(step_number>0),epoch uuid NOT NULL,
 source_snapshot jsonb NOT NULL,request_payload jsonb NOT NULL,result_payload jsonb NOT NULL,recorded_at timestamptz NOT NULL,
 stock_effect boolean GENERATED ALWAYS AS(false) STORED,UNIQUE(organization_id,operation_id),
 FOREIGN KEY(organization_id,actor_id) REFERENCES users(organization_id,id),
 FOREIGN KEY(organization_id,device_id) REFERENCES devices(organization_id,id),
 FOREIGN KEY(organization_id,production_batch_id) REFERENCES production_batches(organization_id,id)
);
CREATE TABLE inventory_calendaring_output_claims (
 organization_id uuid NOT NULL,declaration_id uuid NOT NULL,calendaring_consumption_id uuid NOT NULL,
 UNIQUE(organization_id,calendaring_consumption_id),
 FOREIGN KEY(organization_id,declaration_id) REFERENCES inventory_calendaring_outputs(organization_id,operation_id),
 FOREIGN KEY(organization_id,calendaring_consumption_id) REFERENCES inventory_calendaring_consumptions(organization_id,operation_id)
);
CREATE INDEX calendaring_output_claim_parent ON inventory_calendaring_output_claims(organization_id,declaration_id);
CREATE TRIGGER calendaring_output_immutable BEFORE UPDATE OR DELETE ON inventory_calendaring_outputs FOR EACH ROW EXECUTE FUNCTION forbid_inventory_operation_rewrite();
CREATE TRIGGER calendaring_output_claim_immutable BEFORE UPDATE OR DELETE ON inventory_calendaring_output_claims FOR EACH ROW EXECUTE FUNCTION forbid_inventory_operation_rewrite();
ALTER TABLE inventory_room_output_lots ADD COLUMN calendaring_declaration_id uuid;
ALTER TABLE inventory_room_output_lots ADD FOREIGN KEY(organization_id,calendaring_declaration_id) REFERENCES inventory_calendaring_outputs(organization_id,operation_id);
CREATE INDEX room_output_calendaring_parent ON inventory_room_output_lots(organization_id,calendaring_declaration_id) WHERE calendaring_declaration_id IS NOT NULL;
ALTER TABLE inventory_room_output_lots DROP CONSTRAINT room_output_lot_origin;
ALTER TABLE inventory_room_output_lots ADD CONSTRAINT room_output_lot_origin CHECK(
 (unit='mg' AND declaration_id IS NOT NULL AND coating_declaration_id IS NULL AND calendaring_declaration_id IS NULL) OR
 (unit='rolls' AND quantity=1 AND declaration_id IS NULL AND ((coating_declaration_id IS NOT NULL AND calendaring_declaration_id IS NULL) OR (coating_declaration_id IS NULL AND calendaring_declaration_id IS NOT NULL))));
CREATE FUNCTION calendered_roll_sources(org uuid,request jsonb) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT COALESCE(jsonb_agg(c.result_payload ORDER BY a.n),'[]'::jsonb) FROM jsonb_array_elements_text(request->'consumptionIds') WITH ORDINALITY a(id,n) JOIN inventory_calendaring_consumptions c ON c.organization_id=org AND c.operation_id=a.id::uuid
$$;
CREATE FUNCTION calendered_roll_input_eligible(org uuid,source uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT count(*)>0 AND COALESCE(bool_and(calendaring_roll_eligible(org,a.receipt_id)),false) FROM inventory_calendaring_allocations a WHERE a.organization_id=org AND a.consumption_id=source
$$;
CREATE FUNCTION calendered_roll_inputs_eligible(org uuid,request jsonb) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT count(*)=jsonb_array_length(request->'consumptionIds') AND COALESCE(bool_and(calendered_roll_input_eligible(org,c.operation_id)),false) FROM inventory_calendaring_consumptions c WHERE c.organization_id=org AND c.operation_id IN(SELECT value::uuid FROM jsonb_array_elements_text(request->'consumptionIds'))
$$;
CREATE FUNCTION guard_calendered_roll_output() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item jsonb; source inventory_calendaring_consumptions; input_material uuid; origin text; workshop text; source_ids jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':inventory-sequence',0));
 IF NOT EXISTS(SELECT 1 FROM inventory_streams WHERE organization_id=NEW.organization_id AND epoch=NEW.epoch AND posting_enabled) THEN RAISE EXCEPTION 'inventory_epoch_changed'; END IF;
 SELECT s.workshop_id INTO workshop FROM production_batches b JOIN production_orders o ON o.organization_id=b.organization_id AND o.id=b.order_id
 JOIN process_route_steps s ON s.organization_id=o.organization_id AND s.route_id=o.route_id AND s.route_version=o.route_version AND s.step_number=NEW.step_number AND s.electrode_line=CASE WHEN b.material_line='cell' THEN 'common' ELSE b.material_line END
 JOIN users u ON u.organization_id=b.organization_id AND u.id=NEW.actor_id AND u.active
 JOIN devices d ON d.organization_id=u.organization_id AND d.user_id=u.id AND d.id=NEW.device_id AND d.revoked_at IS NULL
 WHERE b.organization_id=NEW.organization_id AND b.id=NEW.production_batch_id AND b.status IN ('created','in_progress') AND o.status IN ('released','in_progress') AND s.stage='calendaring'
 AND (u.role='chief' OR EXISTS(SELECT 1 FROM user_workshop_memberships w WHERE w.organization_id=u.organization_id AND w.user_id=u.id AND w.workshop_id=s.workshop_id));
 IF workshop IS NULL THEN RAISE EXCEPTION 'calendered_output_authority_required'; END IF;
 source_ids:=NEW.request_payload->'consumptionIds';
 IF jsonb_typeof(source_ids) IS DISTINCT FROM 'array' OR jsonb_array_length(source_ids) NOT BETWEEN 1 AND 100 OR (SELECT count(DISTINCT value) FROM jsonb_array_elements_text(source_ids))<>jsonb_array_length(source_ids) THEN RAISE EXCEPTION 'calendered_output_inputs_required'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(source_ids) LOOP
  SELECT * INTO source FROM inventory_calendaring_consumptions WHERE organization_id=NEW.organization_id AND operation_id=(item#>>'{}')::uuid;
  IF source.operation_id IS NULL OR source.production_batch_id IS DISTINCT FROM NEW.production_batch_id OR source.step_number IS DISTINCT FROM NEW.step_number OR (input_material IS NOT NULL AND source.material_id IS DISTINCT FROM input_material) OR NOT EXISTS(SELECT 1 FROM users u WHERE u.organization_id=NEW.organization_id AND u.id=NEW.actor_id AND (u.id=source.actor_id OR u.role IN ('chief','master'))) THEN RAISE EXCEPTION 'calendered_output_inputs_required'; END IF;
  input_material:=source.material_id;
 END LOOP;
 IF NOT calendered_roll_inputs_eligible(NEW.organization_id,NEW.request_payload) OR NEW.source_snapshot IS DISTINCT FROM calendered_roll_sources(NEW.organization_id,NEW.request_payload) THEN RAISE EXCEPTION 'calendered_output_source_held'; END IF;
 IF jsonb_typeof(NEW.request_payload->'outputs') IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.request_payload->'outputs') NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'measured_rolls_required'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(NEW.request_payload->'outputs') LOOP
  IF NOT COALESCE((item->>'measuredLengthMm')::numeric BETWEEN 1 AND 9007199254740991 AND (item->>'measuredLengthMm')::numeric=trunc((item->>'measuredLengthMm')::numeric),false)
  OR jsonb_typeof(item->'label') IS DISTINCT FROM 'string' OR NOT COALESCE(length(btrim(item->>'label')) BETWEEN 1 AND 200,false) OR NOT COALESCE(item->>'disposition' IN ('ready','held'),false) OR NOT(item ? 'measuredMassMg')
  OR (item->'measuredMassMg'<>'null'::jsonb AND NOT COALESCE((item->>'measuredMassMg')::numeric BETWEEN 1 AND 9007199254740991 AND (item->>'measuredMassMg')::numeric=trunc((item->>'measuredMassMg')::numeric),false)) THEN RAISE EXCEPTION 'measured_rolls_required'; END IF;
 END LOOP;
 FOREACH origin IN ARRAY ARRAY['scrapLengthMm','scrapMassMg'] LOOP
  IF NOT(NEW.request_payload ? origin) OR (NEW.request_payload->origin<>'null'::jsonb AND NOT COALESCE((NEW.request_payload->>origin)::numeric BETWEEN 0 AND 9007199254740991 AND (NEW.request_payload->>origin)::numeric=trunc((NEW.request_payload->>origin)::numeric),false)) THEN RAISE EXCEPTION 'calendered_scrap_observation_required'; END IF;
 END LOOP;
 IF NEW.request_payload->>'operationId' IS DISTINCT FROM NEW.operation_id::text OR NEW.request_payload->>'deviceId' IS DISTINCT FROM NEW.device_id::text OR NEW.request_payload->>'productionBatchId' IS DISTINCT FROM NEW.production_batch_id::text OR (NEW.request_payload->>'stepNumber')::integer IS DISTINCT FROM NEW.step_number
 OR NOT COALESCE(length(btrim(NEW.request_payload->>'accountingNote')) BETWEEN 1 AND 2000,false) OR NOT COALESCE(length(btrim(NEW.request_payload->>'specificationReference')) BETWEEN 1 AND 2000,false)
 OR NOT COALESCE(length(btrim(NEW.request_payload->>'reason')) BETWEEN 1 AND 2000,false) OR NOT COALESCE(length(btrim(NEW.request_payload->>'evidence')) BETWEEN 1 AND 2000,false)
 OR NOT COALESCE(length(btrim(NEW.request_payload->>'reference')) BETWEEN 1 AND 2000,false) OR NOT COALESCE((NEW.request_payload->>'observedAt')::numeric>0,false)
 OR NEW.result_payload IS DISTINCT FROM NEW.request_payload||jsonb_build_object('sources',NEW.source_snapshot,'actorId',NEW.actor_id,'recordedAt',NEW.result_payload->'recordedAt','qualityStatus','unreviewed','materialAccountingStatus','unreconciled','genealogyScope','declaration','warehouseEffect','none') OR (NEW.result_payload->>'recordedAt')::timestamptz IS DISTINCT FROM NEW.recorded_at THEN RAISE EXCEPTION 'calendered_output_ack_required'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER calendered_output_guard BEFORE INSERT ON inventory_calendaring_outputs FOR EACH ROW EXECUTE FUNCTION guard_calendered_roll_output();
CREATE FUNCTION guard_calendaring_output_claim() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request jsonb;
BEGIN
 SELECT request_payload INTO request FROM inventory_calendaring_outputs WHERE organization_id=NEW.organization_id AND operation_id=NEW.declaration_id;
 IF request IS NULL OR NOT COALESCE(request->'consumptionIds' @> jsonb_build_array(NEW.calendaring_consumption_id::text),false) THEN RAISE EXCEPTION 'calendered_output_claim_required'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER calendaring_output_claim_guard BEFORE INSERT ON inventory_calendaring_output_claims FOR EACH ROW EXECUTE FUNCTION guard_calendaring_output_claim();
CREATE FUNCTION require_calendaring_output_pairs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (SELECT count(*) FROM inventory_calendaring_output_claims WHERE organization_id=NEW.organization_id AND declaration_id=NEW.operation_id)<>jsonb_array_length(NEW.request_payload->'consumptionIds') OR (SELECT count(*) FROM inventory_room_output_lots WHERE organization_id=NEW.organization_id AND calendaring_declaration_id=NEW.operation_id)<>jsonb_array_length(NEW.request_payload->'outputs') THEN RAISE EXCEPTION 'calendered_output_pairs_required'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER calendaring_output_pairs AFTER INSERT ON inventory_calendaring_outputs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_calendaring_output_pairs();
CREATE OR REPLACE FUNCTION guard_room_output_lot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.calendaring_declaration_id IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM inventory_calendaring_outputs d JOIN inventory_materials m ON m.organization_id=d.organization_id AND m.id=NEW.material_id
   WHERE d.organization_id=NEW.organization_id AND d.operation_id=NEW.calendaring_declaration_id AND m.active AND m.base_unit='rolls' AND m.category='electrode' AND m.tape_specification IS NULL AND NEW.unit='rolls' AND NEW.quantity=1 AND NEW.declaration_id IS NULL AND NEW.coating_declaration_id IS NULL
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(d.request_payload->'outputs') v WHERE v->>'id'=NEW.id::text AND v->>'materialId'=NEW.material_id::text)) THEN RAISE EXCEPTION 'calendered_output_lot_required'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.coating_declaration_id IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM inventory_coating_outputs d JOIN inventory_materials m ON m.organization_id=d.organization_id AND m.id=NEW.material_id
   WHERE d.organization_id=NEW.organization_id AND d.operation_id=NEW.coating_declaration_id AND m.active AND m.base_unit='rolls' AND m.category='electrode' AND m.tape_specification IS NULL AND NEW.unit='rolls' AND NEW.quantity=1 AND NEW.declaration_id IS NULL
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(d.request_payload->'outputs') v WHERE v->>'id'=NEW.id::text AND v->>'materialId'=NEW.material_id::text)) THEN RAISE EXCEPTION 'coating_output_lot_required'; END IF;
  RETURN NEW;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM inventory_room_outputs d JOIN inventory_materials m ON m.organization_id=d.organization_id AND m.id=NEW.material_id
  WHERE d.organization_id=NEW.organization_id AND d.operation_id=NEW.declaration_id AND m.active AND m.base_unit='mg'
  AND EXISTS(SELECT 1 FROM jsonb_array_elements(d.request_payload->'outputs') v WHERE v->>'id'=NEW.id::text AND v->>'materialId'=NEW.material_id::text AND (v->>'quantity')::numeric=NEW.quantity)) THEN RAISE EXCEPTION 'room_output_lot_pair_required'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION room_output_snapshot(org uuid,lot uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN l.calendaring_declaration_id IS NOT NULL THEN jsonb_build_object('id',l.id,'declarationId',k.operation_id,'materialId',l.material_id,'quantity',l.quantity,'unit','rolls','roll',(SELECT v FROM jsonb_array_elements(k.request_payload->'outputs') v WHERE v->>'id'=l.id::text),'declaration',k.result_payload) WHEN l.coating_declaration_id IS NOT NULL THEN
  jsonb_build_object('id',l.id,'declarationId',c.operation_id,'materialId',l.material_id,'quantity',l.quantity,'unit','rolls',
   'roll',(SELECT v FROM jsonb_array_elements(c.request_payload->'outputs') v WHERE v->>'id'=l.id::text),'declaration',c.result_payload)
 ELSE jsonb_build_object('id',l.id,'declarationId',d.operation_id,'materialId',l.material_id,'quantity',l.quantity,'unit','mg','consumptionId',d.consumption_id,'declaration',d.result_payload) END
 FROM inventory_room_output_lots l LEFT JOIN inventory_room_outputs d ON d.organization_id=l.organization_id AND d.operation_id=l.declaration_id
 LEFT JOIN inventory_coating_outputs c ON c.organization_id=l.organization_id AND c.operation_id=l.coating_declaration_id LEFT JOIN inventory_calendaring_outputs k ON k.organization_id=l.organization_id AND k.operation_id=l.calendaring_declaration_id WHERE l.organization_id=org AND l.id=lot
$$;
CREATE OR REPLACE FUNCTION enforce_inventory_issue_intent_id() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE other record;incoming_effect boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.operation_id::text,1));
 -- Generated columns are NULL in BEFORE INSERT triggers. Derive their effect
 -- explicitly so SQL three-valued logic cannot allow a zero-stock ID to pair.
 incoming_effect:=CASE
  WHEN TG_TABLE_NAME IN ('inventory_operations','inventory_output_acceptances') THEN true
  WHEN TG_TABLE_NAME IN ('inventory_output_submissions','inventory_cell_submissions','inventory_slurry_consumptions','inventory_room_outputs','inventory_room_handoffs','inventory_room_handoff_events','inventory_coating_consumptions','inventory_coating_allocations','inventory_coating_foil_consumptions','inventory_coating_outputs','inventory_calendaring_consumptions','inventory_calendaring_allocations','inventory_calendaring_outputs') THEN false
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
 UNION ALL SELECT 'inventory_calendaring_outputs',organization_id,actor_id,device_id,request_payload,false FROM inventory_calendaring_outputs WHERE operation_id=NEW.operation_id AND TG_TABLE_NAME<>'inventory_calendaring_outputs'
 LOOP
  IF other.organization_id<>NEW.organization_id OR other.actor_id<>NEW.actor_id OR other.device_id IS DISTINCT FROM NEW.device_id OR other.request_payload<>NEW.request_payload OR other.stock_effect IS DISTINCT FROM true OR incoming_effect IS DISTINCT FROM true OR TG_TABLE_NAME<>'inventory_operations' AND other.owner<>'inventory_operations' THEN RAISE EXCEPTION 'operation_id_reused' USING ERRCODE='23505'; END IF;
 END LOOP;RETURN NEW;
END $$;
CREATE TRIGGER calendaring_output_namespace BEFORE INSERT ON inventory_calendaring_outputs FOR EACH ROW EXECUTE FUNCTION enforce_inventory_issue_intent_id();
COMMIT;
