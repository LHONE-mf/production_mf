-- Additive SKU/issue metadata only. No historical unit, count or specification is inferred.
BEGIN;
ALTER TABLE inventory_materials DROP CONSTRAINT inventory_materials_base_unit_check;
ALTER TABLE inventory_materials ADD CONSTRAINT inventory_materials_base_unit_check CHECK(base_unit IN ('mg','ul','mm','pieces','rolls'));
ALTER TABLE inventory_issues DROP CONSTRAINT inventory_issues_unit_check;
ALTER TABLE inventory_issues ADD CONSTRAINT inventory_issues_unit_check CHECK(unit IN ('mg','ul','mm','pieces','rolls'));
ALTER TABLE inventory_materials ADD COLUMN tape_specification jsonb;
ALTER TABLE inventory_issues ADD COLUMN tape_specification jsonb;
ALTER TABLE inventory_issues ADD COLUMN operation_reference text;

CREATE FUNCTION inventory_tape_specification_valid(spec jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN jsonb_typeof(spec)='object' THEN COALESCE(
  (SELECT count(*) FROM jsonb_object_keys(spec))=4
  AND spec->>'application' IN ('coating_support','assembly_tab_insulation','assembly_winding')
  AND jsonb_typeof(spec->'application')='string'
  AND jsonb_typeof(spec->'widthMm')='string' AND jsonb_typeof(spec->'thicknessUm')='string'
  AND spec->>'widthMm' ~ '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,12})?$' AND spec->>'widthMm' ~ '[1-9]'
  AND spec->>'thicknessUm' ~ '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,12})?$' AND spec->>'thicknessUm' ~ '[1-9]'
  AND jsonb_typeof(spec->'reference')='string' AND length(spec->>'reference') BETWEEN 1 AND 200
  AND btrim(spec->>'reference')=spec->>'reference',false) ELSE false END
$$;
ALTER TABLE inventory_materials ADD CONSTRAINT inventory_material_tape_check CHECK(tape_specification IS NULL OR (category='component' AND base_unit='rolls' AND inventory_tape_specification_valid(tape_specification)));
ALTER TABLE inventory_issues ADD CONSTRAINT inventory_issue_tape_check CHECK(
 (tape_specification IS NULL AND operation_reference IS NULL) OR
 (tape_specification IS NOT NULL AND unit='rolls' AND inventory_tape_specification_valid(tape_specification) AND operation_reference IS NOT NULL AND length(btrim(operation_reference)) BETWEEN 1 AND 2000));

CREATE FUNCTION inventory_tape_material_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.tape_specification IS DISTINCT FROM OLD.tape_specification OR
    ((OLD.base_unit='rolls' OR NEW.base_unit='rolls') AND (NEW.base_unit,NEW.category) IS DISTINCT FROM (OLD.base_unit,OLD.category)) THEN
  RAISE EXCEPTION 'inventory_tape_identity_immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_tape_material_identity BEFORE UPDATE ON inventory_materials FOR EACH ROW EXECUTE FUNCTION inventory_tape_material_identity();

CREATE FUNCTION inventory_tape_issue_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE material inventory_materials; stage text;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF (NEW.tape_specification,NEW.operation_reference) IS DISTINCT FROM (OLD.tape_specification,OLD.operation_reference) OR
   (OLD.tape_specification IS NOT NULL AND (NEW.material_id,NEW.unit,NEW.production_batch_id,NEW.step_number,NEW.workshop_id) IS DISTINCT FROM (OLD.material_id,OLD.unit,OLD.production_batch_id,OLD.step_number,OLD.workshop_id)) THEN
   RAISE EXCEPTION 'inventory_tape_identity_immutable';
  END IF;
 ELSE
  SELECT * INTO material FROM inventory_materials m WHERE m.organization_id=NEW.organization_id AND m.id=NEW.material_id;
  IF NEW.tape_specification IS DISTINCT FROM material.tape_specification OR (material.tape_specification IS NOT NULL AND NEW.unit<>'rolls') THEN RAISE EXCEPTION 'inventory_tape_specification_mismatch'; END IF;
  IF NEW.tape_specification IS NOT NULL THEN
   SELECT s.stage INTO stage FROM production_batches b JOIN production_orders o ON o.organization_id=b.organization_id AND o.id=b.order_id
    JOIN process_route_steps s ON s.organization_id=o.organization_id AND s.route_id=o.route_id AND s.route_version=o.route_version
    WHERE b.organization_id=NEW.organization_id AND b.id=NEW.production_batch_id AND s.step_number=NEW.step_number AND s.workshop_id=NEW.workshop_id
     AND s.electrode_line=CASE WHEN b.material_line='cell' THEN 'common' ELSE b.material_line END;
   IF stage IS DISTINCT FROM (CASE WHEN NEW.tape_specification->>'application'='coating_support' THEN 'coating' ELSE 'assembly' END) THEN RAISE EXCEPTION 'inventory_tape_operation_mismatch'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_tape_issue_identity BEFORE INSERT OR UPDATE ON inventory_issues FOR EACH ROW EXECUTE FUNCTION inventory_tape_issue_identity();

CREATE FUNCTION inventory_tape_issue_ack() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE issue inventory_issues;
BEGIN
 SELECT * INTO issue FROM inventory_issues i WHERE i.organization_id=NEW.organization_id AND i.id=NEW.issue_id;
 IF NEW.result_issue->'tapeSpecification' IS DISTINCT FROM issue.tape_specification OR NEW.result_issue->>'operationReference' IS DISTINCT FROM issue.operation_reference OR
  (NEW.kind='request' AND (NEW.request_payload->'tapeSpecification' IS DISTINCT FROM issue.tape_specification OR NEW.request_payload->>'operationReference' IS DISTINCT FROM issue.operation_reference)) THEN
  RAISE EXCEPTION 'inventory_tape_ack_mismatch';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_tape_issue_ack BEFORE INSERT ON inventory_issue_events FOR EACH ROW EXECUTE FUNCTION inventory_tape_issue_ack();
COMMIT;
