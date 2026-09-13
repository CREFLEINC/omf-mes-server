-- Preserve existing account uploads while allowing an active field worker to own
-- a terminal upload without borrowing an administrator account.
ALTER TABLE app.attachment
  ALTER COLUMN uploaded_by DROP NOT NULL,
  ADD COLUMN uploaded_worker_id BIGINT;

ALTER TABLE app.attachment
  ADD CONSTRAINT attachment_actor_required
    CHECK (uploaded_by IS NOT NULL OR uploaded_worker_id IS NOT NULL),
  ADD CONSTRAINT attachment_uploaded_worker_id_fkey
    FOREIGN KEY (uploaded_worker_id) REFERENCES mdm.worker(worker_id)
    ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE INDEX ix_attachment_uploaded_worker
  ON app.attachment(uploaded_worker_id);
