-- I-31 M2: 계약 결과 헤더를 추가하되 기존 결과의 값을 추측해 백필하지 않는다.
ALTER TABLE maintenance.maintenance_result
  ALTER COLUMN maintenance_order_id DROP NOT NULL,
  ALTER COLUMN result_seq DROP NOT NULL,
  ALTER COLUMN action_code DROP NOT NULL,
  ALTER COLUMN action_description DROP NOT NULL,
  ALTER COLUMN completed_at DROP NOT NULL,
  ALTER COLUMN result_code DROP NOT NULL,
  ADD COLUMN target_type_code varchar(50),
  ADD COLUMN equipment_id bigint REFERENCES mdm.equipment(equipment_id),
  ADD COLUMN mold_id bigint REFERENCES mdm.mold(mold_id),
  ADD COLUMN breakdown_id bigint REFERENCES maintenance.breakdown(breakdown_id),
  ADD COLUMN result_note text,
  ADD COLUMN performed_by_user_id bigint REFERENCES app.app_user(app_user_id),
  ADD COLUMN is_outsourced boolean,
  ADD COLUMN outsource_vendor_name text,
  ADD COLUMN reset_counter boolean,
  ADD COLUMN shot_count_before_reset bigint,
  ADD COLUMN shot_count_after_reset bigint,
  ADD COLUMN closed boolean,
  ADD COLUMN version_no integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
  ADD COLUMN updated_at timestamptz,
  ADD COLUMN updated_by bigint,
  ADD CONSTRAINT ck_maintenance_result_target CHECK (
    (target_type_code IS NULL AND equipment_id IS NULL AND mold_id IS NULL)
    OR (target_type_code IS NOT NULL AND target_type_code = 'EQUIPMENT' AND equipment_id IS NOT NULL AND mold_id IS NULL)
    OR (target_type_code IS NOT NULL AND target_type_code = 'MOLD' AND mold_id IS NOT NULL AND equipment_id IS NULL)
  ),
  ADD CONSTRAINT ck_maintenance_result_reset_counts CHECK (
    (shot_count_before_reset IS NULL OR shot_count_before_reset >= 0)
    AND (shot_count_after_reset IS NULL OR shot_count_after_reset >= 0)
  );

CREATE INDEX ix_maintenance_result_equipment_started
  ON maintenance.maintenance_result(equipment_id, started_at, maintenance_result_id);
CREATE INDEX ix_maintenance_result_mold_started
  ON maintenance.maintenance_result(mold_id, started_at, maintenance_result_id);
CREATE INDEX ix_maintenance_result_breakdown
  ON maintenance.maintenance_result(breakdown_id);

CREATE TABLE maintenance.maintenance_result_line (
  maintenance_result_line_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  maintenance_result_id bigint NOT NULL REFERENCES maintenance.maintenance_result(maintenance_result_id),
  sequence_no integer NOT NULL CHECK (sequence_no > 0),
  maintenance_order_item_id bigint REFERENCES maintenance.maintenance_order_item(maintenance_order_item_id),
  part_name text,
  result_code app.code_t NOT NULL,
  remarks text,
  CONSTRAINT uq_maintenance_result_line_seq UNIQUE (maintenance_result_id, sequence_no),
  CONSTRAINT uq_maintenance_result_line_item UNIQUE (maintenance_result_id, maintenance_order_item_id)
);

CREATE INDEX ix_maintenance_result_line_item
  ON maintenance.maintenance_result_line(maintenance_order_item_id);

CREATE TABLE maintenance.maintenance_result_part (
  maintenance_result_part_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  maintenance_result_id bigint NOT NULL REFERENCES maintenance.maintenance_result(maintenance_result_id),
  sequence_no integer NOT NULL CHECK (sequence_no > 0),
  spare_part_id bigint NOT NULL REFERENCES mdm.spare_part(spare_part_id),
  part_name text,
  used_qty numeric(20,6) NOT NULL CHECK (used_qty > 0),
  goods_issue_id bigint REFERENCES logistics.goods_issue(goods_issue_id),
  CONSTRAINT uq_maintenance_result_part_seq UNIQUE (maintenance_result_id, sequence_no)
);

CREATE INDEX ix_maintenance_result_part_spare
  ON maintenance.maintenance_result_part(spare_part_id);
CREATE INDEX ix_maintenance_result_part_issue
  ON maintenance.maintenance_result_part(goods_issue_id);

COMMENT ON COLUMN maintenance.maintenance_result.performed_by_user_id IS
  '계약 수행자 app_user. 구 performed_by worker FK와 다른 축이며 외주면 null이다.';
COMMENT ON COLUMN maintenance.maintenance_result.completed_at IS
  '계약 finishedAt: 실제 수행 종료. null은 진행 중이며 지시 마감이나 PM 완료를 뜻하지 않는다.';
COMMENT ON COLUMN maintenance.maintenance_result.closed IS
  '계약 closed 저장 자리. 결과코드의 완료 의미가 확정되기 전 true는 서비스에서 거부한다.';
COMMENT ON TABLE maintenance.maintenance_result_line IS
  '보전 실적의 대상별 결과 라인. 고객 확장 결과 코드를 저장하되 완료 의미를 도출하지 않는다.';
COMMENT ON TABLE maintenance.maintenance_result_part IS
  '보전 실적의 예비품 사용 사실과 기존 출고 참조. 출고·수불·재고 변경을 만들지 않는다.';
