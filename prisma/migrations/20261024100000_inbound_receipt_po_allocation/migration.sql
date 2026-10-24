-- 입하 줄 ↔ P/O 라인 배정. 입하 줄(LOT 하나)의 받은 수량을 P/O 라인별 몫으로 나눠 적는다 — 「주인 P/O 한 칸 + 초과분」(장부 P-100)을 대신한다.
-- 미배정 = received_qty − Σ allocated_qty 로 계산한다(표에 두지 않는다). 무발주 줄(예외 유형)은 배정 0줄이다.
-- 같은 (입하 줄, P/O 라인) 에 몫이 여럿일 수 있다 — ERP 가 추가 P/O 를 만드는 대신 원래 P/O 수량을 늘려 주면 같은 라인에 몫을 더 잇는다.
--   몫 하나가 ERP 구매입고 한 행이라 합치지 않는다(보낸 몫은 outbox 로 잠근다).
-- 「Σ allocated_qty ≤ received_qty」는 표 하나의 CHECK 로 걸 수 없어 서비스가 입하 줄을 잠그고 본다(잠금 순서 입하 → P/O, P-100 과 같다).
-- ⚠ 옛 자리(inbound_receipt_line.purchase_order_line_id · inbound_receipt_excess)는 남긴다 — 블루-그린 배포 중 옛 코드가 읽는다. 다음 릴리스에서 지운다.
CREATE TABLE logistics.inbound_receipt_po_allocation (
    inbound_receipt_po_allocation_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    inbound_receipt_line_id          bigint NOT NULL
                                     REFERENCES logistics.inbound_receipt_line(inbound_receipt_line_id) ON DELETE CASCADE,
    purchase_order_line_id           bigint NOT NULL REFERENCES logistics.purchase_order_line(purchase_order_line_id),
    allocated_qty                    numeric(20, 6) NOT NULL CHECK (allocated_qty > 0),
    created_at                       timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by                       bigint,
    updated_at                       timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by                       bigint,
    version_no                       integer NOT NULL DEFAULT 1
);

CREATE INDEX ix_inbound_po_allocation_line ON logistics.inbound_receipt_po_allocation (inbound_receipt_line_id);
CREATE INDEX ix_inbound_po_allocation_po_line ON logistics.inbound_receipt_po_allocation (purchase_order_line_id);

-- 옮겨 적기 ① — 줄의 P/O 라인 몫 = 받은 수량 − 그 줄의 초과분 합. 0 이면 만들지 않는다(전부 초과분인 줄은 지금 규칙으로는 없지만 막지 않는다).
--   취소된 입하의 줄도 옮긴다 — 지금도 취소가 P/O 칸을 비우지 않고 받은 수량만 되돌리듯, 배정 행은 남고 수량만 되돌린 상태로 본다.
INSERT INTO logistics.inbound_receipt_po_allocation
    (inbound_receipt_line_id, purchase_order_line_id, allocated_qty, created_at, created_by, updated_at, updated_by)
SELECT l.inbound_receipt_line_id,
       l.purchase_order_line_id,
       l.received_qty - COALESCE(x.excess_total, 0),
       l.created_at, l.created_by, l.updated_at, l.updated_by
FROM logistics.inbound_receipt_line l
LEFT JOIN (
    SELECT inbound_receipt_line_id, SUM(excess_qty) AS excess_total
    FROM logistics.inbound_receipt_excess
    GROUP BY inbound_receipt_line_id
) x ON x.inbound_receipt_line_id = l.inbound_receipt_line_id
WHERE l.purchase_order_line_id IS NOT NULL
  AND l.received_qty - COALESCE(x.excess_total, 0) > 0;

-- 옮겨 적기 ② — 이어진 초과분은 그 P/O 라인의 몫이다. 안 이어진 초과분은 미배정 잔량이 되므로 행을 만들지 않는다.
INSERT INTO logistics.inbound_receipt_po_allocation
    (inbound_receipt_line_id, purchase_order_line_id, allocated_qty, created_at, created_by, updated_at, updated_by)
SELECT e.inbound_receipt_line_id,
       e.purchase_order_line_id,
       e.excess_qty,
       e.linked_at, e.linked_by, e.updated_at, e.updated_by
FROM logistics.inbound_receipt_excess e
WHERE e.purchase_order_line_id IS NOT NULL;
