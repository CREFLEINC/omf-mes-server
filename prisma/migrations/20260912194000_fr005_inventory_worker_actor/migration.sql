-- Existing account actions remain valid; field terminals can attribute the
-- action to a real worker who does not have an app account.
ALTER TABLE inventory.handling_unit_repack_event
  ALTER COLUMN performed_by DROP NOT NULL,
  ADD COLUMN performed_worker_id BIGINT;

ALTER TABLE inventory.handling_unit_repack_event
  ADD CONSTRAINT handling_unit_repack_event_actor_check
    CHECK ((performed_by IS NOT NULL) <> (performed_worker_id IS NOT NULL)),
  ADD CONSTRAINT handling_unit_repack_event_performed_worker_fkey
    FOREIGN KEY (performed_worker_id) REFERENCES mdm.worker(worker_id)
    ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE INDEX ix_handling_unit_repack_event_worker
  ON inventory.handling_unit_repack_event(performed_worker_id);

ALTER TABLE inventory.inventory_count_line
  ADD COLUMN counted_worker_id BIGINT,
  ADD CONSTRAINT inventory_count_line_counted_worker_fkey
    FOREIGN KEY (counted_worker_id) REFERENCES mdm.worker(worker_id)
    ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE INDEX ix_inventory_count_line_counted_worker
  ON inventory.inventory_count_line(counted_worker_id);
