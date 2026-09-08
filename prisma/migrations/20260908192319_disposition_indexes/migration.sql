-- quality.disposition_decision · nonconformance_lot 에 인덱스 둘을 세운다 (I-21 M-h).
--
-- ⭐ 근거 — I-20 R-21 과 «같은 부류»다: PostgreSQL 은 FK 에 인덱스를 자동 생성하지 않는다.
--
-- ⓑ ix_disposition_decision_nonconformance
--    실측(dev DB pg_indexes): quality.disposition_decision 의 인덱스는 disposition_decision_pkey
--    «하나뿐»이다. nonconformance_id 는 FK 인데 그것을 받칠 인덱스가 0개라
--    GET /quality/nonconformances/{ncId}/disposition-decisions 와 잔량·진행 롤업 셋이
--    전건 Seq Scan 을 돈다. 선례: ix_lot_hold_lot · ix_inventory_balance_lot (20260908110558).
--
-- ⓒ ix_nonconformance_lot_lot
--    실측: 그 표의 인덱스는 nonconformance_lot_pkey 와
--    uq_nonconformance_lot (nonconformance_id, lot_id) 둘인데, 후자는 «선두가 nonconformance_id» 라
--    lot_id 축 질의가 하나도 못 탄다. 그 축을 타는 질의가 넷이다 — 부적합 목록 lotId 필터 ·
--    처분 결정 목록 lotId 필터 · 처분 후보의 withoutNonconformanceOnly NOT EXISTS ·
--    DispositionDecision.lotId 조인.
--
-- ⚠ 두 칸 다 NOT NULL 이라 부분 술어(WHERE … IS NOT NULL)가 필요 없고,
--    비부분이므로 schema.prisma 에 «반드시» 적는다(안 적으면 migrate diff 가 DROP INDEX 를 낸다).
--
-- ✅ 추가만 · 삭제 0 · 백필 0 · 순서 의존 0 (docs/coverage-100/lanes.md §1-2).

CREATE INDEX ix_disposition_decision_nonconformance
    ON quality.disposition_decision USING btree (nonconformance_id);

CREATE INDEX ix_nonconformance_lot_lot
    ON quality.nonconformance_lot USING btree (lot_id);
