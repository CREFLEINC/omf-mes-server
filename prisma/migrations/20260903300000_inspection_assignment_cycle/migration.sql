-- 점검항목 «부여»에 주기를 세우고, 그룹 부여의 가리키는 곳을 바로잡는다.
--
-- ── 1. 주기 세 칸
-- 계약 `InspectionItemAssignmentInput` 이 cycleTypeCode·cycleInterval 을 «필수»로,
-- cycleBaseDate 를 선택으로 받는다. 물리에는 셋 다 없다(실측 2026-09-03).
-- 주기가 없으면 「이 항목을 언제 점검해야 하는가」를 아무도 모른다 — 부여의 뜻이 반쪽이다.
--
-- 값 목록은 시드의 CYCLE_TYPE(DAY·WEEK·MONTH·YEAR)이다. 계약이 「검교정 주기와 점검
-- 부여 주기가 «같은 그룹»이다 — 같은 종류의 값(기간 단위)이라 어휘를 두 벌 만들지
-- 않는다」(omf-mes#188)로 못박았다.
--
-- is_active 도 함께 세운다 — 계약 입력이 받는다(기본 참).
--
-- ⛔ NOT NULL 을 기본값 없이 붙인다. 두 표 모두 어느 환경에서도 비어 있고(실측 0행),
-- 기본값을 지어 넣으면 근거 없는 주기가 조용히 들어간다.
--
-- ── 2. 그룹 부여의 FK 를 production_line 으로 옮긴다
-- 계약 `EquipmentGroup` 이 설비 그룹의 저장처를 mdm.production_line 으로 지목한다
-- (PR #122). 그런데 이 표는 mdm.equipment_group 을 가리키고 있어, API 가 주는
-- equipmentGroupId(=production_line_id)를 그대로 넣을 수 없다.
--
-- 두 표 모두 0행이라 데이터 이전이 없다. 컬럼 이름도 저장처에 맞춰 옮긴다 —
-- equipment_group_id 로 두면 「무엇을 가리키는가」가 이름과 어긋난 채 남는다.

ALTER TABLE mdm.equipment_group_inspection_item
    DROP CONSTRAINT equipment_group_inspection_item_equipment_group_id_fkey;

ALTER TABLE mdm.equipment_group_inspection_item
    RENAME COLUMN equipment_group_id TO production_line_id;

ALTER TABLE mdm.equipment_group_inspection_item
    ADD CONSTRAINT equipment_group_inspection_item_production_line_id_fkey
        FOREIGN KEY (production_line_id) REFERENCES mdm.production_line (production_line_id);

ALTER TABLE mdm.equipment_group_inspection_item
    ADD COLUMN cycle_type_code app.code_t NOT NULL,
    ADD COLUMN cycle_interval  integer    NOT NULL CHECK (cycle_interval >= 1),
    ADD COLUMN cycle_base_date date,
    ADD COLUMN is_active       boolean    NOT NULL DEFAULT true;

ALTER TABLE mdm.equipment_inspection_item_assignment
    ADD COLUMN cycle_type_code app.code_t NOT NULL,
    ADD COLUMN cycle_interval  integer    NOT NULL CHECK (cycle_interval >= 1),
    ADD COLUMN cycle_base_date date,
    ADD COLUMN is_active       boolean    NOT NULL DEFAULT true;

COMMENT ON COLUMN mdm.equipment_group_inspection_item.production_line_id IS
  '설비 그룹. 그룹의 저장처가 mdm.production_line 이다 (계약 EquipmentGroup 의 x-source-column).';
COMMENT ON COLUMN mdm.equipment_group_inspection_item.cycle_base_date IS
  '주기 기준일. 비면 부여일이 기준이 된다.';
COMMENT ON COLUMN mdm.equipment_inspection_item_assignment.cycle_base_date IS
  '주기 기준일. 비면 부여일이 기준이 된다.';
