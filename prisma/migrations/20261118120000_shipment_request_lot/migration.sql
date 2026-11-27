-- 피처 010 출하 공정 단순화(omf-all-around#305) — 피킹 LOT 표·출하 완료 칸·CHECK 두 개·코드값.
-- 기존 행은 바꾸지 않는다(새 칸은 NULL, 새 표는 비어 있다). 옛 흐름(W-04-04 출하 처리·긴급 직행)은 그대로 돈다.

-- ① 피킹 LOT — 지시서 라인 × LOT 한 행. 수량 정본은 예약(inventory_reservation, 원천 SHIPMENT_REQUEST_LINE)이고
--    이 행은 LOT 마다 상태·출하 관리 코드·교체 이력을 담는다.
CREATE TABLE logistics.shipment_request_lot (
    shipment_request_lot_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    shipment_request_line_id     bigint NOT NULL REFERENCES logistics.shipment_request_line(shipment_request_line_id),
    lot_id                       bigint NOT NULL REFERENCES trace.lot(lot_id),
    picked_qty                   app.qty_t NOT NULL CHECK (picked_qty > 0),
    uom_id                       bigint NOT NULL REFERENCES mdm.uom(uom_id),
    status_code                  varchar(20) NOT NULL CHECK (status_code IN ('PICKED', 'REPLACED', 'SHIPPED')),
    management_code              varchar(100),
    picked_at                    timestamptz NOT NULL DEFAULT clock_timestamp(),
    picked_worker_id             bigint REFERENCES mdm.worker(worker_id),
    replaced_at                  timestamptz,
    replaced_worker_id           bigint REFERENCES mdm.worker(worker_id),
    replace_inspection_result_id bigint REFERENCES quality.inspection_result(inspection_result_id),
    replace_nonconformance_id    bigint REFERENCES quality.nonconformance(nonconformance_id),
    shipment_id                  bigint REFERENCES logistics.shipment(shipment_id),
    created_at                   timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by                   bigint,
    updated_at                   timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by                   bigint,
    version_no                   integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT ck_shipment_request_lot_replaced CHECK (
        (status_code = 'REPLACED') = (replaced_at IS NOT NULL AND replace_inspection_result_id IS NOT NULL)
    ),
    CONSTRAINT ck_shipment_request_lot_shipped CHECK ((status_code = 'SHIPPED') = (shipment_id IS NOT NULL))
);
COMMENT ON TABLE logistics.shipment_request_lot IS
  '출하 지시서 피킹 LOT(PDA LOT 통째 피킹) — 상태 PICKED·REPLACED·SHIPPED, 출하 관리 코드, 교체 이력. 수량 정본은 예약(omf-all-around#305)';
COMMENT ON COLUMN logistics.shipment_request_lot.picked_qty IS
  '피킹 때 그 LOT 의 공장 안 가용 합(불량창고 제외). 창고·위치별 몫은 예약 행에서 읽는다';
COMMENT ON COLUMN logistics.shipment_request_lot.management_code IS '출하 관리 코드(선택, 중복·형식 검사 없음)';
-- 같은 라인에 같은 LOT 이 살아 있는 것은 하나다 — 교체된 행은 이력으로 남는다.
CREATE UNIQUE INDEX uq_shipment_request_lot_live
    ON logistics.shipment_request_lot (shipment_request_line_id, lot_id)
 WHERE status_code <> 'REPLACED';
CREATE INDEX ix_shipment_request_lot_lot ON logistics.shipment_request_lot (lot_id);
CREATE INDEX ix_shipment_request_lot_shipment ON logistics.shipment_request_lot (shipment_id);

-- ② 출하 — POP 출하 완료 단말·작업자. 새 흐름 출하는 여러 창고라 창고가 없다(옛 흐름·긴급 직행은 지금처럼 필수).
ALTER TABLE logistics.shipment
    ADD COLUMN completed_terminal_id bigint REFERENCES mdm.terminal(terminal_id),
    ADD COLUMN completed_worker_id   bigint REFERENCES mdm.worker(worker_id);
COMMENT ON COLUMN logistics.shipment.completed_terminal_id IS 'POP 출하 완료(P-04-07) 단말 — 새 흐름 출하만(omf-all-around#305)';
COMMENT ON COLUMN logistics.shipment.completed_worker_id IS 'POP 출하 완료 작업자';
ALTER TABLE logistics.shipment ALTER COLUMN warehouse_id DROP NOT NULL;
ALTER TABLE logistics.shipment
    ADD CONSTRAINT ck_shipment_warehouse CHECK (completed_terminal_id IS NOT NULL OR warehouse_id IS NOT NULL);
-- 지시서 하나에 살아 있는 새 흐름 출하는 하나다 — 동시에 두 POP 이 완료해도 하나만 선다.
CREATE UNIQUE INDEX uq_shipment_completed_request
    ON logistics.shipment (shipment_request_id)
 WHERE completed_terminal_id IS NOT NULL AND status_code <> 'CANCELLED';

-- ③ 출하가 목표(배정)를 넘을 수 있다 — 초과는 마지막 LOT 에서만 생긴다(D-2).
ALTER TABLE logistics.shipment_request_line DROP CONSTRAINT ck_shipment_request_qty;
ALTER TABLE logistics.shipment_request_line
    ADD CONSTRAINT ck_shipment_request_qty CHECK (allocated_qty <= requested_qty);

-- ④ 수주 초과 출고를 받는다(ERP 확인 2026-11-18 · D-16) — 출하 ≤ 수주 수량 CHECK 를 지운다.
ALTER TABLE logistics.sales_order_line DROP CONSTRAINT ck_sales_shipped_qty;

-- ⑤ 매칭 LOT 표는 OQC 결과도 쓴다.
COMMENT ON TABLE quality.inspection_result_lot IS
  'IQC·OQC 결과 ↔ 매칭 LOT. IQC 는 결과의 요청이 가리키는 입하 LOT 소속, OQC 는 그 지시서·품목의 피킹 LOT(서비스 규칙).';

-- ⑥ 코드값. ⭐ 배포는 migrate deploy 만 돈다 — seed.ts 에도 같은 값이 있다.
INSERT INTO mdm.code_group (group_code, group_name, is_system_owned)
VALUES ('SHIPMENT_REQUEST_LOT_STATUS', '출하 지시 피킹 LOT 상태', true)
ON CONFLICT (group_code) DO NOTHING;

INSERT INTO mdm.code_value (code_group_id, code, code_name, display_order, name_ko, name_vi)
SELECT cg.code_group_id, v.code, v.code_name, v.display_order, v.code_name, v.name_vi
  FROM mdm.code_group cg
  JOIN (VALUES
    ('PICKED', '피킹', 10, 'Đã lấy hàng'),
    ('REPLACED', '교체됨', 20, 'Đã thay thế'),
    ('SHIPPED', '출하됨', 30, 'Đã xuất hàng')
  ) AS v(code, code_name, display_order, name_vi) ON cg.group_code = 'SHIPMENT_REQUEST_LOT_STATUS'
ON CONFLICT (code_group_id, code) DO NOTHING;

-- 송신 전 취소된 메시지(D-9) — 러너는 PENDING 만 집으므로 다시 보내지 않는다.
INSERT INTO mdm.code_value (code_group_id, code, code_name, display_order, name_ko, name_vi)
SELECT cg.code_group_id, 'CANCELLED', '취소', 50, '취소', 'Đã hủy'
  FROM mdm.code_group cg
 WHERE cg.group_code = 'INTEGRATION_MESSAGE_STATUS'
ON CONFLICT (code_group_id, code) DO NOTHING;
