-- 같은 창고 안 위치 이동(사용자 결정 2026-10-29) — 창고 이동 전표에 유형 하나를 더한다. seed.ts 에도 같은 값.
INSERT INTO mdm.code_value (code_group_id, code, code_name, display_order)
SELECT cg.code_group_id, 'LOCATION_MOVE', '위치 이동', 30
  FROM mdm.code_group cg
 WHERE cg.group_code = 'STOCK_TRANSFER_TYPE'
ON CONFLICT (code_group_id, code) DO NOTHING;
