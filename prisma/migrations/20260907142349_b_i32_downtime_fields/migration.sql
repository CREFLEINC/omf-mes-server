/* 사전 대조 SELECT — 적용 전 결과를 PR 본문에 기록한다.
SELECT clock_timestamp() AS observed_at, current_database(), current_user,
       current_setting('TimeZone') AS db_timezone;
SELECT column_name,is_nullable,column_default,data_type,character_maximum_length
FROM information_schema.columns
WHERE table_schema='maintenance' AND table_name='equipment_downtime'
ORDER BY ordinal_position;
SELECT count(*) AS rows,
       count(*) FILTER (WHERE reason_code IS NULL OR btrim(reason_code)='') AS missing_reason,
       count(*) FILTER (WHERE ended_at IS NULL) AS open_rows,
       count(*) FILTER (WHERE ended_at < started_at) AS invalid_window
FROM maintenance.equipment_downtime;
SELECT equipment_id,count(*) AS open_count
FROM maintenance.equipment_downtime WHERE ended_at IS NULL
GROUP BY equipment_id HAVING count(*)>1;
SELECT equipment_downtime_id,
       ((extract(epoch FROM started_at)*1000000)::bigint)::text AS started_epoch_us,
       ((extract(epoch FROM ended_at)*1000000)::bigint)::text AS ended_epoch_us
FROM maintenance.equipment_downtime
ORDER BY equipment_downtime_id LIMIT 20;
SELECT conname,pg_get_constraintdef(oid)
FROM pg_constraint WHERE conrelid='maintenance.equipment_downtime'::regclass;
SELECT indexname,indexdef FROM pg_indexes
WHERE schemaname='maintenance' AND tablename='equipment_downtime';
SELECT tgname,pg_get_triggerdef(oid) FROM pg_trigger
WHERE tgrelid='maintenance.equipment_downtime'::regclass AND NOT tgisinternal;
SELECT g.group_code,v.code,v.code_name,v.is_active
FROM mdm.code_group g LEFT JOIN mdm.code_value v USING(code_group_id)
WHERE g.group_code IN ('DOWNTIME_REASON','DOWNTIME_TYPE')
ORDER BY g.group_code,v.code;
SELECT policy_code,value_numeric,plant_id,business_unit_id,item_id,process_id,
       effective_from,effective_to
FROM app.operation_policy WHERE policy_code='MINOR_STOP_THRESHOLD_MINUTES';
SELECT count(*) AS sessions,
       count(*) FILTER (WHERE ended_at IS NULL) AS open_sessions,
       count(*) FILTER (WHERE equipment_id IS NULL) AS without_equipment
FROM production.work_session;
SELECT count(*) AS equipment_assignments
FROM production.work_order_resource_assignment WHERE equipment_id IS NOT NULL;
*/

-- I-32. 실제 파일명은 생성시각 YYYYMMDDHHMMSS로 정한다.
-- 마이그 전에 §3-2 사전SELECT 결과를 PR본문에 기록한다.
-- required 응답의 과거값을 발명하지 않는다. nullable은 과거행 보존용이며
-- 배포 전 recorded_by_worker_no/reason_code 결손조회0이 별도 필수다.
-- downtime_type_code는 계약이 받지 않는 축이다. DOWNTIME_REASON을 복사하지 않는다.
ALTER TABLE maintenance.equipment_downtime
  ADD COLUMN remarks text,
  ADD COLUMN recorded_by_worker_no varchar(50),
  ADD COLUMN version_no integer NOT NULL DEFAULT 1,
  ALTER COLUMN downtime_type_code DROP NOT NULL;

ALTER TABLE maintenance.equipment_downtime
  ADD CONSTRAINT equipment_downtime_version_no_check CHECK (version_no > 0);

COMMENT ON COLUMN maintenance.equipment_downtime.recorded_by_worker_no IS
  '비가동을 최초 기록한 귀속용 X-Worker-No 원문. 계정 created_by와 별개이며 과거행은 임의 백필하지 않는다.';
COMMENT ON COLUMN maintenance.equipment_downtime.remarks IS
  '현장 비가동 메모. DowntimeCreate/Update.remarks.';
COMMENT ON COLUMN maintenance.equipment_downtime.downtime_type_code IS
  '계약에 입력과 값 정의가 없는 기존 축. 신규 비가동은 null; reason_code를 복제하지 않는다.';
COMMENT ON COLUMN maintenance.equipment_downtime.version_no IS
  '상세 GET ETag와 수정/종료 If-Match 토큰. 본문에 노출하지 않는다.';
