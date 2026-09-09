/* 사전 대조 SELECT — 적용 전 결과를 PR 본문에 기록한다.
SELECT clock_timestamp() AS observed_at,current_database(),current_user,
       current_setting('TimeZone') AS db_timezone;
SELECT count(*) AS rows,
       count(*) FILTER (WHERE ended_at IS NULL) AS open_rows,
       count(*) FILTER (WHERE ended_at IS NOT NULL AND closed_by IS NULL)
         AS closed_without_actor,
       count(*) FILTER (WHERE ended_at < started_at) AS invalid_window
FROM maintenance.equipment_downtime;
SELECT count(*) AS existing_column
FROM information_schema.columns
WHERE table_schema='maintenance' AND table_name='equipment_downtime'
  AND column_name='closed_by_worker_no';
*/

ALTER TABLE maintenance.equipment_downtime
  ADD COLUMN closed_by_worker_no varchar(50);

COMMENT ON COLUMN maintenance.equipment_downtime.closed_by_worker_no IS
  '비가동을 종료한 X-Worker-No 원문. 계정 closed_by와 별개이며 과거 종료행은 임의 백필하지 않는다.';
