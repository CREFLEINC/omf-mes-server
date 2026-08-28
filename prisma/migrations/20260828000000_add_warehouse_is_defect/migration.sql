-- 불량창고 여부.
--
-- 요청: 이슈 #47 · 확정 근거 DR-012-불량창고유형 3-C(2026-08-13)
-- 계약: mdm-기준정보.json 의 Warehouse·WarehouseCreate·WarehouseUpdate 에 isDefect 가
--       이미 있고, GET /mdm/warehouses 는 isDefect 를 목록 필터로 받는다.
--       Warehouse.required 에도 들어 있어 응답에서 생략할 수 없다.
--
-- 왜 유형 코드로 풀지 않는가:
--   창고 유형(warehouse_type_code — 자재·제품·반제품·상품·생산)과 «다른 축»이다.
--   불량은 자재 불량창고도 제품 불량창고도 받는다. 유형에 DEFECT 를 값으로 더하면
--   「자재 불량창고」를 표현할 수 없다 — 유형 칸이 하나뿐이라 둘 중 하나를 버려야 한다.
--   is_external 이 같은 이유로 별도 불리언인 것과 같은 판단이며, 이를 대체하지 않고 보완한다.
--
-- 왜 DEFAULT false 인가:
--   기존 행에 값을 채워야 하는데 「어느 창고가 불량창고인가」는 데이터에 없다. 거짓으로
--   두면 폐기 요청·기타출고 화면(W-01-06)의 창고 선택이 비어 보이고, 참으로 두면 모든
--   창고가 불량창고가 된다. 비어 보이는 쪽이 안전하다 — 운영에서 해당 창고를 켜면 된다.
--
-- ⚠ 시드의 WAREHOUSE_TYPE 에 DEFECT·REWORK 값이 들어 있다(2026-07-28 추가분).
--   이 컬럼이 생기면 같은 뜻이 두 곳에 표현된다. 그 값들의 처분은 공통코드 정본이
--   확정되는 이슈 #45·#46 에서 함께 정한다 — 여기서 지우지 않는다(쓰고 있는 행이
--   있는지 이 저장소에서 확인할 수 없다).

ALTER TABLE mdm.warehouse
    ADD COLUMN is_defect boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN mdm.warehouse.is_defect IS
    '불량창고 여부. 창고 유형(warehouse_type_code)과 별개의 품질 축이다 — 자재 불량창고와 제품 불량창고가 모두 성립한다. 근거: DR-012 3-C(2026-08-13).';
