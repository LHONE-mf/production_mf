-- Chief review authorizes client cache reconciliation only, never a stock posting.
BEGIN;
CREATE TABLE IF NOT EXISTS inventory_recovery_approvals (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES organizations(id),
 epoch uuid NOT NULL,
 target_actor_id uuid NOT NULL,
 target_device_id uuid NOT NULL,
 approved_by uuid NOT NULL,
 approval_device_id uuid NOT NULL,
 evidence_digest text NOT NULL CHECK(evidence_digest ~ '^[a-f0-9]{64}$'),
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 2000),
 evidence text NOT NULL CHECK(length(trim(evidence)) BETWEEN 1 AND 2000),
 request_payload jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,target_actor_id) REFERENCES users(organization_id,id),
 FOREIGN KEY(organization_id,target_device_id) REFERENCES devices(organization_id,id),
 FOREIGN KEY(organization_id,approved_by) REFERENCES users(organization_id,id),
 FOREIGN KEY(organization_id,approval_device_id) REFERENCES devices(organization_id,id)
);
CREATE INDEX IF NOT EXISTS inventory_recovery_target ON inventory_recovery_approvals(organization_id,target_actor_id,target_device_id,epoch,evidence_digest,recorded_at);
DROP TRIGGER IF EXISTS inventory_recovery_immutable ON inventory_recovery_approvals;
CREATE TRIGGER inventory_recovery_immutable BEFORE UPDATE OR DELETE ON inventory_recovery_approvals FOR EACH ROW EXECUTE FUNCTION forbid_inventory_operation_rewrite();
COMMIT;
