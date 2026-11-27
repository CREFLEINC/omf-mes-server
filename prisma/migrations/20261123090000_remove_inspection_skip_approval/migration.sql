-- 건별 검사 생략(요청 → 결재 → 실행 · IQC·PQC·OQC)의 데이터를 이력까지 지운다(omf-all-around#353 · 사용자 결정 2026-11-23).
-- ⛔ 생략 코드를 뗀 릴리스(#353 앞 두 PR)가 배포된 «다음» 릴리스에만 싣는다 — 블루-그린 전환 중 옛 판이 이 스키마를 본다.
-- ⭐ 기본 생략(검사 기준 default_skip · skip_basis_code=DEFAULT · C21·C26·C27)은 건드리지 않는다.
-- 생략 결재 = approval_type_code IN ('IQC_SKIP','PQC_SKIP','OQC_SKIP'). 결재 행을 마지막에 지우므로 앞 문장들이 같은 집합을 본다.

-- 멈춤 조건 — 생략 결재 밖에 계정 없는(작업자만 있는) 상신이 있으면 requested_worker_id 를 지울 수 없다.
DO $$
DECLARE stuck int;
BEGIN
  SELECT count(*) INTO stuck FROM app.approval_request
   WHERE requested_by IS NULL AND approval_type_code NOT IN ('IQC_SKIP', 'PQC_SKIP', 'OQC_SKIP');
  IF stuck > 0 THEN
    RAISE EXCEPTION '계정 없는 결재 요청이 %건 있습니다(생략 결재 밖) — 상신자를 정리한 뒤 배포하세요', stuck;
  END IF;
END $$;

-- 결재에 매달린 행 — 알림(Zalo·수신함·이벤트) · 감사 · 결재 단계. 다형 참조라 FK 가 없어 직접 지운다.
DELETE FROM app.zalo_delivery WHERE notification_event_id IN (
  SELECT notification_event_id FROM app.notification_event
   WHERE aggregate_type_code = 'APPROVAL_REQUEST' AND aggregate_id IN (
     SELECT approval_request_id FROM app.approval_request WHERE approval_type_code IN ('IQC_SKIP', 'PQC_SKIP', 'OQC_SKIP')));
DELETE FROM app.notification WHERE notification_event_id IN (
  SELECT notification_event_id FROM app.notification_event
   WHERE aggregate_type_code = 'APPROVAL_REQUEST' AND aggregate_id IN (
     SELECT approval_request_id FROM app.approval_request WHERE approval_type_code IN ('IQC_SKIP', 'PQC_SKIP', 'OQC_SKIP')));
DELETE FROM app.notification_event
 WHERE aggregate_type_code = 'APPROVAL_REQUEST' AND aggregate_id IN (
   SELECT approval_request_id FROM app.approval_request WHERE approval_type_code IN ('IQC_SKIP', 'PQC_SKIP', 'OQC_SKIP'));
DELETE FROM audit.audit_event
 WHERE target_type_code = 'APPROVAL_REQUEST' AND target_id IN (
   SELECT approval_request_id FROM app.approval_request WHERE approval_type_code IN ('IQC_SKIP', 'PQC_SKIP', 'OQC_SKIP'));

-- LOT 이력 — IQC 생략 실행(C22)·PQC 생략 실행(C28)·생략 무효(C30), 그리고 생략 결재를 근거로 남긴 행(OQC 생략 실행의 C27).
-- 출하 완료가 남긴 C27(근거 INSPECTION_REQUEST · 기본 생략)은 남는다.
DELETE FROM trace.lot_status_event
 WHERE transition_code IN ('C22', 'C28', 'C30')
    OR (source_document_type_code = 'APPROVAL_REQUEST' AND source_document_id IN (
          SELECT approval_request_id FROM app.approval_request WHERE approval_type_code IN ('IQC_SKIP', 'PQC_SKIP', 'OQC_SKIP')));
-- IQC 생략 실행이 푼 수입검사 대기 보류 — 해제 사유 코드를 지우므로 그 행도 지운다(지운 코드를 가리키는 이력이 남지 않게).
DELETE FROM trace.lot_hold WHERE release_reason_code = 'INCOMING_INSPECTION_SKIPPED';
-- 검사 의뢰 이력 — 생략 실행(SKIPPED)·생략 무효(SKIP_VOIDED). 둘 다 건별 생략 경로만 썼다(기본 생략은 이력을 안 남긴다).
DELETE FROM quality.inspection_request_event WHERE event_type_code IN ('SKIPPED', 'SKIP_VOIDED');

DELETE FROM app.approval_step WHERE approval_request_id IN (
  SELECT approval_request_id FROM app.approval_request WHERE approval_type_code IN ('IQC_SKIP', 'PQC_SKIP', 'OQC_SKIP'));
DELETE FROM app.approval_request WHERE approval_type_code IN ('IQC_SKIP', 'PQC_SKIP', 'OQC_SKIP');
DELETE FROM app.approval_route_step WHERE approval_route_id IN (
  SELECT approval_route_id FROM app.approval_route WHERE approval_type_code IN ('IQC_SKIP', 'PQC_SKIP', 'OQC_SKIP'));
DELETE FROM app.approval_route WHERE approval_type_code IN ('IQC_SKIP', 'PQC_SKIP', 'OQC_SKIP');

-- 결재로 생략된 의뢰는 SKIPPED 그대로 두고 근거만 비운다 — 근거 값은 기본 생략(DEFAULT) 하나만 남는다.
UPDATE quality.inspection_request SET skip_basis_code = NULL WHERE skip_basis_code = 'APPROVAL';
ALTER TABLE quality.inspection_request
  DROP CONSTRAINT ck_inspection_request_skip_basis,
  ADD CONSTRAINT ck_inspection_request_skip_basis CHECK (skip_basis_code IS NULL OR skip_basis_code = 'DEFAULT');

-- 없앤 화면 권한(M-01-13 긴급 IQC 생략 요청 · W-01-02 한도승인) — 앱이 이미 숨기는 부여를 지운다.
DELETE FROM app.role_permission WHERE permission_code IN ('M-01-13', 'W-01-02');

-- 코드 값 — 시드(seed.ts)에서도 뺐다.
DELETE FROM mdm.code_value cv USING mdm.code_group cg
 WHERE cv.code_group_id = cg.code_group_id
   AND ((cg.group_code = 'LOT_STATUS_TRANSITION' AND cv.code IN ('C22', 'C28', 'C30'))
     OR (cg.group_code = 'INSPECTION_REQUEST_EVENT_TYPE' AND cv.code IN ('SKIPPED', 'SKIP_VOIDED'))
     OR (cg.group_code = 'LOT_HOLD_RELEASE_REASON' AND cv.code = 'INCOMING_INSPECTION_SKIPPED'));

-- 현장 작업자 상신 칸 — PDA 긴급 IQC 생략 요청만 썼다. 상신자는 계정 하나다.
ALTER TABLE app.approval_request DROP CONSTRAINT ck_approval_request_actor;
DROP INDEX app.ix_approval_request_requested_worker;
ALTER TABLE app.approval_request DROP COLUMN requested_worker_id;
ALTER TABLE app.approval_request ADD CONSTRAINT ck_approval_request_actor CHECK (requested_by IS NOT NULL);
