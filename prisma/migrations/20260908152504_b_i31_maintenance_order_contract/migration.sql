-- I-31 M1: 보전 지시 계약이 요구하는 날짜·담당 계정·발행/취소 감사축을 추가한다.
-- 모든 신규 칸은 nullable이며 기존 값을 추측해 백필하지 않는다.
ALTER TABLE maintenance.maintenance_order
  ADD COLUMN planned_date date,
  ADD COLUMN base_date date,
  ADD COLUMN order_note text,
  ADD COLUMN assignee_user_id bigint REFERENCES app.app_user(app_user_id),
  ADD COLUMN issued_by bigint REFERENCES app.app_user(app_user_id),
  ADD COLUMN issued_at timestamptz,
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN cancelled_by bigint REFERENCES app.app_user(app_user_id),
  ALTER COLUMN priority_code DROP NOT NULL;

-- 계약의 triggers 배열을 보존한다. 기존 한 행과 FK는 유지하고 parent 유일 제약만 완화한다.
ALTER TABLE maintenance.maintenance_order_trigger
  DROP CONSTRAINT uq_maintenance_order_trigger,
  ALTER COLUMN shot_count_at_due TYPE bigint,
  ALTER COLUMN guaranteed_shot_count_at_due TYPE bigint;

CREATE INDEX ix_maintenance_order_planned
  ON maintenance.maintenance_order(planned_date, maintenance_order_id);
CREATE INDEX ix_maintenance_order_equipment
  ON maintenance.maintenance_order(equipment_id, status_code);
CREATE INDEX ix_maintenance_order_trigger_order
  ON maintenance.maintenance_order_trigger(maintenance_order_id);
CREATE INDEX ix_maintenance_order_trigger_source
  ON maintenance.maintenance_order_trigger(trigger_type_code, source_id, maintenance_order_id);

COMMENT ON TABLE maintenance.maintenance_order_trigger IS
  '한 보전 지시의 촉발 0..N. 계약 triggers 배열. source는 유형별 다형 참조.';
COMMENT ON COLUMN maintenance.maintenance_order.assignee_user_id IS
  '계약 assigneeUserId. assigned_worker_id를 계정으로 변환하거나 백필하지 않는다.';
COMMENT ON COLUMN maintenance.maintenance_order.planned_date IS
  '계약 plannedDate 원문 날짜. scheduled_start_at이나 서버 오늘에서 도출하지 않는다.';
COMMENT ON COLUMN maintenance.maintenance_order.base_date IS
  '예방보전 기준일 입력 원문. 계획일이나 서버 오늘에서 도출하지 않는다.';
COMMENT ON COLUMN maintenance.maintenance_order.issued_by IS
  '보전 지시를 발행한 관리웹 계정. 담당 계정 및 기존 worker FK와 구분한다.';
COMMENT ON COLUMN maintenance.maintenance_order.cancelled_by IS
  '보전 지시를 취소한 관리웹 계정. 취소 사유 입력을 새로 만들지 않는다.';
