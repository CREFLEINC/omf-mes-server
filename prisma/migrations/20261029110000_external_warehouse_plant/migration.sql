-- 사외 창고 100667·100668 은 OA 공장(PL13)이다 — 고객 창고 목록(사용자 결정 2026-10-29).
-- 운영 초기 데이터(`deploy/seed/mes-initial-data.sql`)가 사외 창고를 모두 부품 공장(PL11)으로 넣었다.
-- 이미 무엇이든 가리키는 창고는 옮기지 않는다 — 그 행들이 적은 공장과 어긋난다. 위치는 공장이 없어 세지 않는다.
DO $$
DECLARE
  target record;
  ref record;
  used boolean;
BEGIN
  FOR target IN
    SELECT w.warehouse_id, w.warehouse_code, oa.plant_id AS oa_plant_id
      FROM mdm.warehouse w
      JOIN mdm.plant parts ON parts.plant_id = w.plant_id AND parts.plant_code = 'PL11'
      JOIN mdm.plant oa ON oa.legal_entity_id = parts.legal_entity_id AND oa.plant_code = 'PL13'
     WHERE w.warehouse_code IN ('100667', '100668')
       AND NOT EXISTS (
         SELECT 1 FROM mdm.warehouse t WHERE t.plant_id = oa.plant_id AND t.warehouse_code = w.warehouse_code)
  LOOP
    used := false;
    FOR ref IN
      SELECT c.conrelid::regclass AS tbl, a.attname AS col
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
       WHERE c.contype = 'f' AND c.confrelid = 'mdm.warehouse'::regclass AND c.conrelid <> 'mdm.location'::regclass
    LOOP
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE %I = $1)', ref.tbl, ref.col) INTO used USING target.warehouse_id;
      EXIT WHEN used;
    END LOOP;
    IF used THEN
      RAISE NOTICE '창고 % 는 이미 쓰여 PL11 에 둔다 — 공장을 손으로 정리한다', target.warehouse_code;
      CONTINUE;
    END IF;
    UPDATE mdm.warehouse
       SET plant_id = target.oa_plant_id, version_no = version_no + 1
     WHERE warehouse_id = target.warehouse_id;
  END LOOP;
END $$;
