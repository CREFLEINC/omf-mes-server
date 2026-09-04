-- 툴 예방보전 판정의 재료. 계약(6d03a44)의 Mold 가 세운 다섯 칸이 물리에 없었다 —
-- 그 칸들만 x-source-column 이 비어 있고, 나머지는 mdm.mold 를 그대로 가리킨다.
ALTER TABLE mdm.mold
  ADD COLUMN tool_type_code       varchar(50) NOT NULL DEFAULT 'MOLD',
  ADD COLUMN pm_trigger_type_code varchar(50) NOT NULL DEFAULT 'NONE',
  ADD COLUMN pm_cycle_interval    integer,
  ADD COLUMN pm_cycle_unit_code   varchar(50),
  ADD COLUMN last_pm_date         date;

-- 기존 행을 채우려고 둔 기본값이다. 등록은 계약에서 required 라 서버가 늘 보낸다 —
-- 기본값을 남겨 두면 유형을 빠뜨린 쓰기가 조용히 금형이 된다.
ALTER TABLE mdm.mold ALTER COLUMN tool_type_code DROP DEFAULT;

-- 날짜 축은 간격과 단위가 함께 있어야 다음 예정일이 선다. 하나만 있으면 예방보전이
-- 도래하지 않는 채로 조용히 지나간다.
ALTER TABLE mdm.mold
  ADD CONSTRAINT ck_mold_pm_cycle_pair
  CHECK ((pm_cycle_interval IS NULL) = (pm_cycle_unit_code IS NULL));

-- 보전 대상은 설비 또는 툴이다(equipment 계약 MaintenanceOrderCreate.targetTypeCode
-- = EQUIPMENT|MOLD). 물리는 equipment_id NOT NULL 하나뿐이라 툴을 담을 자리가 없었다.
ALTER TABLE maintenance.maintenance_order
  ALTER COLUMN equipment_id DROP NOT NULL,
  ADD COLUMN target_type_code varchar(50) NOT NULL DEFAULT 'EQUIPMENT',
  ADD COLUMN mold_id bigint;

ALTER TABLE maintenance.maintenance_order ALTER COLUMN target_type_code DROP DEFAULT;

ALTER TABLE maintenance.maintenance_order
  ADD CONSTRAINT maintenance_order_mold_id_fkey
  FOREIGN KEY (mold_id) REFERENCES mdm.mold(mold_id);

-- 판별자와 실제 채워진 칸이 어긋나면 다형 참조가 거짓말을 한다 — 유형은 툴인데
-- 설비를 가리키는 행이 생기면 어느 쪽으로 세도 틀린다.
ALTER TABLE maintenance.maintenance_order
  ADD CONSTRAINT ck_maintenance_order_target
  CHECK ((target_type_code = 'EQUIPMENT' AND equipment_id IS NOT NULL AND mold_id IS NULL)
      OR (target_type_code = 'MOLD'      AND mold_id      IS NOT NULL AND equipment_id IS NULL));

-- 툴 목록의 withOpenMaintenanceOrder 가 이 축으로 센다.
CREATE INDEX ix_maintenance_order_mold
  ON maintenance.maintenance_order (mold_id, status_code);
