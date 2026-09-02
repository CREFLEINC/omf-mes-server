-- 예비품을 공장 단위로 세우고, 계약이 안 받는 칸의 NOT NULL 을 푼다.
--
-- ── 1. plant_id
-- 계약 `SparePart` 가 plantId 를 «필수»로 두고 `sparePartCode` 에 「공장 안에서
-- 유일하다」를 적었는데, 물리에 plant_id 가 없고 코드가 전역 유일이다(실측 2026-09-03).
-- 목록도 plantId 로 거른다.
--
-- 유일 범위를 (plant_id, spare_part_code) 로 «넓힌다» — 공장이 축으로 들어왔으므로
-- 다른 공장이 같은 코드를 쓰지 못할 이유가 없다. mdm.warehouse·mdm.equipment 와 같은
-- 형태다. 넓히는 방향이라 기존 데이터를 깨지 않는다.
--
-- ⛔ NOT NULL 을 기본값 없이 붙인다. 행이 있으면 실패한다 — 그것이 맞다(실측 0행).
--
-- ── 2. base_uom_id 의 NOT NULL 을 푼다
-- 계약 `SparePartCreate` 는 plantId·코드·명칭 셋만 받는다. 단위를 받을 자리가 없는데
-- 컬럼이 NOT NULL 이면 서버가 «근거 없는 단위»를 지어 넣어야 한다.
--
-- 완화(NOT NULL → NULL)는 하위 호환이다 — 읽는 쪽이 깨지지 않는다. 단위를 받는 경로가
-- 계약에 서면 그때 다시 조인다.

ALTER TABLE mdm.spare_part
    ADD COLUMN plant_id bigint NOT NULL,
    ADD CONSTRAINT spare_part_plant_id_fkey
        FOREIGN KEY (plant_id) REFERENCES mdm.plant (plant_id);

ALTER TABLE mdm.spare_part
    DROP CONSTRAINT spare_part_spare_part_code_key;

ALTER TABLE mdm.spare_part
    ADD CONSTRAINT uq_spare_part UNIQUE (plant_id, spare_part_code);

ALTER TABLE mdm.spare_part
    ALTER COLUMN base_uom_id DROP NOT NULL;

COMMENT ON COLUMN mdm.spare_part.plant_id IS
  '예비품은 공장 단위다. 코드도 공장 안에서만 유일하다 (계약 SparePart).';
COMMENT ON COLUMN mdm.spare_part.base_uom_id IS
  '계약이 받는 경로가 아직 없다 — 그래서 nullable 이다. 경로가 서면 다시 조인다.';
