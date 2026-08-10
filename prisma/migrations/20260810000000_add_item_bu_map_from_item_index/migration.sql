-- mdm.item_bu_item_map 의 from_item_id 에 인덱스를 단다.
--
-- ⚠ 이 인덱스는 OMF-MES 구현 측 추가분이다. 모델링 정본 SQL에 역반영이 필요하다.
--
-- 왜 이것만인가:
--   품목의 부속 3종은 모두 「이 품목의 목록을 달라」로 조회한다. 둘은 유일키가
--   품목을 선행 컬럼으로 가져 이미 쓸 수 있다.
--
--     uq_item_uom_conversion (item_id, from_uom_id, to_uom_id, effective_from)      ✓
--     uq_item_external_code  (item_id, external_system_code, COALESCE(partner_id,0), external_item_code)  ✓
--     uq_item_bu_item_map    (from_business_unit_id, from_item_id, to_business_unit_id, effective_from)   ✗
--
--   사업부 매핑만 사업부가 선행이고 품목이 두 번째다. 「이 품목의 매핑」 조회는
--   그 인덱스를 탐색에 쓸 수 없다.
--
-- mdm.item 전체로는 FK 39개 중 33개에 인덱스가 없지만 달지 않는다.
--   창고(15)·로케이션(26)·부서(7)에 단 것은 편집 잠금을 판정하려고 **참조 건수를
--   세기** 위한 것이었다. 품목은 ERP 수신본이라 editability 가 항상
--   RECEIVED_FROM_ERP 이고 셀 일이 없다. 지금 33개를 달면 재고 이동이 쌓이는
--   가장 바쁜 테이블들에 아무도 안 쓰는 인덱스를 얹는다.

CREATE INDEX ix_item_bu_item_map_from_item
  ON mdm.item_bu_item_map (from_item_id);
