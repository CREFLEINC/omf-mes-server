-- 설비 점검항목을 계약이 요구하는 모양으로 세운다.
--
-- 계약 `EquipmentInspectionItem` 의 열세 칸 중 다섯이 물리에 없다(실측 2026-09-03).
-- 이 스키마에는 `x-source-column` 이 «하나도» 없다 — 설계가 저장 컬럼을 아직 안 정했다는
-- 뜻이고, 정하는 것이 우리 몫이다.
--
--   plant_id              공장별 항목이다. 목록도 plantId 로 거른다
--   inspection_type_code  일상(DAILY)·정기(MONTHLY)·보전(MAINTENANCE)
--   judgment_method_code  육안(VISUAL)·측정값(MEASUREMENT)
--   inspection_point      점검부위
--   sequence_no           표시 순서
--
-- 코드 값은 이미 시드에 있다 — EQUIPMENT_INSPECTION_TYPE(3값)·
-- EQUIPMENT_INSPECTION_JUDGMENT_METHOD(2값). 계약과 정확히 맞는다.
--
-- ⛔ NOT NULL 을 기본값 없이 붙인다. 행이 있으면 이 마이그레이션은 «실패한다» —
-- 그것이 맞다. 지금 이 표는 어느 환경에서도 비어 있고(실측), 기본값을 지어 넣으면
-- 근거 없는 값이 조용히 들어간다.
--
-- 유일 범위를 (plant_id, inspection_item_code) 로 넓힌다. 공장이 축으로 들어왔으므로
-- 다른 공장이 같은 코드를 쓰지 못할 이유가 없다 — mdm.warehouse 의 uq_warehouse 와
-- 같은 형태다. 넓히는 방향이라 기존 데이터를 깨지 않는다.

ALTER TABLE mdm.equipment_inspection_item
    ADD COLUMN plant_id             bigint      NOT NULL,
    ADD COLUMN inspection_type_code app.code_t  NOT NULL,
    ADD COLUMN judgment_method_code app.code_t  NOT NULL,
    ADD COLUMN inspection_point     app.name_t,
    ADD COLUMN sequence_no          integer     NOT NULL,
    ADD CONSTRAINT equipment_inspection_item_plant_id_fkey
        FOREIGN KEY (plant_id) REFERENCES mdm.plant (plant_id);

ALTER TABLE mdm.equipment_inspection_item
    DROP CONSTRAINT equipment_inspection_item_inspection_item_code_key;

ALTER TABLE mdm.equipment_inspection_item
    ADD CONSTRAINT uq_equipment_inspection_item
        UNIQUE (plant_id, inspection_item_code);

COMMENT ON COLUMN mdm.equipment_inspection_item.judgment_method_code IS
  '육안(VISUAL) 또는 측정값(MEASUREMENT). MEASUREMENT 면 단위·상하한이 필수다.';
COMMENT ON COLUMN mdm.equipment_inspection_item.data_type_code IS
  'judgment_method_code 에서 도출한다 — MEASUREMENT=NUMERIC, VISUAL=BOOLEAN. 계약이 이 칸을 받지 않는다.';
