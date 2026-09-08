-- I-27 A9: 발행 기록과 실물 인쇄 결과를 분리하고 계정·작업자 귀속을 보존한다.
-- 기존 행은 결과 미확인 NULL로 두며 PENDING으로 추측하거나 백필하지 않는다.
ALTER TABLE app.document_issue_log
  ADD COLUMN print_outcome_code varchar(40),
  ADD COLUMN print_failure_reason varchar(500),
  ADD COLUMN print_reported_at timestamptz(6),
  ADD COLUMN issued_worker_id bigint REFERENCES mdm.worker(worker_id)
    ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD COLUMN print_reported_worker_id bigint REFERENCES mdm.worker(worker_id)
    ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD COLUMN print_reported_by bigint REFERENCES app.app_user(app_user_id)
    ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE app.document_issue_log
  ADD CONSTRAINT ck_document_issue_print_outcome
  CHECK (print_outcome_code IS NULL OR
         print_outcome_code IN ('PENDING','SUCCEEDED','FAILED')),
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
      AND print_reported_by IS NOT NULL
    ) OR (
    print_outcome_code = 'FAILED' AND print_reported_at IS NOT NULL
      AND nullif(btrim(print_failure_reason),'') IS NOT NULL
      AND print_reported_worker_id IS NOT NULL AND print_reported_by IS NOT NULL
  )) IS TRUE);

COMMENT ON COLUMN app.document_issue_log.print_outcome_code IS
  '인쇄 결과. 신규 발행만 명시 PENDING; NULL은 과거 결과 미확인이고 PENDING으로 간주하지 않는다.';
COMMENT ON COLUMN app.document_issue_log.print_reported_at IS
  '인쇄 결과를 서버가 접수한 시각. 실물 인쇄 발생시각을 도출하지 않는다.';
COMMENT ON COLUMN app.document_issue_log.print_failure_reason IS
  'FAILED 결과의 필수 실패 사유. 성공 결과에는 NULL.';
COMMENT ON COLUMN app.document_issue_log.issued_worker_id IS
  'X-Worker-No로 확인한 최초 발행 귀속 작업자. issued_by 계정FK와 별개.';
COMMENT ON COLUMN app.document_issue_log.print_reported_worker_id IS
  '결과 보고 X-Worker-No 귀속 작업자. 최초 발행 사번을 덮지 않는다.';
COMMENT ON COLUMN app.document_issue_log.print_reported_by IS
  '인쇄 결과를 보고한 인증 계정. issued_by 최초 발행 계정과 별개.';
