-- A13 (I-22 §2-6) — logistics.shipment_request.sales_order_id?
--
-- 왜: 계약 ShipmentRequest.salesOrderId 가 nullable 로 실재하고, GET /logistics/sales-orders
--     의 unassignedOnly 질의가 「편성 여부」를 이 칸으로만 판정할 수 있다. 라인 축
--     (shipment_request_line.sales_order_line_id)은 이미 있으나 헤더 축이 없어
--     「지시서 하나가 편성됐는가」를 한 번에 물을 수 없다(W-04-01 §5-2).
-- ⛔ NOT NULL 로 세우지 않는다 — 「무지시 standalone 이 예외가 아니라 상시 구조」다(계약).
-- ⭐ 추가 1 · 완화 0 · 삭제 0 · 백필 0 — 순서에 의존하지 않는다(lanes.md §1-2).
-- ⛔ FK 제약 이름을 적지 않는다 — Prisma 기본형
--    `shipment_request_sales_order_id_fkey` 여야 `migrate diff` 가 드리프트를 내지 않는다.
--
-- 사전 대조(마이그 «전» 개발 DB 실측 · 읽기만):
--   SELECT count(*) FROM information_schema.columns
--    WHERE table_schema='logistics' AND table_name='shipment_request'
--      AND column_name='sales_order_id';                      -- → 0
--   SELECT count(*) FROM logistics.shipment_request;          -- → 0 (seed.ts INSERT 0건)
ALTER TABLE logistics.shipment_request
    ADD COLUMN sales_order_id bigint
        REFERENCES logistics.sales_order(sales_order_id);

-- unassignedOnly 의 NOT EXISTS 가 이 칸을 실제로 탄다(A4 와 갈리는 근거 · §2-6).
CREATE INDEX ix_shipment_request_sales_order
    ON logistics.shipment_request (sales_order_id);

COMMENT ON COLUMN logistics.shipment_request.sales_order_id IS
    '상위 고객사 출하지시서. nullable — 단독 생성(무지시)이 상시 구조다(W-04-01 §5-2). GET /logistics/sales-orders?unassignedOnly 가 이 칸으로 편성 여부를 판정한다.';
