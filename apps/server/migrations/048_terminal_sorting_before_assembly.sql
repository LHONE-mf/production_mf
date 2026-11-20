-- Keep finished electrodes tied to the *last electrode-line* Sorting step,
-- while allowing the later common Assembly/cell-production route. Migration 031
-- rejected that valid route, making grade-specific Sorting→Assembly custody
-- impossible for a genuinely approved single-order process. No history rewrite.
CREATE OR REPLACE FUNCTION require_inventory_output_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e production_step_evidence%ROWTYPE;total numeric;
BEGIN
 SELECT * INTO e FROM production_step_evidence WHERE organization_id=NEW.organization_id AND id=NEW.completion_id;
 SELECT sum(quantity::numeric) INTO total FROM inventory_output_lines WHERE organization_id=NEW.organization_id AND submission_id=NEW.operation_id;
 IF e.kind IS DISTINCT FROM 'completed' OR e.batch_id IS DISTINCT FROM NEW.production_batch_id OR e.step_number IS DISTINCT FROM NEW.step_number
  OR e.quantity_unit IS DISTINCT FROM 'pieces' OR e.quantity IS DISTINCT FROM NEW.quantity::numeric OR total IS DISTINCT FROM NEW.quantity::numeric
  OR (SELECT count(*) FROM inventory_output_lines WHERE organization_id=NEW.organization_id AND submission_id=NEW.operation_id)<>jsonb_array_length(NEW.request_payload->'outputs')
  OR NOT EXISTS(SELECT 1 FROM process_route_steps s WHERE s.organization_id=e.organization_id AND s.route_id=e.route_id AND s.route_version=e.route_version AND s.step_number=e.step_number AND s.workshop_id=e.workshop_id AND s.stage='sorting' AND s.electrode_line IN ('cathode','anode'))
  OR EXISTS(SELECT 1 FROM process_route_steps s WHERE s.organization_id=e.organization_id AND s.route_id=e.route_id AND s.route_version=e.route_version AND s.step_number>e.step_number AND
     (s.electrode_line=(SELECT material_line FROM production_batches WHERE organization_id=e.organization_id AND id=e.batch_id)
       OR (s.electrode_line='common' AND NOT EXISTS(
         SELECT 1 FROM process_route_steps a WHERE a.organization_id=s.organization_id
          AND a.route_id=s.route_id AND a.route_version=s.route_version
          AND a.electrode_line='common' AND a.stage='assembly'
          AND a.step_number>e.step_number AND a.step_number<=s.step_number))))
  OR EXISTS(SELECT 1 FROM inventory_output_lines l JOIN inventory_materials m ON m.organization_id=l.organization_id AND m.id=l.material_id WHERE l.organization_id=NEW.organization_id AND l.submission_id=NEW.operation_id AND (m.category<>'electrode' OR m.base_unit<>'pieces'))
 THEN RAISE EXCEPTION 'finished_output_source_required'; END IF;
 RETURN NEW;
END $$;
