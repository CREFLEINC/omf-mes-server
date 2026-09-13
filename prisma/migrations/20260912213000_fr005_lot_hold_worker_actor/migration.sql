-- Keep LOT holds attributable to the real terminal worker without inventing an app account.
-- Legacy rows with neither actor remain readable; new/updated rows must carry an actor.
ALTER TABLE trace.lot_hold
  ADD COLUMN held_worker_id bigint REFERENCES mdm.worker(worker_id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD COLUMN released_worker_id bigint REFERENCES mdm.worker(worker_id) ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE trace.lot_hold
  ADD CONSTRAINT ck_lot_hold_held_actor
    CHECK (held_by IS NOT NULL OR held_worker_id IS NOT NULL) NOT VALID,
  ADD CONSTRAINT ck_lot_hold_released_actor
    CHECK (released_at IS NULL OR released_by IS NOT NULL OR released_worker_id IS NOT NULL) NOT VALID;

CREATE INDEX ix_lot_hold_held_worker
  ON trace.lot_hold(held_worker_id) WHERE held_worker_id IS NOT NULL;
CREATE INDEX ix_lot_hold_released_worker
  ON trace.lot_hold(released_worker_id) WHERE released_worker_id IS NOT NULL;
