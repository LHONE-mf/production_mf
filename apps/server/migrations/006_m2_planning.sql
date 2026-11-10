-- M2 planning foundation: additive schema only. No legacy journal, task or
-- production rows are migrated, deleted or silently enrolled.
-- Route versions are independently identified by (organization, route, version).
BEGIN;

CREATE TABLE IF NOT EXISTS process_routes (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  id uuid NOT NULL,
  code text NOT NULL CHECK (length(trim(code)) BETWEEN 1 AND 80 AND code = trim(code)),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 300),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, code),
  FOREIGN KEY (organization_id, created_by) REFERENCES users(organization_id, id)
);

CREATE TABLE IF NOT EXISTS process_route_versions (
  organization_id uuid NOT NULL,
  route_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'approved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  approved_by uuid,
  PRIMARY KEY (organization_id, route_id, version),
  FOREIGN KEY (organization_id, route_id) REFERENCES process_routes(organization_id, id),
  FOREIGN KEY (organization_id, approved_by) REFERENCES users(organization_id, id),
  CHECK ((state = 'draft' AND approved_at IS NULL AND approved_by IS NULL)
      OR (state = 'approved' AND approved_at IS NOT NULL AND approved_by IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS process_route_steps (
  organization_id uuid NOT NULL,
  route_id uuid NOT NULL,
  route_version integer NOT NULL,
  step_number integer NOT NULL CHECK (step_number > 0),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 300),
  stage text NOT NULL CHECK (stage IN (
    'storage', 'slurry', 'coating', 'calendaring', 'cutting',
    'sorting', 'assembly', 'electrolyte', 'electrolyte-705',
    'walzing', 'formation'
  )),
  workshop_id text NOT NULL,
  electrode_line text NOT NULL DEFAULT 'common'
    CHECK (electrode_line IN ('cathode', 'anode', 'common')),
  PRIMARY KEY (organization_id, route_id, route_version, step_number),
  FOREIGN KEY (organization_id, route_id, route_version)
    REFERENCES process_route_versions(organization_id, route_id, version),
  FOREIGN KEY (organization_id, workshop_id)
    REFERENCES workshops(organization_id, id)
);

-- Once a route is approved, neither its metadata nor its step list may be
-- rewritten. Changes require a new version, preserving released order history.
CREATE OR REPLACE FUNCTION enforce_approved_process_route_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE is_approved boolean;
BEGIN
  IF TG_TABLE_NAME = 'process_route_versions' THEN
    IF TG_OP = 'DELETE' AND OLD.state = 'approved' THEN
      RAISE EXCEPTION 'approved route version is immutable';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.state = 'approved' THEN
      RAISE EXCEPTION 'approved route version is immutable';
    END IF;
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP <> 'INSERT' THEN
    SELECT state = 'approved' INTO is_approved
      FROM process_route_versions
      WHERE organization_id = OLD.organization_id AND route_id = OLD.route_id
        AND version = OLD.route_version
      FOR UPDATE;
    IF COALESCE(is_approved, false) THEN
      RAISE EXCEPTION 'approved route steps are immutable';
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT state = 'approved' INTO is_approved
      FROM process_route_versions
      WHERE organization_id = NEW.organization_id AND route_id = NEW.route_id
        AND version = NEW.route_version
      FOR UPDATE;
    IF COALESCE(is_approved, false) THEN
      RAISE EXCEPTION 'approved route steps are immutable';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$$;
DROP TRIGGER IF EXISTS route_version_immutable ON process_route_versions;
CREATE TRIGGER route_version_immutable
BEFORE UPDATE OR DELETE ON process_route_versions
FOR EACH ROW EXECUTE FUNCTION enforce_approved_process_route_immutable();
DROP TRIGGER IF EXISTS approved_route_steps_immutable ON process_route_steps;
CREATE TRIGGER approved_route_steps_immutable
BEFORE INSERT OR UPDATE OR DELETE ON process_route_steps
FOR EACH ROW EXECUTE FUNCTION enforce_approved_process_route_immutable();

CREATE TABLE IF NOT EXISTS production_orders (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  id uuid NOT NULL,
  order_code text NOT NULL CHECK (length(trim(order_code)) BETWEEN 1 AND 80 AND order_code = trim(order_code)),
  product_code text NOT NULL CHECK (length(trim(product_code)) BETWEEN 1 AND 120 AND product_code = trim(product_code)),
  route_id uuid NOT NULL,
  route_version integer NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'planned', 'released', 'in_progress', 'completed', 'cancelled')),
  planned_quantity numeric(18,6) NOT NULL CHECK (planned_quantity > 0),
  quantity_unit text NOT NULL CHECK (quantity_unit IN ('cells', 'pieces', 'kg', 'm', 'm2')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, order_code),
  FOREIGN KEY (organization_id, route_id, route_version)
    REFERENCES process_route_versions(organization_id, route_id, version),
  FOREIGN KEY (organization_id, created_by) REFERENCES users(organization_id, id)
);

CREATE TABLE IF NOT EXISTS production_batches (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  id uuid NOT NULL,
  order_id uuid NOT NULL,
  batch_code text NOT NULL CHECK (length(trim(batch_code)) BETWEEN 1 AND 100 AND batch_code = trim(batch_code)),
  material_line text NOT NULL CHECK (material_line IN ('cathode', 'anode', 'cell')),
  status text NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'in_progress', 'hold', 'completed', 'scrapped')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, batch_code),
  FOREIGN KEY (organization_id, order_id) REFERENCES production_orders(organization_id, id),
  FOREIGN KEY (organization_id, created_by) REFERENCES users(organization_id, id)
);
CREATE INDEX IF NOT EXISTS production_batches_order_idx
  ON production_batches(organization_id, order_id);

COMMIT;
