-- LOT 생산 이력 조회의 기간별 이력(투입·포장)이 기간만으로 찾는 자리에 인덱스를 단다. 추가만이라 옛 코드와 함께 산다.
-- 투입은 (LOT, 시각)·(W/O, 시각) 인덱스뿐이고 구성 줄은 생성 시각 인덱스가 없어, 기간만으로 부르면 표를 통째로 훑었다.
-- ⚠ 정본 물리 모델에 없는 구현 측 추가분이다(20261026120000_trace_flow_indexes 와 같은 처지). 모델링 SQL 에 역반영이 필요하다.

-- 투입 줄 목록의 기간(투입 시각).
CREATE INDEX ix_material_consumption_occurred_at ON production.material_consumption (occurred_at);
-- 포장 줄 목록의 기간(구성 줄 생성 시각).
CREATE INDEX ix_handling_unit_content_created_at ON inventory.handling_unit_content (created_at);
