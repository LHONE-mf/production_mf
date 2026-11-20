-- Direct, unreviewed Sorting -> Assembly piece custody. Never creates stock or authorizes cell pairing.
-- Source is an existing, verified three-station Sorting output submission (migration 031).
BEGIN;
CREATE TABLE inventory_assembly_electrode_handoffs (
 operation_id uuid PRIMARY KEY,
 organization_id uuid NOT NULL,
 submission_id uuid NOT NULL,
 grade text NOT NULL CHECK(length(btrim(grade)) BETWEEN 1 AND 120),
 material_id uuid NOT NULL,
 source_batch_id uuid NOT NULL,
 assembly_batch_id uuid NOT NULL,
 assembly_step_number integer NOT NULL CHECK(assembly_step_number > 0),
 recipient_id uuid NOT NULL,
 recipient_workshop_id text NOT NULL,
 quantity bigint NOT NULL CHECK(quantity BETWEEN 1 AND 9007199254740991),
 actor_id uuid NOT NULL,
 device_id uuid NOT NULL,
 epoch uuid NOT NULL,
 request_payload jsonb NOT NULL,
 result_payload jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(organization_id,operation_id),
 UNIQUE(organization_id,submission_id,grade),
 FOREIGN KEY(organization_id,submission_id,grade)
  REFERENCES inventory_output_lines(organization_id,submission_id,grade),
 FOREIGN KEY(organization_id,source_batch_id) REFERENCES production_batches(organization_id,id),
 FOREIGN KEY(organization_id,assembly_batch_id) REFERENCES production_batches(organization_id,id),
 FOREIGN KEY(organization_id,recipient_id) REFERENCES users(organization_id,id),
 FOREIGN KEY(organization_id,actor_id) REFERENCES users(organization_id,id),
 FOREIGN KEY(organization_id,device_id) REFERENCES devices(organization_id,id)
);
CREATE TABLE inventory_assembly_electrode_receipts (
 operation_id uuid PRIMARY KEY,
 organization_id uuid NOT NULL,
 handoff_id uuid NOT NULL,
 actor_id uuid NOT NULL,
 device_id uuid NOT NULL,
 epoch uuid NOT NULL,
 observed_quantity bigint NOT NULL CHECK(observed_quantity BETWEEN 1 AND 9007199254740991),
 observed_grade text NOT NULL CHECK(length(btrim(observed_grade)) BETWEEN 1 AND 120),
 observed_label text NOT NULL CHECK(length(btrim(observed_label)) BETWEEN 1 AND 200),
 request_payload jsonb NOT NULL,
 result_payload jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(organization_id,operation_id),
 UNIQUE(organization_id,handoff_id),
 FOREIGN KEY(organization_id,handoff_id) REFERENCES inventory_assembly_electrode_handoffs(organization_id,operation_id),
 FOREIGN KEY(organization_id,actor_id) REFERENCES users(organization_id,id),
 FOREIGN KEY(organization_id,device_id) REFERENCES devices(organization_id,id)
);
CREATE INDEX inventory_assembly_receiving_queue ON inventory_assembly_electrode_handoffs(organization_id,recipient_id,operation_id);
CREATE TRIGGER assembly_electrode_handoff_immutable BEFORE UPDATE OR DELETE ON inventory_assembly_electrode_handoffs
 FOR EACH ROW EXECUTE FUNCTION forbid_inventory_operation_rewrite();
CREATE TRIGGER assembly_electrode_receipt_immutable BEFORE UPDATE OR DELETE ON inventory_assembly_electrode_receipts
 FOR EACH ROW EXECUTE FUNCTION forbid_inventory_operation_rewrite();

-- The warehouse and the direct Assembly route cannot both claim the same grade.
-- This is checked in PostgreSQL as well as in the authenticated API.
CREATE FUNCTION guard_assembly_electrode_channel() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line inventory_output_lines; batch production_batches; target text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':inventory-sequence',0));
 IF TG_TABLE_NAME='inventory_output_acceptances' THEN
  IF EXISTS(SELECT 1 FROM inventory_assembly_electrode_handoffs h
   WHERE h.organization_id=NEW.organization_id AND h.submission_id=NEW.submission_id AND h.grade=NEW.grade)
  THEN RAISE EXCEPTION 'electrode_output_already_sent_to_assembly'; END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO line FROM inventory_output_lines
  WHERE organization_id=NEW.organization_id AND submission_id=NEW.submission_id AND grade=NEW.grade;
 SELECT b.* INTO batch FROM inventory_output_submissions s
  JOIN production_batches b ON b.organization_id=s.organization_id AND b.id=s.production_batch_id
  WHERE s.organization_id=NEW.organization_id AND s.operation_id=NEW.submission_id;
 SELECT s.workshop_id INTO target FROM production_batches b
  JOIN production_orders o ON o.organization_id=b.organization_id AND o.id=b.order_id
  JOIN process_route_steps s ON s.organization_id=o.organization_id AND s.route_id=o.route_id
    AND s.route_version=o.route_version AND s.step_number=NEW.assembly_step_number AND s.electrode_line='common'
  WHERE b.organization_id=NEW.organization_id AND b.id=NEW.assembly_batch_id AND b.material_line='cell'
   AND b.status IN ('created','in_progress') AND o.status IN ('released','in_progress') AND s.stage='assembly';
 IF line.submission_id IS NULL OR line.material_id IS DISTINCT FROM NEW.material_id
  OR line.quantity IS DISTINCT FROM NEW.quantity OR batch.id IS DISTINCT FROM NEW.source_batch_id
  OR batch.material_line NOT IN ('cathode','anode') OR batch.status NOT IN ('created','in_progress')
  OR target IS NULL OR target IS DISTINCT FROM NEW.recipient_workshop_id
  OR NOT EXISTS(SELECT 1 FROM users u JOIN user_workshop_memberships m
      ON m.organization_id=u.organization_id AND m.user_id=u.id AND m.workshop_id=target
      WHERE u.organization_id=NEW.organization_id AND u.id=NEW.recipient_id AND u.active)
  OR NOT EXISTS(SELECT 1 FROM users u JOIN devices d
      ON d.organization_id=u.organization_id AND d.user_id=u.id AND d.id=NEW.device_id AND d.revoked_at IS NULL
      WHERE u.organization_id=NEW.organization_id AND u.id=NEW.actor_id AND u.active AND u.role IN ('chief','master'))
  OR EXISTS(SELECT 1 FROM inventory_output_acceptances a
      WHERE a.organization_id=NEW.organization_id AND a.submission_id=NEW.submission_id AND a.grade=NEW.grade)
  OR NOT EXISTS(SELECT 1 FROM inventory_streams i WHERE i.organization_id=NEW.organization_id
      AND i.epoch=NEW.epoch AND i.posting_enabled)
 THEN RAISE EXCEPTION 'assembly_electrode_source_or_route_ineligible'; END IF;
 IF NEW.request_payload->>'operationId' IS DISTINCT FROM NEW.operation_id::text
  OR NEW.request_payload->>'deviceId' IS DISTINCT FROM NEW.device_id::text
  OR NEW.request_payload->>'submissionId' IS DISTINCT FROM NEW.submission_id::text
  OR NEW.request_payload->>'grade' IS DISTINCT FROM NEW.grade
  OR NEW.request_payload->>'quantity' IS DISTINCT FROM NEW.quantity::text
  OR NEW.request_payload->>'assemblyBatchId' IS DISTINCT FROM NEW.assembly_batch_id::text
  OR (NEW.request_payload->>'assemblyStepNumber')::integer IS DISTINCT FROM NEW.assembly_step_number
  OR NEW.request_payload->>'recipientId' IS DISTINCT FROM NEW.recipient_id::text
  OR NEW.result_payload IS DISTINCT FROM NEW.request_payload || jsonb_build_object(
      'sourceBatchId',NEW.source_batch_id,'materialId',NEW.material_id,
      'recipientWorkshopId',NEW.recipient_workshop_id,'actorId',NEW.actor_id,
      'recordedAt',NEW.result_payload->'recordedAt','warehouseEffect','none',
      'qualityStatus','unreviewed')
  OR (NEW.result_payload->>'recordedAt')::timestamptz IS DISTINCT FROM NEW.recorded_at
 THEN RAISE EXCEPTION 'assembly_electrode_handoff_mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER assembly_electrode_handoff_guard BEFORE INSERT ON inventory_assembly_electrode_handoffs
 FOR EACH ROW EXECUTE FUNCTION guard_assembly_electrode_channel();
CREATE TRIGGER finished_electrode_warehouse_channel_guard BEFORE INSERT ON inventory_output_acceptances
 FOR EACH ROW EXECUTE FUNCTION guard_assembly_electrode_channel();

CREATE FUNCTION guard_assembly_electrode_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE offer inventory_assembly_electrode_handoffs;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':inventory-sequence',0));
 SELECT * INTO offer FROM inventory_assembly_electrode_handoffs
  WHERE organization_id=NEW.organization_id AND operation_id=NEW.handoff_id;
 IF offer.operation_id IS NULL OR offer.recipient_id IS DISTINCT FROM NEW.actor_id
  OR NEW.observed_quantity IS DISTINCT FROM offer.quantity OR NEW.observed_grade IS DISTINCT FROM offer.grade
  OR NEW.observed_label IS DISTINCT FROM 'production:'||offer.submission_id::text||':'||offer.grade
  OR NOT EXISTS(SELECT 1 FROM users u JOIN devices d
     ON d.organization_id=u.organization_id AND d.user_id=u.id AND d.id=NEW.device_id AND d.revoked_at IS NULL
     JOIN user_workshop_memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id
       AND m.workshop_id=offer.recipient_workshop_id
     WHERE u.organization_id=NEW.organization_id AND u.id=NEW.actor_id AND u.active)
  OR NOT EXISTS(SELECT 1 FROM inventory_streams i WHERE i.organization_id=NEW.organization_id
      AND i.epoch=NEW.epoch AND i.posting_enabled)
 THEN RAISE EXCEPTION 'assembly_electrode_receipt_ineligible'; END IF;
 IF NEW.request_payload->>'operationId' IS DISTINCT FROM NEW.operation_id::text
  OR NEW.request_payload->>'deviceId' IS DISTINCT FROM NEW.device_id::text
  OR NEW.request_payload->>'handoffId' IS DISTINCT FROM NEW.handoff_id::text
  OR (NEW.request_payload->>'observedQuantity')::numeric IS DISTINCT FROM NEW.observed_quantity
  OR NEW.request_payload->>'observedGrade' IS DISTINCT FROM NEW.observed_grade
  OR NEW.request_payload->>'observedLabel' IS DISTINCT FROM NEW.observed_label
  OR NEW.result_payload IS DISTINCT FROM NEW.request_payload || jsonb_build_object(
      'sourceSnapshot',offer.result_payload,'actorId',NEW.actor_id,
      'recordedAt',NEW.result_payload->'recordedAt','custodyEffect','received',
      'warehouseEffect','none','qualityStatus','unreviewed')
  OR (NEW.result_payload->>'recordedAt')::timestamptz IS DISTINCT FROM NEW.recorded_at
 THEN RAISE EXCEPTION 'assembly_electrode_receipt_mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER assembly_electrode_receipt_guard BEFORE INSERT ON inventory_assembly_electrode_receipts
 FOR EACH ROW EXECUTE FUNCTION guard_assembly_electrode_receipt();
COMMIT;
