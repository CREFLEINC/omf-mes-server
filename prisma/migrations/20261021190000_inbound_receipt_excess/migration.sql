-- 입하 줄 하나(LOT 하나 · IQC 한 단위)에서 그 줄의 P/O 라인에 넣지 않은 몫(초과분).
-- ERP 가 그 몫으로 추가 P/O 를 만들어 보내면 그 P/O 라인을 잇는다 — 이을 때 그 라인의 received_qty 가 오른다.
-- 입하 줄을 지우면 함께 지운다. 이어진 몫이 있는 줄은 서버가 지우기·수량 변경을 먼저 막는다.
CREATE TABLE logistics.inbound_receipt_excess (
    inbound_receipt_excess_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    inbound_receipt_line_id   bigint NOT NULL
                              REFERENCES logistics.inbound_receipt_line(inbound_receipt_line_id) ON DELETE CASCADE,
    excess_qty                numeric(20, 6) NOT NULL CHECK (excess_qty > 0),
    purchase_order_line_id    bigint REFERENCES logistics.purchase_order_line(purchase_order_line_id),
    linked_at                 timestamptz,
    linked_by                 bigint,
    created_at                timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by                bigint,
    updated_at                timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by                bigint,
    version_no                integer NOT NULL DEFAULT 1,
    CONSTRAINT ck_inbound_excess_link CHECK ((purchase_order_line_id IS NULL) = (linked_at IS NULL))
);

CREATE INDEX ix_inbound_excess_line ON logistics.inbound_receipt_excess (inbound_receipt_line_id);
CREATE INDEX ix_inbound_excess_po_line ON logistics.inbound_receipt_excess (purchase_order_line_id);
CREATE INDEX ix_inbound_excess_unlinked ON logistics.inbound_receipt_excess (inbound_receipt_excess_id)
    WHERE purchase_order_line_id IS NULL;
