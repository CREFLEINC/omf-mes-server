-- 위치에서 관리하지 않는 칸(사용자 결정 2026-10-29) — 수용량·수용단위·보관조건·품질구역·위치 유형·섞어 담기 둘.
-- 값을 지우고 서버가 더 쓰지 않는다. 칼럼은 다음 릴리스에 지운다(블루-그린이라 배포 중 옛 코드가 이 표를 본다).
UPDATE mdm.location
   SET capacity_qty = NULL, capacity_uom_id = NULL, storage_condition_code = NULL, quality_zone_code = NULL
 WHERE capacity_qty IS NOT NULL OR capacity_uom_id IS NOT NULL
    OR storage_condition_code IS NOT NULL OR quality_zone_code IS NOT NULL;

-- 새 위치는 유형을 받지 않는다. 섞어 담기 둘은 기본값(true)이 있어 그대로 둔다.
ALTER TABLE mdm.location ALTER COLUMN location_type_code DROP NOT NULL;
