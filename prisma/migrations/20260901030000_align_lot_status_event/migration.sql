-- trace.lot_status_event 를 계약에 맞춘다 + trace.lot_hold 해제 사유 제약.
--
-- 요청: 설계 회신 2026-09-01 E-9(상태 이력 4건) · B-2(보류 해제)
-- 계약: logistics-01자재창고.json 의 LotStatusHistoryEvent ·
--       quality-03품질.json 의 LotHoldRelease
--
-- 이 표가 계약의 「LOT 상태 변경이력」이라는 것은 설계 회신이 확인해 주었다. 우리가
-- 이미 갖고 있던 표이고 별표를 세우지 않는다 — 네 자리만 맞추면 된다.

-- ── 1. transition_code 신설 ──────────────────────────────────────────────────
--
-- 계약이 required 로 두는 전이 코드다(C4~C15 9종 · 품질 도식스펙 정본). 지금은 이력에
-- 「무엇에서 무엇으로」만 있고 「어느 전이였나」가 없어, 같은 앞뒤 상태를 만드는 서로
-- 다른 전이(예: 재판정 합격 C7 과 전수 재검 양품 C15)를 구분하지 못한다.
--
-- NOT NULL 로 세운다. 값 없이 들어온 이력은 어느 전이인지 영영 알 수 없어 나중에
-- 채울 수 없다 — 기본값을 주어 「모르는 전이」를 만드는 것보다 넣는 쪽이 채우게 한다.
-- 이 표는 아직 비어 있어(배포 이력 없음) 기존 행 문제가 없다.

ALTER TABLE trace.lot_status_event
    ADD COLUMN transition_code app.code_t NOT NULL;

COMMENT ON COLUMN trace.lot_status_event.transition_code IS
    '어느 전이였나 — C4~C15(LOT_STATUS_TRANSITION). 앞뒤 상태만으로는 서로 다른 전이가 구분되지 않아 필요하다. 생명주기 축의 L1~L3 와 다른 축이며 그 이력은 trace.lot_lifecycle_history 가 담는다.';

-- ── 2. reason 자유문 신설 ────────────────────────────────────────────────────
--
-- reason_code 를 대체하지 않고 함께 둔다. 설계 회신이 「코드로 분류하고 자유문으로
-- 남긴다」로 정했다 — 코드는 세는 축이고 자유문은 사람이 읽는 자리다. 계약에는 지금
-- reason(자유문)만 있고 reasonCode 는 설계팀이 신설하기로 했다.

ALTER TABLE trace.lot_status_event
    ADD COLUMN reason text;

COMMENT ON COLUMN trace.lot_status_event.reason IS
    '전이 사유 자유문. reason_code 를 대체하지 않는다 — 코드는 세는 축이고 이 칸은 사람이 읽는 자리다.';

-- ── 3. changed_by 를 NOT NULL 로 올린다 ──────────────────────────────────────
--
-- 계약이 required 다. 품질 판정 축은 사람이 전이시키는 축이라 행위자가 반드시 있다 —
-- 생명주기 축(trace.lot_lifecycle_history)이 서버만 여는 것이라 행위자 칸을 두지 않은
-- 것과 대비된다. 두 축의 차이가 여기서도 드러난다.

ALTER TABLE trace.lot_status_event
    ALTER COLUMN changed_by SET NOT NULL;

-- ── 4. 원천 문서 두 칸을 완화하고 짝으로 묶는다 ──────────────────────────────
--
-- 계약이 둘 다 nullable 로 바꿨다. 가리킬 원천 문서가 없는 전이가 성립하기 때문이다.
--
-- 다만 「없음」을 값으로 두지 않는다 — 가리킬 대상이 없는 값을 다형 참조 판별자에
-- 섞지 않는다는 것이 공유계약 A-10 이고, 설계팀이 goods_receipt(E-2)에서 같은 판단을
-- 확정했다. 대신 둘을 짝으로 묶어 한쪽만 채운 행을 막는다 — 한쪽만 있으면 무엇을
-- 가리키는지도 어디를 가리키는지도 알 수 없다.

ALTER TABLE trace.lot_status_event
    ALTER COLUMN source_document_type_code DROP NOT NULL,
    ALTER COLUMN source_document_id DROP NOT NULL;

ALTER TABLE trace.lot_status_event
    ADD CONSTRAINT ck_lot_status_event_source
        CHECK ((source_document_type_code IS NULL) = (source_document_id IS NULL));

-- ── 5. 시각 구간 인덱스 ──────────────────────────────────────────────────────
--
-- GET /trace/lot-status-events 는 occurredFrom·occurredTo 를 «필수»로 받고 lotId 는
-- 선택이다. 그런데 이 표에는 (lot_id, changed_at DESC) 하나뿐이라 LOT 을 지정하지
-- 않은 질의 — 즉 필수 파라미터만 준 기본 질의 — 를 받쳐 줄 인덱스가 없다.
--
-- 직전 마이그레이션이 세운 형제 표 trace.lot_lifecycle_history 는 같은 계약·같은
-- 필수 파라미터를 쓰면서 이 인덱스를 갖는다. 이 표를 계약에 맞추는 판에 함께 맞춘다.

CREATE INDEX ix_lot_status_event_changed_at
    ON trace.lot_status_event USING btree (changed_at DESC);

-- ⚠ previous_status_code·new_status_code 는 계약의 fromStatusCode·toStatusCode 와
--   이름이 다르나 뜻이 같다. 대응 표기(x-source-column)가 없어 매핑이 우리 몫이고,
--   이름만 맞추려고 컬럼을 갈면 하위 호환상 두 릴리스로 나눠야 한다. 그만한 값이
--   없어 두고, 계약 쪽에 대응 표기를 달아 달라고 요청한다.

-- ── 5. trace.lot_hold — 해제된 행에는 사유가 있어야 한다 ─────────────────────
--
-- 설계 회신 B-2 가 「이번 재정리 유일의 파괴적 변경」으로 표시했던 자리다. 계약
-- LotHoldRelease 의 releaseReasonCode 가 required 가 됐는데, 그것은 «해제 요청 본문»의
-- 필수이지 컬럼 NOT NULL 이 아니다.
--
-- 컬럼을 NOT NULL 로 올리면 아직 해제되지 않은 보류 행이 전부 깨진다 — 해제 전에는
-- 사유가 없는 것이 정상이다. 조건부로 건다. 설계팀이 이 형태를 확인해 주었다.

ALTER TABLE trace.lot_hold
    ADD CONSTRAINT ck_lot_hold_release_reason
        CHECK (released_at IS NULL OR release_reason_code IS NOT NULL);

COMMENT ON COLUMN trace.lot_hold.release_reason_code IS
    '보류 해제 사유(LOT_HOLD_RELEASE_REASON). 해제 전에는 비어 있고 해제되면 반드시 있다 — ck_lot_hold_release_reason 이 그 짝을 지킨다.';
