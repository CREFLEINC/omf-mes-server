-- trace.lot_lifecycle_history — LOT 생명주기 전이 이력.
--
-- 요청: 이슈 #63 「신규 테이블 1」 · 설계 회신 2026-09-01
-- 계약: logistics-01자재창고.json 의 LotLifecycleHistoryEvent ·
--       GET /trace/lot-lifecycle-events(전이 3종 전건)
--
-- ⛔ trace.lot_status_event 와 «다른 축»이다. 저 표는 품질 판정(C4~C15), 이 표는
--    생명주기(L1~L3)다. 계약이 「두 축을 한 이력에 섞지 않는다」고 못박았고, 화면
--    스펙(W-03-01)에서 둘을 헷갈린 사고가 실제로 있었다. 합치지 않는다.
--
-- 전이 셋(계약 원문):
--   L1  대기 → 활성   첫 실적이 붙을 때, 해당 슬롯
--   L2  대기 → 폐번   마감, 실적 없는 슬롯만
--   L3  활성 → 폐번   작업지시 취소, 그 작업지시의 선발행 슬롯 전건(DR-007)
--
-- ⚠ L3 를 여는 것은 취소 오퍼레이션 한 곳뿐이다 — 사람이 화면에서 직접 폐번하는
--   액션이 없다. 서버가 여는 이력이라 「누가」를 담는 칸을 두지 않는다. 형제 표
--   lot_status_event 에는 changed_by 가 있는데 거기는 사람이 전이시키는 축이라
--   그렇고, 여기는 셋 다 서버가 낸다 — 행위자는 원천 문서가 말한다.
--   계약의 LotLifecycleHistoryEvent 에도 changedBy 가 없다.

CREATE TABLE trace.lot_lifecycle_history (
    lot_lifecycle_history_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    lot_id bigint NOT NULL REFERENCES trace.lot(lot_id),
    from_lifecycle_status_code app.code_t,
    to_lifecycle_status_code app.code_t NOT NULL,
    transition_code app.code_t NOT NULL,
    source_document_type_code app.code_t,
    source_document_id bigint,
    changed_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,

    -- 최초 전이(L1)는 이전 상태가 없어 from 이 비고, 그 밖에는 앞뒤가 달라야 한다.
    -- 같은 상태로의 전이는 이력이 아니다.
    CONSTRAINT ck_lot_lifecycle_history_transition
        CHECK (from_lifecycle_status_code IS NULL
               OR from_lifecycle_status_code <> to_lifecycle_status_code),

    -- 다형 참조는 짝이다 — 가리킬 문서가 없으면 둘을 함께 비운다(공유계약 A-10).
    -- 한쪽만 채우면 무엇을 가리키는지도, 어디를 가리키는지도 알 수 없는 행이 남는다.
    CONSTRAINT ck_lot_lifecycle_history_source
        CHECK ((source_document_type_code IS NULL) = (source_document_id IS NULL))
);

-- 값 집합은 CHECK 에 박지 않는다. L1~L3 도 대기·활성·폐번도 mdm.code_value 로 푼다 —
-- 직전 마이그레이션이 걷어낸 ck_lot_initial_qty 의 'PREISSUED' 가 그렇게 죽었다.

-- 조회 파라미터는 occurredFrom·occurredTo 가 «필수»이고 lotId 는 선택이다.
-- 그래서 인덱스가 둘이다 — 시각 구간은 모든 질의에 걸리고, LOT 지정은 걸릴 때만이다.
--
-- ⚠ 형제 표 lot_status_event 에는 (lot_id, changed_at DESC) 하나뿐이라 같은 계약의
--   필수 구간 질의를 받쳐 주지 못한다. 별건으로 볼 자리다.
CREATE INDEX ix_lot_lifecycle_history_changed_at
    ON trace.lot_lifecycle_history USING btree (changed_at DESC);
CREATE INDEX ix_lot_lifecycle_history_lot
    ON trace.lot_lifecycle_history USING btree (lot_id, changed_at DESC);

COMMENT ON TABLE trace.lot_lifecycle_history IS
    'LOT 생명주기 전이 이력(L1~L3). 품질 판정 축인 trace.lot_status_event 와 다른 축이며 한 이력에 섞지 않는다 — 계약 명시 사항이다. 근거: 이슈 #63 · DR-007.';

COMMENT ON COLUMN trace.lot_lifecycle_history.from_lifecycle_status_code IS
    '전이 전 생명주기 상태. 최초 전이(L1)는 비어 있다.';

COMMENT ON COLUMN trace.lot_lifecycle_history.transition_code IS
    'L1=대기→활성(첫 실적) · L2=대기→폐번(마감, 실적 없는 슬롯) · L3=활성→폐번(작업지시 취소, DR-007). L3 를 여는 것은 취소 오퍼레이션 한 곳뿐이며 사람이 직접 폐번하는 액션은 없다.';

COMMENT ON COLUMN trace.lot_lifecycle_history.source_document_type_code IS
    '이 전이를 일으킨 문서 유형 — 다형 참조(공유계약 A-10). source_document_id 와 짝이다. L2=work_order_closing · L3=work_order.';

COMMENT ON COLUMN trace.lot_lifecycle_history.changed_at IS
    '전이가 일어난 시각(업무 시각). created_at 은 행이 적재된 시각으로 별개다.';
