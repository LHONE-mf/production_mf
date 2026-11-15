BEGIN;
-- New immutable attestations only; no conversion of existing journals or stock.
CREATE TABLE inventory_output_submissions (
 operation_id uuid PRIMARY KEY,organization_id uuid NOT NULL,
 production_batch_id uuid NOT NULL,step_number integer NOT NULL CHECK(step_number>0),completion_id uuid NOT NULL,
 source_run_id text NOT NULL,source_cut_id text NOT NULL,
 quantity bigint NOT NULL CHECK(quantity BETWEEN 1 AND 9007199254740991),
 actor_id uuid NOT NULL,device_id uuid NOT NULL,epoch uuid NOT NULL,
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 2000),evidence text NOT NULL CHECK(length(trim(evidence)) BETWEEN 1 AND 2000),
 request_payload jsonb NOT NULL,result_payload jsonb NOT NULL,
 stock_effect boolean GENERATED ALWAYS AS (false) STORED,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(organization_id,operation_id),UNIQUE(organization_id,completion_id),
 UNIQUE(organization_id,source_run_id),UNIQUE(organization_id,source_cut_id),
 FOREIGN KEY(organization_id,production_batch_id) REFERENCES production_batches(organization_id,id),
 FOREIGN KEY(organization_id,completion_id) REFERENCES production_step_evidence(organization_id,id),
 FOREIGN KEY(organization_id,actor_id) REFERENCES users(organization_id,id),
 FOREIGN KEY(organization_id,device_id) REFERENCES devices(organization_id,id)
);
CREATE TABLE inventory_output_lines (
 organization_id uuid NOT NULL,submission_id uuid NOT NULL,grade text NOT NULL CHECK(length(trim(grade)) BETWEEN 1 AND 120),
 material_id uuid NOT NULL,quantity bigint NOT NULL CHECK(quantity BETWEEN 1 AND 9007199254740991),
 PRIMARY KEY(organization_id,submission_id,grade),
 FOREIGN KEY(organization_id,submission_id) REFERENCES inventory_output_submissions(organization_id,operation_id),
 FOREIGN KEY(organization_id,material_id) REFERENCES inventory_materials(organization_id,id)
);
CREATE TABLE inventory_output_acceptances (
 operation_id uuid PRIMARY KEY REFERENCES inventory_operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
 organization_id uuid NOT NULL,submission_id uuid NOT NULL,grade text NOT NULL,stock_id uuid NOT NULL UNIQUE,
 actor_id uuid NOT NULL,device_id uuid NOT NULL,epoch uuid NOT NULL,
 request_payload jsonb NOT NULL,result_stock jsonb NOT NULL,
 stock_effect boolean GENERATED ALWAYS AS (true) STORED,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(organization_id,submission_id,grade),
 FOREIGN KEY(organization_id,submission_id,grade) REFERENCES inventory_output_lines(organization_id,submission_id,grade),
 FOREIGN KEY(organization_id,stock_id) REFERENCES inventory_stocks(organization_id,id),
 FOREIGN KEY(organization_id,actor_id) REFERENCES users(organization_id,id),
 FOREIGN KEY(organization_id,device_id) REFERENCES devices(organization_id,id)
);
CREATE INDEX inventory_output_list ON inventory_output_submissions(organization_id,operation_id);
CREATE TRIGGER inventory_output_submission_immutable BEFORE UPDATE OR DELETE ON inventory_output_submissions FOR EACH ROW EXECUTE FUNCTION forbid_inventory_operation_rewrite();
CREATE TRIGGER inventory_output_line_immutable BEFORE UPDATE OR DELETE ON inventory_output_lines FOR EACH ROW EXECUTE FUNCTION forbid_inventory_operation_rewrite();
CREATE TRIGGER inventory_output_acceptance_immutable BEFORE UPDATE OR DELETE ON inventory_output_acceptances FOR EACH ROW EXECUTE FUNCTION forbid_inventory_operation_rewrite();

CREATE FUNCTION guard_inventory_output_line() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM inventory_output_submissions s,jsonb_array_elements(s.request_payload->'outputs') line
  WHERE s.organization_id=NEW.organization_id AND s.operation_id=NEW.submission_id
   AND line->>'grade'=NEW.grade AND (line->>'materialId')::uuid=NEW.material_id AND (line->>'quantity')::numeric=NEW.quantity)
 THEN RAISE EXCEPTION 'finished_output_line_mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_output_line_guard BEFORE INSERT ON inventory_output_lines FOR EACH ROW EXECUTE FUNCTION guard_inventory_output_line();

CREATE FUNCTION guard_inventory_output_authority() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':inventory-sequence',0));
 IF NOT EXISTS(SELECT 1 FROM inventory_streams WHERE organization_id=NEW.organization_id AND epoch=NEW.epoch AND posting_enabled)
 THEN RAISE EXCEPTION 'finished_output_history_required'; END IF;
 IF TG_TABLE_NAME='inventory_output_submissions' THEN
  SELECT u.role='chief' OR u.role='master' AND EXISTS(SELECT 1 FROM user_workshop_memberships m
   JOIN production_step_evidence e ON e.organization_id=m.organization_id AND e.workshop_id=m.workshop_id
   WHERE m.organization_id=u.organization_id AND m.user_id=u.id AND e.id=NEW.completion_id)
  INTO allowed FROM users u JOIN devices d ON d.organization_id=u.organization_id AND d.user_id=u.id AND d.id=NEW.device_id AND d.revoked_at IS NULL
  WHERE u.organization_id=NEW.organization_id AND u.id=NEW.actor_id AND u.active;
 ELSE
  SELECT u.role='chief' OR EXISTS(SELECT 1 FROM inventory_access a WHERE a.organization_id=u.organization_id AND a.user_id=u.id AND a.active)
  INTO allowed FROM users u JOIN devices d ON d.organization_id=u.organization_id AND d.user_id=u.id AND d.id=NEW.device_id AND d.revoked_at IS NULL
  WHERE u.organization_id=NEW.organization_id AND u.id=NEW.actor_id AND u.active;
 END IF;
 IF allowed IS DISTINCT FROM true THEN RAISE EXCEPTION 'finished_output_authority_required'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_output_submission_authority BEFORE INSERT ON inventory_output_submissions FOR EACH ROW EXECUTE FUNCTION guard_inventory_output_authority();
CREATE TRIGGER inventory_output_acceptance_authority BEFORE INSERT ON inventory_output_acceptances FOR EACH ROW EXECUTE FUNCTION guard_inventory_output_authority();

CREATE FUNCTION require_inventory_output_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e production_step_evidence%ROWTYPE;total numeric;
BEGIN
 SELECT * INTO e FROM production_step_evidence WHERE organization_id=NEW.organization_id AND id=NEW.completion_id;
 SELECT sum(quantity::numeric) INTO total FROM inventory_output_lines WHERE organization_id=NEW.organization_id AND submission_id=NEW.operation_id;
 IF e.kind IS DISTINCT FROM 'completed' OR e.batch_id IS DISTINCT FROM NEW.production_batch_id OR e.step_number IS DISTINCT FROM NEW.step_number
  OR e.quantity_unit IS DISTINCT FROM 'pieces' OR e.quantity IS DISTINCT FROM NEW.quantity::numeric OR total IS DISTINCT FROM NEW.quantity::numeric
  OR (SELECT count(*) FROM inventory_output_lines WHERE organization_id=NEW.organization_id AND submission_id=NEW.operation_id)<>jsonb_array_length(NEW.request_payload->'outputs')
  OR NOT EXISTS(SELECT 1 FROM process_route_steps s WHERE s.organization_id=e.organization_id AND s.route_id=e.route_id AND s.route_version=e.route_version AND s.step_number=e.step_number AND s.workshop_id=e.workshop_id AND s.stage='sorting' AND s.electrode_line IN ('cathode','anode'))
  OR EXISTS(SELECT 1 FROM process_route_steps s WHERE s.organization_id=e.organization_id AND s.route_id=e.route_id AND s.route_version=e.route_version AND s.step_number>e.step_number AND s.electrode_line IN ('common',(SELECT material_line FROM production_batches WHERE organization_id=e.organization_id AND id=e.batch_id)))
  OR EXISTS(SELECT 1 FROM inventory_output_lines l JOIN inventory_materials m ON m.organization_id=l.organization_id AND m.id=l.material_id WHERE l.organization_id=NEW.organization_id AND l.submission_id=NEW.operation_id AND (m.category<>'electrode' OR m.base_unit<>'pieces'))
 THEN RAISE EXCEPTION 'finished_output_source_required'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER inventory_output_source AFTER INSERT ON inventory_output_submissions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_inventory_output_source();

CREATE FUNCTION require_inventory_output_pair() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a inventory_output_acceptances%ROWTYPE;o inventory_operations%ROWTYPE;l inventory_output_lines%ROWTYPE;s inventory_stocks%ROWTYPE;b uuid;
BEGIN
 IF TG_TABLE_NAME='inventory_operations' THEN
  IF NOT (NEW.request_payload ? 'submissionId') THEN RETURN NEW; END IF;
  o:=NEW;SELECT * INTO a FROM inventory_output_acceptances WHERE operation_id=NEW.operation_id;
 ELSE
  a:=NEW;SELECT * INTO o FROM inventory_operations WHERE operation_id=NEW.operation_id;
 END IF;
 SELECT * INTO l FROM inventory_output_lines WHERE organization_id=a.organization_id AND submission_id=a.submission_id AND grade=a.grade;
 SELECT production_batch_id INTO b FROM inventory_output_submissions WHERE organization_id=a.organization_id AND operation_id=a.submission_id;
 SELECT * INTO s FROM inventory_stocks WHERE organization_id=a.organization_id AND id=a.stock_id;
 IF a.operation_id IS NULL OR o.operation_id IS NULL OR l.submission_id IS NULL OR s.id IS NULL
  OR o.organization_id IS DISTINCT FROM a.organization_id OR o.stock_id IS DISTINCT FROM a.stock_id OR o.actor_id IS DISTINCT FROM a.actor_id OR o.device_id IS DISTINCT FROM a.device_id
  OR o.kind IS DISTINCT FROM 'receive' OR o.quantity IS DISTINCT FROM l.quantity OR o.expected_revision<>0 OR o.resulting_revision<>1 OR o.production_batch_id IS DISTINCT FROM b
  OR o.request_payload IS DISTINCT FROM a.request_payload OR o.result_stock IS DISTINCT FROM a.result_stock
  OR s.material_id IS DISTINCT FROM l.material_id OR s.on_hand IS DISTINCT FROM l.quantity OR s.reserved<>0 OR s.revision<>1 OR s.quality<>'quarantine' OR s.disposition IS NOT NULL
  OR (a.request_payload->>'submissionId')::uuid IS DISTINCT FROM a.submission_id OR a.request_payload->>'grade' IS DISTINCT FROM a.grade
  OR (a.result_stock->>'stockId')::uuid IS DISTINCT FROM s.id OR (a.result_stock->>'materialId')::uuid IS DISTINCT FROM s.material_id
  OR (a.result_stock->>'locationId')::uuid IS DISTINCT FROM s.location_id OR a.result_stock->>'manufacturerLot' IS DISTINCT FROM s.manufacturer_lot
  OR a.result_stock->>'quality' IS DISTINCT FROM 'quarantine' OR a.result_stock->>'unit' IS DISTINCT FROM 'pieces'
  OR (a.result_stock->>'onHand')::bigint IS DISTINCT FROM l.quantity OR (a.result_stock->>'reserved')::bigint IS DISTINCT FROM 0
  OR (a.result_stock->>'available')::bigint IS DISTINCT FROM l.quantity OR (a.result_stock->>'revision')::integer IS DISTINCT FROM 1
 THEN RAISE EXCEPTION 'finished_output_pair_required'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER inventory_output_receipt_pair AFTER INSERT ON inventory_operations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_inventory_output_pair();
CREATE CONSTRAINT TRIGGER inventory_output_acceptance_pair AFTER INSERT ON inventory_output_acceptances DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_inventory_output_pair();

-- Preserve the shared immutable operation namespace across all inventory APIs.
CREATE OR REPLACE FUNCTION enforce_inventory_issue_intent_id() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE other record;incoming_effect boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.operation_id::text,1));
 -- Generated columns are NULL in BEFORE INSERT triggers. Derive their effect
 -- explicitly so SQL three-valued logic cannot allow a zero-stock ID to pair.
 incoming_effect:=CASE
  WHEN TG_TABLE_NAME IN ('inventory_operations','inventory_output_acceptances') THEN true
  WHEN TG_TABLE_NAME='inventory_output_submissions' THEN false
  WHEN TG_TABLE_NAME='inventory_issue_outcomes' THEN to_jsonb(NEW)->>'kind'='return'
  WHEN TG_TABLE_NAME='inventory_count_events' THEN to_jsonb(NEW)->>'kind'='correct'
  ELSE (to_jsonb(NEW)->>'stock_effect')::boolean END;
 FOR other IN
  SELECT 'inventory_operations' AS owner,organization_id,actor_id,device_id,request_payload,true AS stock_effect FROM inventory_operations WHERE operation_id=NEW.operation_id AND TG_TABLE_NAME<>'inventory_operations'
  UNION ALL SELECT 'inventory_issue_events',organization_id,actor_id,device_id,request_payload,stock_effect FROM inventory_issue_events WHERE operation_id=NEW.operation_id AND TG_TABLE_NAME<>'inventory_issue_events'
  UNION ALL SELECT 'inventory_issue_outcomes',organization_id,actor_id,device_id,request_payload,stock_effect FROM inventory_issue_outcomes WHERE operation_id=NEW.operation_id AND TG_TABLE_NAME<>'inventory_issue_outcomes'
  UNION ALL SELECT 'inventory_count_events',organization_id,actor_id,device_id,request_payload,stock_effect FROM inventory_count_events WHERE operation_id=NEW.operation_id AND TG_TABLE_NAME<>'inventory_count_events'
  UNION ALL SELECT 'inventory_output_submissions',organization_id,actor_id,device_id,request_payload,stock_effect FROM inventory_output_submissions WHERE operation_id=NEW.operation_id AND TG_TABLE_NAME<>'inventory_output_submissions'
  UNION ALL SELECT 'inventory_output_acceptances',organization_id,actor_id,device_id,request_payload,stock_effect FROM inventory_output_acceptances WHERE operation_id=NEW.operation_id AND TG_TABLE_NAME<>'inventory_output_acceptances'
 LOOP
  IF other.organization_id<>NEW.organization_id OR other.actor_id<>NEW.actor_id OR other.device_id IS DISTINCT FROM NEW.device_id OR other.request_payload<>NEW.request_payload OR other.stock_effect IS DISTINCT FROM true OR incoming_effect IS DISTINCT FROM true OR TG_TABLE_NAME<>'inventory_operations' AND other.owner<>'inventory_operations' THEN RAISE EXCEPTION 'operation_id_reused' USING ERRCODE='23505'; END IF;
 END LOOP;RETURN NEW;
END $$;
CREATE TRIGGER inventory_output_submission_id BEFORE INSERT ON inventory_output_submissions FOR EACH ROW EXECUTE FUNCTION enforce_inventory_issue_intent_id();
CREATE TRIGGER inventory_output_acceptance_id BEFORE INSERT ON inventory_output_acceptances FOR EACH ROW EXECUTE FUNCTION enforce_inventory_issue_intent_id();
COMMIT;
