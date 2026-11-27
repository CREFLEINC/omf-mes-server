-- 공정 반제품 LOT 유형(피처 016, omf-all-around#359). 배포 때 Routing 의 마지막이 아닌 공정 W/O 의
-- 선발행 LOT 이 이 유형으로 선다. 다음 공정 W/O 에 투입(자재 투입 API)된다.
-- ⭐ 배포는 migrate deploy 만 돈다 — seed.ts 에도 같은 값이 있다. 값만 더하므로 옛 코드와 함께 살 수 있다.
INSERT INTO mdm.code_value (code_group_id, code, code_name, display_order, name_ko, name_vi)
SELECT cg.code_group_id, 'WIP', '반제품', 25, '반제품', 'Bán thành phẩm'
  FROM mdm.code_group cg
 WHERE cg.group_code = 'LOT_TYPE'
ON CONFLICT (code_group_id, code) DO NOTHING;

COMMENT ON COLUMN trace.lot.lot_type_code IS
  'LOT 유형(코드 그룹 LOT_TYPE) — MATERIAL 자재, PRODUCTION 생산(마지막 공정), WIP 공정 반제품(마지막이 아닌 공정, 다음 공정에 투입), PRODUCT 제품';
