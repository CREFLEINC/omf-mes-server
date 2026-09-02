-- 설비에 검교정 주기와 정밀도를 세운다.
--
-- 계약 `Equipment` 의 열일곱 칸 중 넷이 물리에 없다(실측 2026-09-03).
--
--   calibration_cycle_type_code  검교정 주기 단위
--   calibration_cycle_interval   검교정 주기 간격
--   precision_value              정밀도 수치
--   precision_uom_id             정밀도 단위
--
-- 계약이 이유를 적었다 — 「calibrationRequired 가 참이면 주기 두 칸이 함께 필요하다.
-- **주기 없이는 차기 예정일을 산출할 수 없다**」. 지금은 last_calibration_date 와
-- calibration_due_date 만 있어, 다음 예정일을 사람이 손으로 넣어야 한다.
--
-- 주기 단위는 시드의 CYCLE_TYPE(DAY·WEEK·MONTH·YEAR)을 쓴다 — 계약이 「검교정 주기와
-- 점검 부여 주기가 같은 그룹이다」로 못박았다(omf-mes#188).
--
-- 넷 다 nullable 이다. calibrationRequired 가 거짓인 설비가 정상이고, 그때는 주기가
-- 없는 것이 맞다. 「참이면 필요」는 서버가 본다 — DB CHECK 로 두면 기존 행 중
-- calibration_required 가 참인데 주기가 없는 것을 막아 마이그레이션이 실패한다.

ALTER TABLE mdm.equipment
    ADD COLUMN calibration_cycle_type_code app.code_t,
    ADD COLUMN calibration_cycle_interval  integer,
    ADD COLUMN precision_value             numeric(20, 6),
    ADD COLUMN precision_uom_id            bigint,
    ADD CONSTRAINT ck_equipment_calibration_cycle
        CHECK (calibration_cycle_interval IS NULL OR calibration_cycle_interval >= 1),
    ADD CONSTRAINT equipment_precision_uom_id_fkey
        FOREIGN KEY (precision_uom_id) REFERENCES mdm.uom (uom_id);

COMMENT ON COLUMN mdm.equipment.calibration_cycle_type_code IS
  '검교정 주기 단위(CYCLE_TYPE). 점검 부여 주기와 같은 어휘를 쓴다 (omf-mes#188).';
COMMENT ON COLUMN mdm.equipment.calibration_cycle_interval IS
  '검교정 주기 간격. 단위와 함께 차기 검교정 예정일을 산출한다.';
