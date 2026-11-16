-- Explicit physical coated-roll observations. Input quantities keep their original
-- units; this declaration neither certifies yield nor creates warehouse stock.
BEGIN;
CREATE TABLE inventory_coating_outputs (
 operation_id uuid PRIMARY KEY,organization_id uuid NOT NULL,actor_id uuid NOT NULL,device_id uuid NOT NULL,
 production_batch_id uuid NOT NULL,step_number integer NOT NULL CHECK(step_number>0),epoch uuid NOT NULL,
 source_snapshot jsonb NOT NULL,request_payload jsonb NOT NULL,result_payload jsonb NOT NULL,recorded_at timestamptz NOT NULL,
 stock_effect boolean GENERATED ALWAYS AS(false) STORED,
 UNIQUE(organization_id,operation_id),
 FOREIGN KEY(organization_id,actor_id) REFERENCES users(organization_id,id),
 FOREIGN KEY(organization_id,device_id) REFERENCES devices(organization_id,id),
 FOREIGN KEY(organization_id,production_batch_id) REFERENCES production_batches(organization_id,id)
);
CREATE TABLE inventory_coating_output_claims (
 organization_id uuid NOT NULL,declaration_id uuid NOT NULL,slurry_consumption_id uuid,foil_consumption_id uuid,
 CHECK((slurry_consumption_id IS NOT NULL)::integer+(foil_consumption_id IS NOT NULL)::integer=1),
 UNIQUE(organization_id,slurry_consumption_id),UNIQUE(organization_id,foil_consumption_id),
 FOREIGN KEY(organization_id,declaration_id) REFERENCES inventory_coating_outputs(organization_id,operation_id),
 FOREIGN KEY(organization_id,slurry_consumption_id) REFERENCES inventory_coating_consumptions(organization_id,operation_id),
 FOREIGN KEY(organization_id,foil_consumption_id) REFERENCES inventory_coating_foil_consumptions(organization_id,operation_id)
);
CREATE INDEX coating_output_claim_parent ON inventory_coating_output_claims(organization_id,declaration_id);
CREATE TRIGGER coating_output_immutable BEFORE UPDATE OR DELETE ON inventory_coating_outputs FOR EACH ROW EXECUTE FUNCTION forbid_inventory_operation_rewrite();
CREATE TRIGGER coating_output_claim_immutable BEFORE UPDATE OR DELETE ON inventory_coating_output_claims FOR EACH ROW EXECUTE FUNCTION forbid_inventory_operation_rewrite();
ALTER TABLE inventory_room_output_lots ALTER COLUMN declaration_id DROP NOT NULL;
ALTER TABLE inventory_room_output_lots ADD COLUMN coating_declaration_id uuid;
ALTER TABLE inventory_room_output_lots ADD FOREIGN KEY(organization_id,coating_declaration_id) REFERENCES inventory_coating_outputs(organization_id,operation_id);
ALTER TABLE inventory_room_output_lots DROP CONSTRAINT inventory_room_output_lots_unit_check;
ALTER TABLE inventory_room_output_lots ADD CHECK(unit IN ('mg','rolls'));
ALTER TABLE inventory_room_output_lots ADD CONSTRAINT room_output_lot_origin CHECK(
 (unit='mg' AND declaration_id IS NOT NULL AND coating_declaration_id IS NULL) OR
 (unit='rolls' AND declaration_id IS NULL AND coating_declaration_id IS NOT NULL AND quantity=1));

CREATE FUNCTION coating_roll_sources(org uuid,request jsonb) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object(
 'slurry',COALESCE((SELECT jsonb_agg(c.result_payload ORDER BY a.n) FROM jsonb_array_elements_text(request->'slurryConsumptionIds') WITH ORDINALITY a(id,n) JOIN inventory_coating_consumptions c ON c.organization_id=org AND c.operation_id=a.id::uuid),'[]'::jsonb),
 'foil',COALESCE((SELECT jsonb_agg(c.result_payload ORDER BY a.n) FROM jsonb_array_elements_text(request->'foilConsumptionIds') WITH ORDINALITY a(id,n) JOIN inventory_coating_foil_consumptions c ON c.organization_id=org AND c.operation_id=a.id::uuid),'[]'::jsonb),
 'tape',COALESCE((SELECT jsonb_agg(coating_foil_source(org,a.id::uuid)->'issue' ORDER BY a.n) FROM jsonb_array_elements_text(COALESCE(request->'tape'->'issueIds','[]'::jsonb)) WITH ORDINALITY a(id,n)),'[]'::jsonb))
$$;
-- No consumed quantity is re-debited here. These checks concern current holds
-- on the original material ancestry and receipt identity only.
CREATE FUNCTION coating_roll_inputs_eligible(org uuid,request jsonb) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT COALESCE(
 (SELECT count(*)=jsonb_array_length(request->'slurryConsumptionIds') AND bool_and(
  EXISTS(SELECT 1 FROM inventory_coating_allocations a WHERE a.organization_id=org AND a.consumption_id=c.operation_id)
  AND NOT EXISTS(SELECT 1 FROM inventory_coating_allocations a WHERE a.organization_id=org AND a.consumption_id=c.operation_id AND NOT coating_slurry_eligible(org,a.receipt_id)))
  FROM inventory_coating_consumptions c WHERE c.organization_id=org AND c.operation_id IN(SELECT value::uuid FROM jsonb_array_elements_text(request->'slurryConsumptionIds')))
 AND (SELECT count(*)=jsonb_array_length(request->'foilConsumptionIds') AND bool_and(m.active AND m.base_unit=c.unit
  AND EXISTS(SELECT 1 FROM inventory_issue_outcomes a WHERE a.organization_id=org AND a.foil_consumption_id=c.operation_id)
  AND NOT EXISTS(SELECT 1 FROM inventory_issue_outcomes a JOIN inventory_issues i ON i.organization_id=a.organization_id AND i.id=a.issue_id WHERE a.organization_id=org AND a.foil_consumption_id=c.operation_id AND (NOT inventory_package_released(org,a.source_stock_id) OR coating_foil_source(org,i.id) IS NULL OR (i.source_snapshot->>'expiresAt')::timestamptz<=clock_timestamp())))
  FROM inventory_coating_foil_consumptions c JOIN inventory_materials m ON m.organization_id=c.organization_id AND m.id=c.material_id WHERE c.organization_id=org AND c.operation_id IN(SELECT value::uuid FROM jsonb_array_elements_text(request->'foilConsumptionIds')))
 AND (request->'tape'->>'status'='not_applicable' OR request->'tape'->>'status'='unmeasured' AND
  (SELECT count(*)=jsonb_array_length(request->'tape'->'issueIds') AND bool_and(i.state='received' AND m.active AND m.base_unit='rolls' AND m.tape_specification->>'application'='coating_support'
   AND inventory_package_released(org,i.stock_id) AND coating_foil_source(org,i.id) IS NOT NULL AND (coating_foil_source(org,i.id)->'settlement'->>'outstanding')::bigint>0)
   FROM inventory_issues i JOIN inventory_materials m ON m.organization_id=i.organization_id AND m.id=i.material_id WHERE i.organization_id=org AND i.id IN(SELECT value::uuid FROM jsonb_array_elements_text(request->'tape'->'issueIds')))),false)
$$;
CREATE FUNCTION guard_coating_roll_output() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item jsonb; source record; origin text; source_ids jsonb; workshop text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':inventory-sequence',0));
 SELECT s.workshop_id INTO workshop FROM production_batches b JOIN production_orders o ON o.organization_id=b.organization_id AND o.id=b.order_id
 JOIN process_route_steps s ON s.organization_id=o.organization_id AND s.route_id=o.route_id AND s.route_version=o.route_version AND s.step_number=NEW.step_number AND s.electrode_line=CASE WHEN b.material_line='cell' THEN 'common' ELSE b.material_line END
 JOIN users u ON u.organization_id=b.organization_id AND u.id=NEW.actor_id AND u.active
 JOIN devices d ON d.organization_id=u.organization_id AND d.user_id=u.id AND d.id=NEW.device_id AND d.revoked_at IS NULL
 WHERE b.organization_id=NEW.organization_id AND b.id=NEW.production_batch_id AND b.status IN ('created','in_progress') AND o.status IN ('released','in_progress') AND s.stage='coating'
 AND (u.role='chief' OR EXISTS(SELECT 1 FROM user_workshop_memberships w WHERE w.organization_id=u.organization_id AND w.user_id=u.id AND w.workshop_id=s.workshop_id));
 IF workshop IS NULL THEN RAISE EXCEPTION 'coating_output_authority_required'; END IF;
 FOREACH origin IN ARRAY ARRAY['slurry','foil'] LOOP
  source_ids:=NEW.request_payload->(origin||'ConsumptionIds');
  IF jsonb_typeof(source_ids) IS DISTINCT FROM 'array' OR jsonb_array_length(source_ids) NOT BETWEEN 1 AND 100 OR (SELECT count(DISTINCT value) FROM jsonb_array_elements_text(source_ids))<>jsonb_array_length(source_ids) THEN RAISE EXCEPTION 'coating_output_inputs_required'; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(source_ids) LOOP
   IF origin='slurry' THEN SELECT c.production_batch_id,c.step_number,c.actor_id INTO source FROM inventory_coating_consumptions c WHERE c.organization_id=NEW.organization_id AND c.operation_id=(item#>>'{}')::uuid;
   ELSE SELECT c.production_batch_id,c.step_number,c.actor_id INTO source FROM inventory_coating_foil_consumptions c WHERE c.organization_id=NEW.organization_id AND c.operation_id=(item#>>'{}')::uuid; END IF;
   IF source.production_batch_id IS DISTINCT FROM NEW.production_batch_id OR source.step_number IS DISTINCT FROM NEW.step_number OR NOT EXISTS(SELECT 1 FROM users u WHERE u.organization_id=NEW.organization_id AND u.id=NEW.actor_id AND (u.id=source.actor_id OR u.role IN ('chief','master'))) THEN RAISE EXCEPTION 'coating_output_inputs_required'; END IF;
  END LOOP;
 END LOOP;
 IF NEW.request_payload->'tape'->>'status'='unmeasured' THEN
  IF jsonb_typeof(NEW.request_payload->'tape'->'issueIds') IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.request_payload->'tape'->'issueIds') NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'coating_tape_attribution_required'; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(NEW.request_payload->'tape'->'issueIds') LOOP
   IF NOT EXISTS(SELECT 1 FROM inventory_issues i JOIN users u ON u.organization_id=i.organization_id AND u.id=NEW.actor_id WHERE i.organization_id=NEW.organization_id AND i.id=(item#>>'{}')::uuid AND i.production_batch_id=NEW.production_batch_id AND i.step_number=NEW.step_number AND i.workshop_id=workshop AND (u.role IN ('chief','master') OR i.recipient_id=u.id)) THEN RAISE EXCEPTION 'coating_tape_attribution_required'; END IF;
  END LOOP;
 ELSIF NEW.request_payload->'tape'->>'status' IS DISTINCT FROM 'not_applicable' THEN RAISE EXCEPTION 'coating_tape_attribution_required'; END IF;
 IF NOT COALESCE(length(btrim(NEW.request_payload->'tape'->>'note')) BETWEEN 1 AND 2000,false) OR NOT coating_roll_inputs_eligible(NEW.organization_id,NEW.request_payload) OR NEW.source_snapshot IS DISTINCT FROM coating_roll_sources(NEW.organization_id,NEW.request_payload) THEN RAISE EXCEPTION 'coating_output_source_held'; END IF;
 IF jsonb_typeof(NEW.request_payload->'outputs') IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.request_payload->'outputs') NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'measured_rolls_required'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(NEW.request_payload->'outputs') LOOP
  IF NOT COALESCE((item->>'measuredLengthMm')::numeric BETWEEN 1 AND 9007199254740991 AND (item->>'measuredLengthMm')::numeric=trunc((item->>'measuredLengthMm')::numeric),false)
  OR jsonb_typeof(item->'label') IS DISTINCT FROM 'string' OR NOT COALESCE(length(btrim(item->>'label')) BETWEEN 1 AND 200,false) OR NOT COALESCE(item->>'disposition' IN ('ready','held'),false) OR NOT(item ? 'measuredMassMg')
  OR (item->'measuredMassMg'<>'null'::jsonb AND NOT COALESCE((item->>'measuredMassMg')::numeric BETWEEN 1 AND 9007199254740991 AND (item->>'measuredMassMg')::numeric=trunc((item->>'measuredMassMg')::numeric),false)) THEN RAISE EXCEPTION 'measured_rolls_required'; END IF;
 END LOOP;
 FOREACH origin IN ARRAY ARRAY['scrapLengthMm','scrapMassMg'] LOOP
  IF NOT(NEW.request_payload ? origin) OR (NEW.request_payload->origin<>'null'::jsonb AND NOT COALESCE((NEW.request_payload->>origin)::numeric BETWEEN 0 AND 9007199254740991 AND (NEW.request_payload->>origin)::numeric=trunc((NEW.request_payload->>origin)::numeric),false)) THEN RAISE EXCEPTION 'coating_scrap_observation_required'; END IF;
 END LOOP;
 IF NEW.request_payload->>'operationId' IS DISTINCT FROM NEW.operation_id::text OR NEW.request_payload->>'deviceId' IS DISTINCT FROM NEW.device_id::text OR NEW.request_payload->>'productionBatchId' IS DISTINCT FROM NEW.production_batch_id::text OR (NEW.request_payload->>'stepNumber')::integer IS DISTINCT FROM NEW.step_number
 OR NOT COALESCE(length(btrim(NEW.request_payload->>'accountingNote')) BETWEEN 1 AND 2000,false) OR NOT COALESCE(length(btrim(NEW.request_payload->>'specificationReference')) BETWEEN 1 AND 2000,false)
 OR NOT COALESCE(length(btrim(NEW.request_payload->>'reference')) BETWEEN 1 AND 2000,false) OR NOT COALESCE((NEW.request_payload->>'observedAt')::numeric>0,false)
 OR NEW.result_payload IS DISTINCT FROM NEW.request_payload||jsonb_build_object('sources',NEW.source_snapshot,'actorId',NEW.actor_id,'recordedAt',NEW.result_payload->'recordedAt','qualityStatus','unreviewed','materialAccountingStatus','unreconciled','genealogyScope','declaration','warehouseEffect','none') OR (NEW.result_payload->>'recordedAt')::timestamptz IS DISTINCT FROM NEW.recorded_at THEN RAISE EXCEPTION 'coating_output_ack_required'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER coating_output_guard BEFORE INSERT ON inventory_coating_outputs FOR EACH ROW EXECUTE FUNCTION guard_coating_roll_output();
CREATE FUNCTION guard_coating_output_claim() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request jsonb;
BEGIN
 SELECT request_payload INTO request FROM inventory_coating_outputs WHERE organization_id=NEW.organization_id AND operation_id=NEW.declaration_id;
 IF request IS NULL OR NOT COALESCE(request->(CASE WHEN NEW.slurry_consumption_id IS NOT NULL THEN 'slurryConsumptionIds' ELSE 'foilConsumptionIds' END) @> jsonb_build_array(COALESCE(NEW.slurry_consumption_id,NEW.foil_consumption_id)::text),false) THEN RAISE EXCEPTION 'coating_output_claim_required'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER coating_output_claim_guard BEFORE INSERT ON inventory_coating_output_claims FOR EACH ROW EXECUTE FUNCTION guard_coating_output_claim();

CREATE FUNCTION require_coating_output_pairs() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item jsonb;
BEGIN
 IF (SELECT count(*) FROM inventory_coating_output_claims WHERE organization_id=NEW.organization_id AND declaration_id=NEW.operation_id)<>jsonb_array_length(NEW.request_payload->'slurryConsumptionIds')+jsonb_array_length(NEW.request_payload->'foilConsumptionIds')
 OR (SELECT count(*) FROM inventory_room_output_lots WHERE organization_id=NEW.organization_id AND coating_declaration_id=NEW.operation_id)<>jsonb_array_length(NEW.request_payload->'outputs') THEN RAISE EXCEPTION 'coating_output_pairs_required'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(NEW.request_payload->'slurryConsumptionIds') LOOP
  IF NOT EXISTS(SELECT 1 FROM inventory_coating_output_claims WHERE organization_id=NEW.organization_id AND declaration_id=NEW.operation_id AND slurry_consumption_id=(item#>>'{}')::uuid) THEN RAISE EXCEPTION 'coating_output_pairs_required'; END IF;
 END LOOP;
 FOR item IN SELECT value FROM jsonb_array_elements(NEW.request_payload->'foilConsumptionIds') LOOP
  IF NOT EXISTS(SELECT 1 FROM inventory_coating_output_claims WHERE organization_id=NEW.organization_id AND declaration_id=NEW.operation_id AND foil_consumption_id=(item#>>'{}')::uuid) THEN RAISE EXCEPTION 'coating_output_pairs_required'; END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER coating_output_pairs AFTER INSERT ON inventory_coating_outputs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_coating_output_pairs();
CREATE OR REPLACE FUNCTION guard_room_output_lot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
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
 SELECT CASE WHEN l.coating_declaration_id IS NOT NULL THEN
  jsonb_build_object('id',l.id,'declarationId',c.operation_id,'materialId',l.material_id,'quantity',l.quantity,'unit','rolls',
   'roll',(SELECT v FROM jsonb_array_elements(c.request_payload->'outputs') v WHERE v->>'id'=l.id::text),'declaration',c.result_payload)
 ELSE jsonb_build_object('id',l.id,'declarationId',d.operation_id,'materialId',l.material_id,'quantity',l.quantity,'unit','mg','consumptionId',d.consumption_id,'declaration',d.result_payload) END
 FROM inventory_room_output_lots l LEFT JOIN inventory_room_outputs d ON d.organization_id=l.organization_id AND d.operation_id=l.declaration_id
 LEFT JOIN inventory_coating_outputs c ON c.organization_id=l.organization_id AND c.operation_id=l.coating_declaration_id WHERE l.organization_id=org AND l.id=lot
$$;
CREATE OR REPLACE FUNCTION enforce_inventory_issue_intent_id() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE other record;incoming_effect boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.operation_id::text,1));
 -- Generated columns are NULL in BEFORE INSERT triggers. Derive their effect
 -- explicitly so SQL three-valued logic cannot allow a zero-stock ID to pair.
 incoming_effect:=CASE
  WHEN TG_TABLE_NAME IN ('inventory_operations','inventory_output_acceptances') THEN true
  WHEN TG_TABLE_NAME IN ('inventory_output_submissions','inventory_cell_submissions','inventory_slurry_consumptions','inventory_room_outputs','inventory_room_handoffs','inventory_room_handoff_events','inventory_coating_consumptions','inventory_coating_allocations','inventory_coating_foil_consumptions','inventory_coating_outputs') THEN false
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
 LOOP
  IF other.organization_id<>NEW.organization_id OR other.actor_id<>NEW.actor_id OR other.device_id IS DISTINCT FROM NEW.device_id OR other.request_payload<>NEW.request_payload OR other.stock_effect IS DISTINCT FROM true OR incoming_effect IS DISTINCT FROM true OR TG_TABLE_NAME<>'inventory_operations' AND other.owner<>'inventory_operations' THEN RAISE EXCEPTION 'operation_id_reused' USING ERRCODE='23505'; END IF;
 END LOOP;RETURN NEW;
END $$;
CREATE TRIGGER coating_output_namespace BEFORE INSERT ON inventory_coating_outputs FOR EACH ROW EXECUTE FUNCTION enforce_inventory_issue_intent_id();
COMMIT;
