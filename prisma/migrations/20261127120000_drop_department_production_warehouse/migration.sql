-- ⛔ 사용을 뗀 판(#1152 생산창고 판정 · #1155 부서 생산 창고 경로 삭제)이 배포된 «다음» 릴리스에만 싣는다 —
--    블루-그린 전환 중 옛 판이 이 표를 본다(창고 삭제 참조 검사 · Prisma 모델).

-- 부서 생산 창고 — 생산 창고는 창고 유형 PRODUCTION 이다(사용자 결정 2026-11-25). 연결된 창고는 20261125180000 이 PRODUCTION 으로 바꿨다.
DROP TABLE mdm.department_production_warehouse;

COMMENT ON COLUMN logistics.replenishment_item.warehouse_id IS '생산창고(창고 유형 PRODUCTION).';
