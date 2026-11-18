-- Direct counted-piece custody, preserving all earlier Slurry and roll streams.
BEGIN;
CREATE FUNCTION guard_cutting_piece_handoff(entry inventory_room_handoffs) RETURNS void LANGUAGE plpgsql AS $$
DECLARE lot inventory_room_output_lots; output inventory_cutting_outputs; target text; sender text; n bigint; reserved numeric; snapshot jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM inventory_streams WHERE organization_id=entry.organization_id AND epoch=entry.epoch AND posting_enabled) THEN RAISE EXCEPTION 'inventory_epoch_changed'; END IF;
 SELECT * INTO lot FROM inventory_room_output_lots WHERE organization_id=entry.organization_id AND id=entry.output_lot_id;
 SELECT * INTO output FROM inventory_cutting_outputs WHERE organization_id=entry.organization_id AND operation_id=lot.cutting_declaration_id;
 SELECT s.workshop_id INTO sender FROM production_batches b JOIN production_orders o ON o.organization_id=b.organization_id AND o.id=b.order_id
 JOIN process_route_steps s ON s.organization_id=o.organization_id AND s.route_id=o.route_id AND s.route_version=o.route_version AND s.step_number=output.step_number AND s.electrode_line=CASE WHEN b.material_line='cell' THEN 'common' ELSE b.material_line END
 JOIN users u ON u.organization_id=b.organization_id AND u.id=entry.actor_id AND u.active JOIN devices d ON d.organization_id=u.organization_id AND d.user_id=u.id AND d.id=entry.device_id AND d.revoked_at IS NULL
 WHERE b.organization_id=entry.organization_id AND b.id=output.production_batch_id AND b.status IN ('created','in_progress') AND o.status IN ('released','in_progress') AND s.stage='cutting'
 AND (u.role='chief' OR (u.id=output.actor_id OR u.role='master') AND EXISTS(SELECT 1 FROM user_workshop_memberships w WHERE w.organization_id=u.organization_id AND w.user_id=u.id AND w.workshop_id=s.workshop_id));
 SELECT s.workshop_id INTO target FROM production_batches b JOIN production_orders o ON o.organization_id=b.organization_id AND o.id=b.order_id
 JOIN process_route_steps s ON s.organization_id=o.organization_id AND s.route_id=o.route_id AND s.route_version=o.route_version AND s.step_number=entry.destination_step AND s.electrode_line=CASE WHEN b.material_line='cell' THEN 'common' ELSE b.material_line END
 WHERE b.organization_id=entry.organization_id AND b.id=output.production_batch_id AND s.stage='sorting' AND s.step_number=(SELECT min(p.step_number) FROM process_route_steps p WHERE p.organization_id=s.organization_id AND p.route_id=s.route_id AND p.route_version=s.route_version AND p.electrode_line=s.electrode_line AND p.step_number>output.step_number);
 IF sender IS NULL OR target IS NULL OR entry.production_batch_id IS DISTINCT FROM output.production_batch_id OR target IS DISTINCT FROM entry.recipient_workshop_id OR NOT EXISTS(SELECT 1 FROM user_workshop_memberships w JOIN users u ON u.organization_id=w.organization_id AND u.id=w.user_id AND u.active WHERE w.organization_id=entry.organization_id AND w.user_id=entry.recipient_id AND w.workshop_id=target) THEN RAISE EXCEPTION 'cutting_piece_route_or_authority_required'; END IF;
 snapshot:=room_output_snapshot(entry.organization_id,lot.id);
 IF snapshot->'lot'->>'disposition' IS DISTINCT FROM 'ready' OR NOT cutting_output_inputs_eligible(entry.organization_id,output.request_payload) OR NOT EXISTS(SELECT 1 FROM inventory_materials m WHERE m.organization_id=entry.organization_id AND m.id=lot.material_id AND m.active AND m.base_unit='pieces' AND m.category='electrode') THEN RAISE EXCEPTION 'cutting_piece_held'; END IF;
 SELECT count(*),COALESCE(sum(quantity),0) INTO n,reserved FROM inventory_room_handoffs WHERE organization_id=entry.organization_id AND output_lot_id=lot.id;
 IF entry.quantity<1 OR entry.quantity>lot.quantity-reserved OR entry.expected_revision<>n+1 THEN RAISE EXCEPTION 'cutting_piece_already_reserved'; END IF;
 IF entry.request_payload->>'unit' IS DISTINCT FROM 'pieces' OR entry.output_snapshot IS DISTINCT FROM snapshot OR entry.result_payload IS DISTINCT FROM entry.request_payload||jsonb_build_object('productionBatchId',output.production_batch_id,'sourceRoom','cutting','destinationRoom','sorting','recipientWorkshopId',target,'sourceSnapshot',snapshot,'actorId',entry.actor_id,'recordedAt',entry.result_payload->'recordedAt','unit','pieces','warehouseEffect','none')
 OR entry.request_payload->>'operationId' IS DISTINCT FROM entry.operation_id::text OR entry.request_payload->>'deviceId' IS DISTINCT FROM entry.device_id::text OR entry.request_payload->>'outputLotId' IS DISTINCT FROM lot.id::text OR (entry.request_payload->>'quantity')::numeric IS DISTINCT FROM entry.quantity::numeric
 OR (entry.request_payload->>'expectedSourceRevision')::numeric IS DISTINCT FROM entry.expected_revision::numeric OR (entry.request_payload->>'destinationStepNumber')::integer IS DISTINCT FROM entry.destination_step OR entry.request_payload->>'recipientId' IS DISTINCT FROM entry.recipient_id::text OR (entry.result_payload->>'recordedAt')::timestamptz IS DISTINCT FROM entry.recorded_at THEN RAISE EXCEPTION 'cutting_piece_handoff_ack_required'; END IF;
END $$;
CREATE FUNCTION guard_sorting_piece_receipt(entry inventory_room_handoff_events) RETURNS void LANGUAGE plpgsql AS $$
DECLARE handoff inventory_room_handoffs; output inventory_cutting_outputs; label text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM inventory_streams WHERE organization_id=entry.organization_id AND epoch=entry.epoch AND posting_enabled) THEN RAISE EXCEPTION 'inventory_epoch_changed'; END IF;
 SELECT * INTO handoff FROM inventory_room_handoffs WHERE organization_id=entry.organization_id AND operation_id=entry.handoff_id;
 SELECT c.* INTO output FROM inventory_room_output_lots l JOIN inventory_cutting_outputs c ON c.organization_id=l.organization_id AND c.operation_id=l.cutting_declaration_id WHERE l.organization_id=entry.organization_id AND l.id=handoff.output_lot_id;
 IF handoff.operation_id IS NULL OR handoff.recipient_id<>entry.actor_id OR NOT EXISTS(SELECT 1 FROM users u JOIN devices d ON d.organization_id=u.organization_id AND d.user_id=u.id AND d.id=entry.device_id AND d.revoked_at IS NULL JOIN user_workshop_memberships w ON w.organization_id=u.organization_id AND w.user_id=u.id AND w.workshop_id=handoff.recipient_workshop_id WHERE u.organization_id=entry.organization_id AND u.id=entry.actor_id AND u.active) THEN RAISE EXCEPTION 'assigned_piece_receiver_required'; END IF;
 IF EXISTS(SELECT 1 FROM inventory_room_handoff_events WHERE organization_id=entry.organization_id AND handoff_id=handoff.operation_id AND kind='receive') THEN RAISE EXCEPTION 'cutting_piece_already_received'; END IF;
 label:=handoff.output_snapshot->'lot'->>'label';
 IF entry.kind='receive' AND (entry.observed_quantity IS DISTINCT FROM handoff.quantity OR entry.request_payload->>'observedLotLabel' IS DISTINCT FROM label OR NOT cutting_output_inputs_eligible(entry.organization_id,output.request_payload)
 OR NOT EXISTS(SELECT 1 FROM production_batches b JOIN production_orders o ON o.organization_id=b.organization_id AND o.id=b.order_id JOIN process_route_steps s ON s.organization_id=o.organization_id AND s.route_id=o.route_id AND s.route_version=o.route_version AND s.step_number=handoff.destination_step AND s.workshop_id=handoff.recipient_workshop_id AND s.electrode_line=CASE WHEN b.material_line='cell' THEN 'common' ELSE b.material_line END WHERE b.organization_id=entry.organization_id AND b.id=handoff.production_batch_id AND b.status IN ('created','in_progress') AND o.status IN ('released','in_progress') AND s.stage='sorting')
 OR NOT EXISTS(SELECT 1 FROM inventory_room_output_lots l JOIN inventory_materials m ON m.organization_id=l.organization_id AND m.id=l.material_id WHERE l.organization_id=entry.organization_id AND l.id=handoff.output_lot_id AND m.active AND m.base_unit='pieces')) THEN RAISE EXCEPTION 'cutting_piece_receipt_identity_or_hold'; END IF;
 IF entry.request_payload->>'unit' IS DISTINCT FROM 'pieces' OR NOT(entry.request_payload ? 'observedLotLabel') OR (entry.request_payload->'observedLotLabel'<>'null'::jsonb AND NOT COALESCE(length(btrim(entry.request_payload->>'observedLotLabel')) BETWEEN 1 AND 200,false)) OR NOT COALESCE(length(btrim(entry.request_payload->>'measurementNote')) BETWEEN 1 AND 2000,false)
 OR entry.request_payload->>'operationId' IS DISTINCT FROM entry.operation_id::text OR entry.request_payload->>'deviceId' IS DISTINCT FROM entry.device_id::text OR entry.request_payload->>'handoffId' IS DISTINCT FROM handoff.operation_id::text OR entry.request_payload->>'kind' IS DISTINCT FROM entry.kind OR (entry.request_payload->>'observedQuantity')::numeric IS DISTINCT FROM entry.observed_quantity::numeric
 OR entry.result_payload IS DISTINCT FROM entry.request_payload||jsonb_build_object('sourceSnapshot',handoff.result_payload,'actorId',entry.actor_id,'recordedAt',entry.result_payload->'recordedAt','custodyEffect',CASE WHEN entry.kind='receive' THEN 'received' ELSE 'none' END,'unit','pieces','warehouseEffect','none') OR (entry.result_payload->>'recordedAt')::timestamptz IS DISTINCT FROM entry.recorded_at THEN RAISE EXCEPTION 'cutting_piece_receipt_ack_required'; END IF;
END $$;
CREATE OR REPLACE FUNCTION guard_room_handoff() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE l inventory_room_output_lots%ROWTYPE; d inventory_room_outputs%ROWTYPE; c inventory_slurry_consumptions%ROWTYPE; u users%ROWTYPE; n bigint; reserved numeric; target_workshop text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':inventory-sequence',0));
 SELECT * INTO l FROM inventory_room_output_lots WHERE organization_id=NEW.organization_id AND id=NEW.output_lot_id;
 IF l.cutting_declaration_id IS NOT NULL THEN PERFORM guard_cutting_piece_handoff(NEW);RETURN NEW;END IF;
 IF l.calendaring_declaration_id IS NOT NULL THEN PERFORM guard_calendaring_roll_handoff(NEW);RETURN NEW;END IF;
 IF l.coating_declaration_id IS NOT NULL THEN PERFORM guard_coating_roll_handoff(NEW);RETURN NEW;END IF;
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
CREATE OR REPLACE FUNCTION guard_room_handoff_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h inventory_room_handoffs%ROWTYPE; consumption uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':inventory-sequence',0));
 SELECT * INTO h FROM inventory_room_handoffs WHERE organization_id=NEW.organization_id AND operation_id=NEW.handoff_id;
 IF EXISTS(SELECT 1 FROM inventory_room_output_lots WHERE organization_id=NEW.organization_id AND id=h.output_lot_id AND cutting_declaration_id IS NOT NULL) THEN PERFORM guard_sorting_piece_receipt(NEW);RETURN NEW;END IF;
 IF EXISTS(SELECT 1 FROM inventory_room_output_lots WHERE organization_id=NEW.organization_id AND id=h.output_lot_id AND calendaring_declaration_id IS NOT NULL) THEN PERFORM guard_calendaring_roll_receipt(NEW);RETURN NEW;END IF;
 IF h.output_snapshot->>'unit'='rolls' THEN PERFORM guard_coating_roll_receipt(NEW);RETURN NEW;END IF;
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
CREATE OR REPLACE FUNCTION coating_slurry_balance(org uuid,receipt uuid) RETURNS jsonb LANGUAGE sql VOLATILE AS $$
 SELECT jsonb_build_object('receipt',e.result_payload,'received',e.observed_quantity,'consumed',a.consumed,
  'remaining',e.observed_quantity-a.consumed,'revision',a.n+1)
 FROM inventory_room_handoff_events e LEFT JOIN LATERAL(
  SELECT count(*) AS n,COALESCE(sum(quantity::numeric),0) AS consumed FROM inventory_coating_allocations
  WHERE organization_id=e.organization_id AND receipt_id=e.operation_id) a ON true
 WHERE e.organization_id=org AND e.operation_id=receipt AND e.kind='receive' AND e.result_payload->>'unit'='mg' AND e.result_payload->'sourceSnapshot'->>'destinationRoom'='coating'
$$;
COMMIT;
