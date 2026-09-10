-- I-23 자리 ④ · A14·M-f·U-I 잔여.
-- `confirmed_*`·`cancelled_*` 는 20260901040000 이 이미 세웠다(실측 25칸) — 여기서 다시 세우지 않는다.

ALTER TABLE logistics.shipment
  ADD COLUMN IF NOT EXISTS expedited       boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS expedite_reason text;

COMMENT ON COLUMN logistics.shipment.expedited IS
  '긴급 직행 출하(W-04-05) — 창고 경유·피킹·Packing 을 건너뛴다. 품질 게이트는 건너뛰지 않는다.';
COMMENT ON COLUMN logistics.shipment.expedite_reason IS
  '긴급 사유. expedited 가 참인 건에만 있다(공유계약 A-12). 짝 불변식은 ck_shipment_expedite 가 본다.';

-- 기존 행 0건을 확인하고 넣는다(실측 2026-09-10). 행이 있으면 NOT VALID 가 필요했다.
ALTER TABLE logistics.shipment
  ADD CONSTRAINT ck_shipment_expedite CHECK (expedited = false OR expedite_reason IS NOT NULL);

-- 자리 ④ — 재등록이 만든 이동이 «어느 처분 결정»을 반영했나.
-- ⛔ 새 표(logistics.stock_reinstatement)를 세우지 않는 근거는 I-23.md §2-3 이다:
--    계약에 StockReinstatement* 리소스 id 가 없고 응답이 stockTransferId 만 내린다.
ALTER TABLE logistics.stock_transfer
  ADD COLUMN IF NOT EXISTS disposition_decision_id bigint
    REFERENCES quality.disposition_decision(disposition_decision_id);

COMMENT ON COLUMN logistics.stock_transfer.disposition_decision_id IS
  '재고 재등록(POST /logistics/stock-reinstatements)이 반영한 처분 결정. 그 경로만 채운다 — 일반 이동은 NULL.';

-- 부분 인덱스 — 일반 이동이 압도적 다수라 NULL 을 색인에 담지 않는다.
CREATE INDEX IF NOT EXISTS ix_stock_transfer_disposition
  ON logistics.stock_transfer(disposition_decision_id)
  WHERE disposition_decision_id IS NOT NULL;
