-- FR-005: keep terminal writes attributable to the real same-plant worker.
-- Existing account-owned rows remain valid. No guessed worker or plant is backfilled.

ALTER TABLE app.approval_request
  ALTER COLUMN requested_by DROP NOT NULL,
  ADD COLUMN requested_worker_id bigint
    REFERENCES mdm.worker(worker_id) ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE app.approval_request
  ADD CONSTRAINT ck_approval_request_actor
    CHECK (requested_by IS NOT NULL OR requested_worker_id IS NOT NULL);
CREATE INDEX ix_approval_request_requested_worker
  ON app.approval_request(requested_worker_id)
  WHERE requested_worker_id IS NOT NULL;

ALTER TABLE trace.lot_status_event
  ALTER COLUMN changed_by DROP NOT NULL,
  ADD COLUMN changed_worker_id bigint
    REFERENCES mdm.worker(worker_id) ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE trace.lot_status_event
  ADD CONSTRAINT ck_lot_status_event_actor
    CHECK (changed_by IS NOT NULL OR changed_worker_id IS NOT NULL);
CREATE INDEX ix_lot_status_event_changed_worker
  ON trace.lot_status_event(changed_worker_id)
  WHERE changed_worker_id IS NOT NULL;

ALTER TABLE app.document_issue_log
  ALTER COLUMN issued_by DROP NOT NULL;
ALTER TABLE app.document_issue_log
  ADD CONSTRAINT ck_document_issue_log_issuer
    CHECK (issued_by IS NOT NULL OR issued_worker_id IS NOT NULL);
-- A terminal print report retains its worker; a linked app account is optional.
ALTER TABLE app.document_issue_log
  DROP CONSTRAINT ck_document_issue_print_report;
ALTER TABLE app.document_issue_log
  ADD CONSTRAINT ck_document_issue_print_report
  CHECK (((
    print_outcome_code IS NULL AND print_reported_at IS NULL
      AND print_failure_reason IS NULL AND print_reported_worker_id IS NULL
      AND print_reported_by IS NULL
    ) OR (
    print_outcome_code = 'PENDING' AND print_reported_at IS NULL
      AND print_failure_reason IS NULL AND print_reported_worker_id IS NULL
      AND print_reported_by IS NULL
    ) OR (
    print_outcome_code = 'SUCCEEDED' AND print_reported_at IS NOT NULL
      AND print_failure_reason IS NULL AND print_reported_worker_id IS NOT NULL
    ) OR (
    print_outcome_code = 'FAILED' AND print_reported_at IS NOT NULL
      AND nullif(btrim(print_failure_reason),'') IS NOT NULL
      AND print_reported_worker_id IS NOT NULL
  )) IS TRUE);

ALTER TABLE logistics.shipment_request
  ADD COLUMN fulfillment_plant_id bigint
    REFERENCES mdm.plant(plant_id) ON DELETE NO ACTION ON UPDATE NO ACTION;
CREATE INDEX ix_shipment_request_fulfillment_plant_status
  ON logistics.shipment_request(fulfillment_plant_id,status_code);

-- Only a request whose existing shipments all point to one plant is unambiguous.
WITH single_plant AS (
  SELECT s.shipment_request_id, MIN(w.plant_id) AS plant_id
  FROM logistics.shipment AS s
  JOIN mdm.warehouse AS w ON w.warehouse_id = s.warehouse_id
  GROUP BY s.shipment_request_id
  HAVING COUNT(DISTINCT w.plant_id) = 1
)
UPDATE logistics.shipment_request AS sr
SET fulfillment_plant_id = single_plant.plant_id
FROM single_plant
WHERE sr.shipment_request_id = single_plant.shipment_request_id
  AND sr.fulfillment_plant_id IS NULL;
