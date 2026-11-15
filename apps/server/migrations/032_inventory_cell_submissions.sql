BEGIN;
-- Separate zero-stock cell attestations. Existing stock, electrode output and
-- local observations are never rewritten or imported as warehouse receipts.
CREATE TABLE inventory_cell_submissions (
 operation_id uuid PRIMARY KEY,organization_id uuid NOT NULL,
 production_batch_id uuid NOT NULL,step_number integer NOT NULL CHECK(step_number>0),completion_id uuid NOT NULL,
 source_identity_id text NOT NULL,source_run_id text NOT NULL,assembly_output_id text NOT NULL,assembly_run_id text NOT NULL,
 material_id uuid NOT NULL,serial_prefix text NOT NULL CHECK(length(serial_prefix)<=80 AND serial_prefix=trim(serial_prefix)),
 serial_start bigint NOT NULL CHECK(serial_start BETWEEN 0 AND 9007199254740991),serial_end bigint NOT NULL CHECK(serial_end BETWEEN serial_start AND 9007199254740991),
 quantity bigint NOT NULL CHECK(quantity BETWEEN 1 AND 9007199254740991),
 actor_id uuid NOT NULL,device_id uuid NOT NULL,epoch uuid NOT NULL,
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 2000),evidence text NOT NULL CHECK(length(trim(evidence)) BETWEEN 1 AND 2000),
 request_payload jsonb NOT NULL,result_payload jsonb NOT NULL,stock_effect boolean GENERATED ALWAYS AS (false) STORED,recorded_at timestamptz NOT NULL,
 UNIQUE(organization_id,operation_id),UNIQUE(organization_id,completion_id),UNIQUE(organization_id,source_identity_id),
 UNIQUE(organization_id,source_run_id),UNIQUE(organization_id,assembly_output_id),UNIQUE(organization_id,assembly_run_id),
 FOREIGN KEY(organization_id,production_batch_id) REFERENCES production_batches(organization_id,id),
 FOREIGN KEY(organization_id,completion_id) REFERENCES production_step_evidence(organization_id,id),
 FOREIGN KEY(organization_id,material_id) REFERENCES inventory_materials(organization_id,id),
 FOREIGN KEY(organization_id,actor_id) REFERENCES users(organization_id,id),FOREIGN KEY(organization_id,device_id) REFERENCES devices(organization_id,id)
);
CREATE TABLE inventory_cell_serial_ranges (
 organization_id uuid NOT NULL,submission_id uuid NOT NULL,ordinal integer NOT NULL CHECK(ordinal BETWEEN 0 AND 999),
 range_start bigint NOT NULL CHECK(range_start BETWEEN 0 AND 9007199254740991),range_end bigint NOT NULL CHECK(range_end BETWEEN range_start AND 9007199254740991),
 PRIMARY KEY(organization_id,submission_id,ordinal),FOREIGN KEY(organization_id,submission_id) REFERENCES inventory_cell_submissions(organization_id,operation_id)
);
CREATE INDEX inventory_cell_list ON inventory_cell_submissions(organization_id,operation_id);
CREATE INDEX inventory_cell_serial_domain ON inventory_cell_submissions(organization_id,serial_prefix,serial_start,serial_end);
CREATE TRIGGER inventory_cell_submission_immutable BEFORE UPDATE OR DELETE ON inventory_cell_submissions FOR EACH ROW EXECUTE FUNCTION forbid_inventory_operation_rewrite();
CREATE TRIGGER inventory_cell_serial_immutable BEFORE UPDATE OR DELETE ON inventory_cell_serial_ranges FOR EACH ROW EXECUTE FUNCTION forbid_inventory_operation_rewrite();

CREATE FUNCTION guard_inventory_cell_submission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed boolean;valid_source boolean;p jsonb;f jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':inventory-sequence',0));
 IF NOT EXISTS(SELECT 1 FROM inventory_streams WHERE organization_id=NEW.organization_id AND epoch=NEW.epoch AND posting_enabled)
 THEN RAISE EXCEPTION 'cell_output_history_required'; END IF;
 SELECT u.role='chief' OR u.role='master' AND EXISTS(SELECT 1 FROM user_workshop_memberships m JOIN production_step_evidence e ON e.organization_id=m.organization_id AND e.workshop_id=m.workshop_id
  WHERE m.organization_id=u.organization_id AND m.user_id=u.id AND e.id=NEW.completion_id)
 INTO allowed FROM users u JOIN devices d ON d.organization_id=u.organization_id AND d.user_id=u.id AND d.id=NEW.device_id AND d.revoked_at IS NULL
 WHERE u.organization_id=NEW.organization_id AND u.id=NEW.actor_id AND u.active;
 IF allowed IS DISTINCT FROM true THEN RAISE EXCEPTION 'cell_output_authority_required'; END IF;
 SELECT true INTO valid_source FROM production_step_evidence e
 JOIN production_batches b ON b.organization_id=e.organization_id AND b.id=e.batch_id
 JOIN production_orders o ON o.organization_id=b.organization_id AND o.id=b.order_id AND o.route_id=e.route_id AND o.route_version=e.route_version
 JOIN process_route_steps s ON s.organization_id=e.organization_id AND s.route_id=e.route_id AND s.route_version=e.route_version AND s.step_number=e.step_number AND s.workshop_id=e.workshop_id
 JOIN inventory_materials m ON m.organization_id=e.organization_id AND m.id=NEW.material_id
 WHERE e.organization_id=NEW.organization_id AND e.id=NEW.completion_id AND e.batch_id=NEW.production_batch_id AND e.step_number=NEW.step_number AND e.kind='completed' AND e.quantity_unit='pieces' AND e.quantity=NEW.quantity
  AND b.material_line='cell' AND b.status IN ('in_progress','completed') AND o.status IN ('released','in_progress','completed')
  AND s.stage='formation' AND s.electrode_line='common' AND m.active AND m.category='cell' AND m.base_unit='pieces'
  AND NOT EXISTS(SELECT 1 FROM process_route_steps later WHERE later.organization_id=s.organization_id AND later.route_id=s.route_id AND later.route_version=s.route_version AND later.step_number>s.step_number AND later.electrode_line='common')
 FOR SHARE OF e,b,o,s,m;
 IF valid_source IS DISTINCT FROM true THEN RAISE EXCEPTION 'cell_output_source_required'; END IF;
 p:=NEW.request_payload->'source';f:=p->'formation';
 IF (NEW.request_payload->>'operationId')::uuid IS DISTINCT FROM NEW.operation_id OR (NEW.request_payload->>'deviceId')::uuid IS DISTINCT FROM NEW.device_id
  OR (NEW.request_payload->>'productionBatchId')::uuid IS DISTINCT FROM NEW.production_batch_id OR (NEW.request_payload->>'completionId')::uuid IS DISTINCT FROM NEW.completion_id
  OR (NEW.request_payload->>'stepNumber')::integer IS DISTINCT FROM NEW.step_number OR (NEW.request_payload->>'materialId')::uuid IS DISTINCT FROM NEW.material_id
  OR p->>'identityId' IS DISTINCT FROM NEW.source_identity_id OR p->>'formationRunId' IS DISTINCT FROM NEW.source_run_id
  OR p#>>'{lineage,assemblyOutputId}' IS DISTINCT FROM NEW.assembly_output_id OR p#>>'{lineage,assemblyRunId}' IS DISTINCT FROM NEW.assembly_run_id
  OR COALESCE(p#>>'{inputSerialRange,prefix}','') IS DISTINCT FROM NEW.serial_prefix OR (p#>>'{inputSerialRange,start}')::bigint IS DISTINCT FROM NEW.serial_start OR (p#>>'{inputSerialRange,end}')::bigint IS DISTINCT FROM NEW.serial_end
  OR (f->>'cellsOut')::bigint IS DISTINCT FROM NEW.quantity OR (f->>'cellsIn')::numeric IS DISTINCT FROM NEW.serial_end::numeric-NEW.serial_start+1
  OR (f->>'cellsIn')::numeric IS DISTINCT FROM (f->>'cellsOut')::numeric+(f->>'cellsScrap')::numeric+(f->>'cellsUnknown')::numeric
  OR NEW.result_payload#>'{submission,source}' IS DISTINCT FROM p OR (NEW.result_payload->>'operationId')::uuid IS DISTINCT FROM NEW.operation_id
  OR (NEW.result_payload#>>'{submission,quantity}')::bigint IS DISTINCT FROM NEW.quantity OR NEW.result_payload#>>'{submission,unit}' IS DISTINCT FROM 'pieces'
  OR (NEW.result_payload#>>'{submission,actorId}')::uuid IS DISTINCT FROM NEW.actor_id OR (NEW.result_payload#>>'{submission,deviceId}')::uuid IS DISTINCT FROM NEW.device_id
  OR NEW.request_payload->>'reason' IS DISTINCT FROM NEW.reason OR NEW.request_payload->>'evidence' IS DISTINCT FROM NEW.evidence
  OR (NEW.result_payload->'submission')-ARRAY['quantity','unit','revision','actorId','recordedAt'] IS DISTINCT FROM NEW.request_payload
  OR NEW.result_payload-'submission' IS DISTINCT FROM jsonb_build_object('operationId',NEW.operation_id)
  OR (NEW.result_payload#>>'{submission,revision}')::integer IS DISTINCT FROM 1 OR (NEW.result_payload#>>'{submission,recordedAt}')::timestamptz IS DISTINCT FROM NEW.recorded_at
 THEN RAISE EXCEPTION 'cell_output_source_required'; END IF;
 -- Hold the complete original serial domain. Unknown/scrap serial identities
 -- are not inferred or freed for another source under a different local ID.
 IF EXISTS(SELECT 1 FROM inventory_cell_submissions prior WHERE prior.organization_id=NEW.organization_id
  AND (prior.serial_prefix=NEW.serial_prefix OR prior.serial_prefix='' OR NEW.serial_prefix='') AND prior.serial_start<=NEW.serial_end AND NEW.serial_start<=prior.serial_end)
 THEN RAISE EXCEPTION 'cell_serial_source_already_claimed'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_cell_submission_guard BEFORE INSERT ON inventory_cell_submissions FOR EACH ROW EXECUTE FUNCTION guard_inventory_cell_submission();

CREATE FUNCTION guard_inventory_cell_range() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':inventory-sequence',0));
 SELECT request_payload#>ARRAY['source','ranges',NEW.ordinal::text] INTO expected FROM inventory_cell_submissions WHERE organization_id=NEW.organization_id AND operation_id=NEW.submission_id;
 IF expected IS NULL OR (expected->>'start')::bigint IS DISTINCT FROM NEW.range_start OR (expected->>'end')::bigint IS DISTINCT FROM NEW.range_end
 THEN RAISE EXCEPTION 'cell_serial_range_mismatch'; END IF;
 IF EXISTS(SELECT 1 FROM inventory_cell_serial_ranges WHERE organization_id=NEW.organization_id AND submission_id=NEW.submission_id AND range_start<=NEW.range_end AND NEW.range_start<=range_end)
 THEN RAISE EXCEPTION 'cell_serial_range_mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_cell_range_guard BEFORE INSERT ON inventory_cell_serial_ranges FOR EACH ROW EXECUTE FUNCTION guard_inventory_cell_range();
CREATE FUNCTION require_inventory_cell_ranges() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE total numeric;items integer;
BEGIN
 SELECT sum(range_end::numeric-range_start+1),count(*) INTO total,items FROM inventory_cell_serial_ranges WHERE organization_id=NEW.organization_id AND submission_id=NEW.operation_id;
 IF total IS DISTINCT FROM NEW.quantity::numeric OR items IS DISTINCT FROM jsonb_array_length(NEW.request_payload#>'{source,ranges}') OR items NOT BETWEEN 1 AND 1000
 THEN RAISE EXCEPTION 'cell_output_serial_pair_required'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER inventory_cell_submission_ranges AFTER INSERT ON inventory_cell_submissions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_inventory_cell_ranges();

-- Extend the existing shared operation namespace; generated effect is derived explicitly.
CREATE OR REPLACE FUNCTION enforce_inventory_issue_intent_id() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE other record;incoming_effect boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.operation_id::text,1));
 -- Generated columns are NULL in BEFORE INSERT triggers. Derive their effect
 -- explicitly so SQL three-valued logic cannot allow a zero-stock ID to pair.
 incoming_effect:=CASE
  WHEN TG_TABLE_NAME IN ('inventory_operations','inventory_output_acceptances') THEN true
  WHEN TG_TABLE_NAME IN ('inventory_output_submissions','inventory_cell_submissions') THEN false
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
 LOOP
  IF other.organization_id<>NEW.organization_id OR other.actor_id<>NEW.actor_id OR other.device_id IS DISTINCT FROM NEW.device_id OR other.request_payload<>NEW.request_payload OR other.stock_effect IS DISTINCT FROM true OR incoming_effect IS DISTINCT FROM true OR TG_TABLE_NAME<>'inventory_operations' AND other.owner<>'inventory_operations' THEN RAISE EXCEPTION 'operation_id_reused' USING ERRCODE='23505'; END IF;
 END LOOP;RETURN NEW;
END $$;
CREATE TRIGGER inventory_cell_submission_namespace BEFORE INSERT ON inventory_cell_submissions FOR EACH ROW EXECUTE FUNCTION enforce_inventory_issue_intent_id();
COMMIT;
