-- 사전 SELECT: 적용 직전 같은 명령을 다시 실행하고 PR 본문에 결과를 남긴다.
-- SELECT count(*) FROM maintenance.breakdown;                 -- 실측 0
-- SELECT count(*) FROM maintenance.equipment_inspection;      -- 실측 0
-- SELECT count(*) FROM maintenance.equipment_inspection
--  WHERE inspected_at IS NULL OR inspected_by IS NULL
--     OR judgment_code IS NULL;                              -- 실측 0
-- SELECT column_name FROM information_schema.columns
--  WHERE table_schema='maintenance' AND table_name='breakdown'
--    AND column_name IN ('occurrence_state_code','stopped_at','notify_assignee',
--      'reporter_worker_no','cause_code','handling_note','handled_by','handled_at');
--                                                            -- 실측 0칸
-- SELECT to_regclass('mdm.cause_code'),to_regclass('quality.cause_code');
--                                                            -- NULL / quality.cause_code
-- SELECT conname,pg_get_constraintdef(oid) FROM pg_constraint
--  WHERE conrelid='maintenance.breakdown'::regclass;
-- reported_by -> app.app_user, version>0, completed_at>=started_at CHECK 실재.
-- SELECT a.attname,col_description(a.attrelid,a.attnum)
--  FROM pg_attribute a WHERE a.attrelid='maintenance.breakdown'::regclass
--    AND a.attnum>0 AND NOT a.attisdropped;                    -- 17칸 주석 전부 NULL

ALTER TABLE maintenance.breakdown
    ADD COLUMN occurrence_state_code app.code_t,
    ADD COLUMN stopped_at timestamptz,
    ADD COLUMN notify_assignee boolean,
    ADD COLUMN reporter_worker_no varchar(50),
    ADD COLUMN cause_code text,
    ADD COLUMN handling_note text,
    ADD COLUMN handled_by bigint REFERENCES app.app_user(app_user_id),
    ADD COLUMN handled_at timestamptz,
    ALTER COLUMN severity_code DROP NOT NULL;

ALTER TABLE maintenance.equipment_inspection
    ALTER COLUMN status_code DROP NOT NULL;

COMMENT ON COLUMN maintenance.breakdown.occurrence_state_code IS
    '현장 보고 시 선택한 발생 상태. BREAKDOWN_OCCURRENCE_STATE. 처리 상태와 다른 축이다.';
COMMENT ON COLUMN maintenance.breakdown.stopped_at IS
    '현장이 알고 있을 때 입력한 정지 시각. 단말 값 그대로이며 started_at으로 대신하지 않는다.';
COMMENT ON COLUMN maintenance.breakdown.notify_assignee IS
    '설비담당 알림 의사. 신규 요청 미지정은 true. 과거 NULL은 미상이며 발송 성공을 뜻하지 않는다.';
COMMENT ON COLUMN maintenance.breakdown.reporter_worker_no IS
    '보고 시 귀속 사번. X-Worker-No 원문 스냅샷. reported_by의 app_user FK와 다른 축이다.';
COMMENT ON COLUMN maintenance.breakdown.cause_code IS
    '계약 BreakdownHandling.causeCode 저장 자리. 지정 원천 mdm.cause_code 미착지. quality.cause_code 대체 금지; 원천 확정 전 비null 신규 쓰기 유보.';
COMMENT ON COLUMN maintenance.breakdown.handling_note IS
    '사무 처리 내역. 현장 description과 기존 root_cause를 덮어쓰지 않는다.';
COMMENT ON COLUMN maintenance.breakdown.handled_by IS
    '처리 저장·처리 시작·완료를 수행한 관리웹 계정. 보고 귀속 사번과 구분한다.';
COMMENT ON COLUMN maintenance.breakdown.handled_at IS
    '마지막 처리 행위 서버 시각. 보고 시각과 빼서 소요 시간을 계산하지 않는다.';
COMMENT ON COLUMN maintenance.breakdown.severity_code IS
    '기존 물리 심각도. 고정 계약에 입력·출력·기본값이 없어 신규 API는 채우지 않는다.';
COMMENT ON COLUMN maintenance.equipment_inspection.status_code IS
    '기존 물리 점검 상태. 계약 종합 판정은 judgment_code이며 별도 상태값을 도출하지 않는다.';
