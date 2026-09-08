-- trace.lot_hold 에 「도착 상태」 두 칸과 version_no 를 더한다 (I-20).
--
-- 계약: quality-03품질.json 의 LotHold.lotStatusCode · LotHoldEvent.targetLotStatusCode
-- 화면: W-03-01 보류 이력 · W-03-02 보류/해제
--
-- ✅ 추가·완화만 · 삭제 0 · 백필 0 · 순서 의존 0 (docs/coverage-100/lanes.md §1-2).

-- ⓐⓑ 도착 상태 두 칸 — 등록 도착과 해제 도착은 «같은 행의 다른 사실»이다.
--    부분 해제는 LOT 전이가 0건이라 lot_status_event 에서 도출할 원본이 없고,
--    두 칸은 값 집합조차 겹치지 않는다(C9·C10 ↔ C7·C8).
ALTER TABLE trace.lot_hold
    ADD COLUMN target_lot_status_code         app.code_t,
    ADD COLUMN release_target_lot_status_code app.code_t,
-- ⓒ V-lot_hold — `:release` 의 If-Match 대상. 기존 행은 전부 1 로 서서 백필이 없다.
    ADD COLUMN version_no                     integer NOT NULL DEFAULT 1;

COMMENT ON COLUMN trace.lot_hold.target_lot_status_code IS
    '보류를 걸 때 LOT 이 간 상태(LOT_STATUS) — C9=DEFECTIVE · C10=INSPECTION_PENDING. 계약 LotHold.lotStatusCode.';
COMMENT ON COLUMN trace.lot_hold.release_target_lot_status_code IS
    '해제가 LOT 을 보낸 상태(LOT_STATUS) — C7=NORMAL · C8=DEFECTIVE. 계약 LotHoldEvent.targetLotStatusCode(RELEASED 사건).';

-- ⓓ 해제 전에는 해제 도착이 없다. 기존 행은 전부 NULL 이라 «깨는 행 0».
ALTER TABLE trace.lot_hold
    ADD CONSTRAINT ck_lot_hold_release_target
        CHECK (released_at IS NOT NULL OR release_target_lot_status_code IS NULL);

-- ⓔ GET /quality/lot-hold-events 는 기간을 «필수»로 받고 lotId 는 선택이다.
--    이 표의 인덱스는 ix_lot_hold_active(lot_id) 하나뿐이라 기본 질의를 받칠 것이 없다.
--    0단계 선례: 20260901030000 이 형제 표에 ix_lot_status_event_changed_at 을 같은 이유로 세웠다.
CREATE INDEX ix_lot_hold_held_at
    ON trace.lot_hold USING btree (held_at DESC);
CREATE INDEX ix_lot_hold_released_at
    ON trace.lot_hold USING btree (released_at DESC)
    WHERE released_at IS NOT NULL;
