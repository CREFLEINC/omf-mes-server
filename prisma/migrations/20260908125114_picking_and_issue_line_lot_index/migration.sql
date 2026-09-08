-- logistics.picking_line · goods_issue_line 에 lot_id 선두 인덱스를 세운다 (I-20 M-g).
--
-- ⭐ 근거 — I-20 R-21 과 «같은 부류»다: **PostgreSQL 은 FK 에 인덱스를 자동 생성하지 않는다.**
--    실측(dev DB \di): 두 표의 인덱스는 pkey · uq_* · ix_*_location 뿐이고 lot_id 가 선두인 것이 0개다.
--    GET /quality/lot-status-transitions 의 impact 두 칸이 LOT 한 건 축으로 두 표를 읽는데
--    EXPLAIN 이 Seq Scan on picking_line · Seq Scan on goods_issue_line 을 낸다(#361 리뷰 Minor-4).
--    선례: ix_inbound_line_lot (inbound_receipt_line.lot_id) — 같은 이유로 이미 서 있다.
--
-- ⚠ 두 표는 «레인 C 의 도메인»(logistics)이다. 인덱스는 추가만 하고 컬럼·제약은 건드리지 않는다.
--    lot_id 는 두 표 다 NOT NULL 이라 부분 술어(WHERE lot_id IS NOT NULL)가 필요 없고,
--    비부분이므로 schema.prisma 에 «반드시» 적는다(안 적으면 migrate diff 가 DROP INDEX 를 낸다).
--
-- ✅ 추가만 · 삭제 0 · 백필 0 · 순서 의존 0 (docs/coverage-100/lanes.md §1-2).

CREATE INDEX ix_picking_line_lot
    ON logistics.picking_line USING btree (lot_id);

CREATE INDEX ix_goods_issue_line_lot
    ON logistics.goods_issue_line USING btree (lot_id);
