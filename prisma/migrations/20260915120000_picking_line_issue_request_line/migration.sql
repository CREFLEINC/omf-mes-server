-- 피킹 라인 → 자재 출고요청 «라인» 축을 연다 (설계 문의 046 · P-15).
--
-- 지금까지 `picking_line` 은 요청 «헤더»만 가리켰다(`picking_order.source_document_id`).
-- 그래서 출고 전기가 어느 요청 라인의 기출고인지 되짚을 수 없었고
-- `material_issue_request_line.issued_qty` 가 언제나 0 이었다.
--
-- nullable 이라 하위 호환이다 — 블루-그린 배포 중 옛 코드가 새 스키마를 봐도 된다.
ALTER TABLE logistics.picking_line
  ADD COLUMN material_issue_request_line_id bigint;

ALTER TABLE logistics.picking_line
  ADD CONSTRAINT fk_picking_line_issue_request_line
  FOREIGN KEY (material_issue_request_line_id)
  REFERENCES logistics.material_issue_request_line(material_issue_request_line_id);

CREATE INDEX ix_picking_line_issue_request_line
  ON logistics.picking_line (material_issue_request_line_id);

-- 이미 있는 라인 채우기. 같은 요청 안에서 품목이 «유일할 때만» 짝짓는다 — 같은 품목이 BOM
-- 구성 두 줄에 있으면 어느 요청 라인의 몫인지 정할 수 없어 비워 둔다(046 「서버가 짝을
-- 지어내지 않는다」). 비어 있는 라인은 출고해도 `issued_qty` 가 안 오르고, 그것이 옳다.
UPDATE logistics.picking_line pl
   SET material_issue_request_line_id = (
     SELECT mirl.material_issue_request_line_id
       FROM logistics.material_issue_request_line mirl
       JOIN logistics.picking_order po
         ON po.picking_order_id = pl.picking_order_id
        AND po.source_document_type_code = 'MATERIAL_ISSUE_REQUEST'
      WHERE mirl.material_issue_request_id = po.source_document_id
        AND mirl.item_id = pl.item_id
   )
 WHERE pl.material_issue_request_line_id IS NULL
   AND (
     SELECT count(*)
       FROM logistics.material_issue_request_line mirl
       JOIN logistics.picking_order po
         ON po.picking_order_id = pl.picking_order_id
        AND po.source_document_type_code = 'MATERIAL_ISSUE_REQUEST'
      WHERE mirl.material_issue_request_id = po.source_document_id
        AND mirl.item_id = pl.item_id
   ) = 1;
