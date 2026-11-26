-- 생산 창고 판정을 부서 연결(mdm.department_production_warehouse)에서 창고 유형 PRODUCTION(생산창고)으로 옮긴다(사용자 결정 2026-11-25).
-- 연결 표는 이 릴리스에서 쓰지 않을 뿐 지우지 않는다 — 블루-그린 전환 중 옛 판이 이 표를 읽는다. 삭제는 다음 릴리스.

-- ① 코드 값 — 2026-09-03 에 내린 값을 다시 세운다. ⭐ 배포는 migrate deploy 만 돈다 — seed.ts 에도 같은 값이 있다.
INSERT INTO mdm.code_value (code_group_id, code, code_name, display_order)
SELECT cg.code_group_id, 'PRODUCTION', '생산창고', 50
  FROM mdm.code_group cg
 WHERE cg.group_code = 'WAREHOUSE_TYPE'
ON CONFLICT (code_group_id, code) DO UPDATE SET is_active = true, code_name = EXCLUDED.code_name;

-- ② 부서에 연결돼 있던 창고는 생산창고가 된다 — 판정이 바뀌어도 같은 창고가 출발 창고·보충 대상으로 남는다.
UPDATE mdm.warehouse w
   SET warehouse_type_code = 'PRODUCTION', updated_at = clock_timestamp(), version_no = w.version_no + 1
 WHERE w.warehouse_type_code <> 'PRODUCTION'
   AND EXISTS (SELECT 1 FROM mdm.department_production_warehouse l WHERE l.warehouse_id = w.warehouse_id);
