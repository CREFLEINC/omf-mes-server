-- inventory.inventory_balance 의 warehouse_id 에 인덱스를 단다.
--
-- ⚠ 이 인덱스는 OMF-MES 구현 측 추가분이다. 모델링 정본 SQL에 역반영이 필요하다.
--
-- 20260805000000_add_warehouse_fk_indexes 가 이 테이블을 제외하며 적은 근거
-- 「warehouse_id 가 선행 컬럼인 인덱스를 이미 갖는다(ix_inventory_available)」는 틀렸다.
-- 그 인덱스는 부분 인덱스다:
--
--   ix_inventory_available (warehouse_id, item_id, available_qty DESC)
--     WHERE available_qty > 0 AND inventory_status_code = 'AVAILABLE'
--
-- 창고 하나로 조회하는 쪽은 두 조건 중 어느 것도 걸지 않으므로 이 인덱스를 쓸 수 없다.
-- 남은 후보는 전부 선행 컬럼이 다르다 — ix_inventory_balance_lookup 은 plant_id,
-- uq_inventory_balance_dim 은 legal_entity_id 로 시작한다. 실제 계획도 그렇게 나온다:
--
--   Index Scan using ix_inventory_balance_lookup  Index Cond: (warehouse_id = 1)
--
-- 선행 컬럼이 없어 탐색이 아니라 인덱스 전체 훑기다 — 행 수에 비례한다.
--
-- 이 경로를 도는 곳은 둘이다:
--   · 창고 상세 조회의 참조 건수 — 편집 잠금 판정이라 화면을 열 때마다 돈다
--   · 창고 사용 중지의 잔량 검사 — 드문 관리 작업
-- 값이 큰 쪽은 앞이다.
--
-- 잔량 검사가 네 수량을 OR 로 보므로 수량 컬럼을 인덱스에 넣지 않는다. 어차피 걸러야
-- 하고, 참조 건수 쪽은 수량을 아예 보지 않는다.

CREATE INDEX ix_inventory_balance_warehouse
  ON inventory.inventory_balance (warehouse_id);
