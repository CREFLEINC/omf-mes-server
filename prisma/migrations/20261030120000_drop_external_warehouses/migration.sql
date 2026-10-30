-- 외부 창고는 MES 가 관리할 대상이 아니다(사용자 결정 2026-10-30) — 창고를 그 위치·위치 품목·배치도와 함께 지운다.
-- 다른 행이 창고나 그 위치를 가리키면 그 창고는 남기고 NOTICE 를 남긴다.
-- is_external·partner_id 칸 삭제는 다음 릴리스에 한다 — 블루-그린 전환 중 옛 코드가 이 칸을 쓴다.
DO $$
DECLARE
  target record;
  ref record;
  used boolean;
BEGIN
  FOR target IN SELECT warehouse_id, warehouse_code FROM mdm.warehouse WHERE is_external ORDER BY warehouse_id
  LOOP
    used := false;
    FOR ref IN
      SELECT c.conrelid::regclass AS tbl, a.attname AS col, c.confrelid = 'mdm.location'::regclass AS to_location
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
       WHERE c.contype = 'f'
         AND c.confrelid IN ('mdm.warehouse'::regclass, 'mdm.location'::regclass)
         AND c.conrelid NOT IN ('mdm.location'::regclass, 'mdm.location_item'::regclass, 'mdm.warehouse_layout'::regclass)
    LOOP
      IF ref.to_location THEN
        EXECUTE format(
          'SELECT EXISTS (SELECT 1 FROM %s WHERE %I IN (SELECT location_id FROM mdm.location WHERE warehouse_id = $1))',
          ref.tbl, ref.col) INTO used USING target.warehouse_id;
      ELSE
        EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE %I = $1)', ref.tbl, ref.col) INTO used USING target.warehouse_id;
      END IF;
      EXIT WHEN used;
    END LOOP;
    IF NOT used THEN
      -- 다른 창고의 위치가 이 창고 위치를 상위로 두었으면 아래 DELETE 가 FK 에 막힌다.
      SELECT EXISTS (
        SELECT 1 FROM mdm.location child
          JOIN mdm.location parent ON parent.location_id = child.parent_location_id
         WHERE parent.warehouse_id = target.warehouse_id AND child.warehouse_id <> target.warehouse_id)
        INTO used;
    END IF;
    IF used THEN
      RAISE NOTICE '외부 창고 % 는 이미 쓰여 남긴다 — 손으로 정리한다', target.warehouse_code;
      CONTINUE;
    END IF;
    DELETE FROM mdm.warehouse_layout WHERE warehouse_id = target.warehouse_id;
    -- 위치 품목은 FK(ON DELETE CASCADE)가 함께 지운다. 상위·하위 위치는 한 문장이라 자기 참조 FK 가 순서를 따지지 않는다.
    DELETE FROM mdm.location WHERE warehouse_id = target.warehouse_id;
    DELETE FROM mdm.warehouse WHERE warehouse_id = target.warehouse_id;
  END LOOP;
END $$;
