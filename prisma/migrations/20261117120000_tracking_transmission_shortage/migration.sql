-- 자재 차감에서 재고가 모자라 빼지 못한 몫. 제품 입고는 막지 않고 이 몫을 화면에서 정리한다(flowtrack 연동 결정 16).
CREATE TABLE integration.tracking_transmission_shortage (
  tracking_transmission_id bigint    NOT NULL REFERENCES integration.tracking_transmission(tracking_transmission_id),
  item_id                  bigint    NOT NULL REFERENCES mdm.item(item_id),
  uom_id                   bigint    NOT NULL REFERENCES mdm.uom(uom_id),
  warehouse_id             bigint    NOT NULL REFERENCES mdm.warehouse(warehouse_id),
  shortage_qty             app.qty_t NOT NULL,
  PRIMARY KEY (tracking_transmission_id, item_id, uom_id),
  CONSTRAINT ck_tracking_transmission_shortage_qty CHECK (shortage_qty > 0)
);
