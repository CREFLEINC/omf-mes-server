-- 창고에 거래처를 두지 않는다 — 외부창고 표시는 두고 거래처만 뺀다(사용자 결정 2026-10-29).
-- 칸 삭제는 다음 릴리스에 한다 — 블루-그린 전환 중 옛 코드가 이 칸을 쓴다. 제약은 지금 걷어야 거래처 없이 외부창고를 둔다.
ALTER TABLE mdm.warehouse DROP CONSTRAINT IF EXISTS ck_external_warehouse_partner;

-- 운영 초기 데이터가 짐작해 붙인 거래처를 비우고, 거래처를 못 찾아 지어낸 EXTWH_* 거래처를 지운다.
UPDATE mdm.warehouse
   SET partner_id = NULL, version_no = version_no + 1
 WHERE partner_id IS NOT NULL;

-- 다른 행이 가리키는 거래처는 남기고 NOTICE 를 남긴다.
DO $$
DECLARE
  target record;
  ref record;
  used boolean;
BEGIN
  FOR target IN SELECT partner_id, partner_code FROM mdm.partner WHERE partner_code LIKE 'EXTWH\_%' ESCAPE '\'
  LOOP
    used := false;
    FOR ref IN
      SELECT c.conrelid::regclass AS tbl, a.attname AS col
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
       WHERE c.contype = 'f' AND c.confrelid = 'mdm.partner'::regclass
    LOOP
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE %I = $1)', ref.tbl, ref.col) INTO used USING target.partner_id;
      EXIT WHEN used;
    END LOOP;
    IF used THEN
      RAISE NOTICE '거래처 % 는 이미 쓰여 남긴다 — 손으로 정리한다', target.partner_code;
      CONTINUE;
    END IF;
    DELETE FROM mdm.partner WHERE partner_id = target.partner_id;
  END LOOP;
END $$;
