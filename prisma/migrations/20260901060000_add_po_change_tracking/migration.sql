-- P/O 변경 「마지막 한 건」 저장 자리 + 작업지시 어긋남 표식.
--
-- 요청: 이슈 #73 (1번·3번) · 계약 de4203a
-- 계약: production-02생산실행.json 의 ProductionOrder.lastChange ·
--       ProductionOrderChange · ProductionOrderChangedField · WorkOrder.poMismatch
--
-- ── 왜 저장해야 하나 ────────────────────────────────────────────────────────
--
-- ERP 가 P/O 를 바꿔 보내면 MES 는 planning.production_order 행에 «덮어쓴다». 그래서
-- 화면이 열릴 때 order_qty 는 이미 변경 «후» 값이고 변경 «전» 값이 어디에도 없다.
-- 관리자 확인 화면(W-02-06)은 「무엇이 몇에서 몇으로 바뀌었는가」를 보이고 「반영 /
-- 강행」을 판정하게 하는 화면인데, 지금 구조로는 「이 P/O 가 바뀌었다」까지만 말할 수
-- 있다. 서버는 덮어쓰기 «직전»에 양쪽을 다 쥐고 있으므로 그 순간 한 건을 남기면 된다.
--
-- 전건 이력이 아니라 P/O 당 마지막 한 건이다(설계 확정 2026-09-01). 판정 중 ERP 가
-- 다시 보내면 409 로 막고 다시 불러와 새 변경분으로 판정하므로 지나간 변경은 판정
-- 대상이 아니다.

-- ── 1. 수신 시각 — 헤더를 표로 두지 않는다 ──────────────────────────────────
--
-- 「마지막 한 건」이 확정이라 P/O 와 1:1 이다. 부속 표로 빼면 UNIQUE(production_order_id)
-- 로 1:1 을 «강제»해야 하는데, 컬럼이면 구조가 그것을 말한다. 설계가 형태를 물리 모델
-- 소관으로 맡겼다.
--
-- 비어 있으면 「ERP 가 바꿔 보낸 적이 없다」이고, 계약의 lastChange 가 null 인 경우다.

ALTER TABLE planning.production_order
    ADD COLUMN last_change_received_at timestamp with time zone;

COMMENT ON COLUMN planning.production_order.last_change_received_at IS
    'ERP 가 보낸 마지막 변경을 수신한 시각. 비어 있으면 바뀐 적이 없다. GET /planning/production-orders 의 unacknowledgedOnly 가 확인 시각과 견주는 값이 이것이다. 근거: 이슈 #73.';

-- ── 2. 바뀐 항목별 「변경 전」 값 ────────────────────────────────────────────
--
-- 한 번의 변경에 항목이 여럿 올 수 있어(수량과 납기가 함께) 항목 단위로 행을 둔다.
-- 값 타입은 가리키는 컬럼과 같은 도메인을 쓴다 — 표시 문자열로 굳히면 나중에 계산에
-- 쓸 수 없다.
--
-- ⛔ 「변경 후」 값을 두지 않는다. P/O 행에 이미 반영돼 있어 같은 값이 두 자리에
--    생긴다(계약이 명시 · 공유계약 L-2-1). label·beforeText 도 두지 않는다 — 계약이
--    표시명과 표시 문자열을 서버가 내려 준다고 정했고, 화면은 대응표를 갖지 않는다.

CREATE TABLE planning.production_order_change_field (
    production_order_change_field_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    production_order_id bigint NOT NULL REFERENCES planning.production_order(production_order_id),
    field_code app.code_t NOT NULL,
    before_order_qty app.qty_t,
    before_due_date date,
    before_status_code app.code_t,

    -- 한 행은 한 항목의 값만 담는다. 「정확히 하나」가 아니라 「많아야 하나」인 것은
    -- 변경 «전» 값이 정당하게 비어 있을 수 있어서다 — due_date 는 nullable 이라
    -- 「납기가 없다가 생겼다」가 성립한다. 그때 세 칸이 모두 빈 행이 맞다.
    --
    -- field_code 값을 CHECK 에 적지 않는 것은 값 집합을 제약에 박으면 조용히 죽기
    -- 때문이다(20260901010000 이 걷어낸 'PREISSUED' 가 그랬다).
    CONSTRAINT ck_po_change_field_single_value
        CHECK (num_nonnulls(before_order_qty, before_due_date, before_status_code) <= 1),

    -- 한 변경에 같은 항목이 두 번 오지 않는다.
    CONSTRAINT uq_po_change_field UNIQUE (production_order_id, field_code)
);

COMMENT ON TABLE planning.production_order_change_field IS
    'ERP 가 보낸 마지막 P/O 변경에서 바뀐 항목별 「변경 전」 값. 수신 시각은 planning.production_order.last_change_received_at 이 갖는다. 행이 없으면 열거한 세 항목(수량·납기·상태) 밖이 바뀐 것이다 — 계약이 빈 배열을 허용한다. 근거: 이슈 #73.';

COMMENT ON COLUMN planning.production_order_change_field.field_code IS
    '바뀐 항목 — ORDER_QTY · DUE_DATE · STATUS_CODE. 계약 enum 이 정본이라 코드값 그룹을 두지 않는다.';

-- ── 3. work_order.po_mismatch ───────────────────────────────────────────────
--
-- ⚠ 이슈 #73 의 3번이 「컬럼은 그대로이고 값이 서는 조건만 늘어난다」고 적었으나 물리에
--   이 컬럼이 «없다». 신설한다.
--
-- 파생이 아니라 저장이다. 계약이 서버가 두 자리에서 «세운다»고 하는데, 그중 ⓑ「반영을
-- 골랐는데 그 W/O 를 조정하지 않았을 때」는 «조정하지 않았다»는 사실이 어디에도 남지
-- 않아 나중에 되짚을 수 없다.
--
-- DEFAULT false — 어긋남은 판정 순간에 서는 표식이고, 기본은 어긋나지 않은 상태다.

ALTER TABLE production.work_order
    ADD COLUMN po_mismatch boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN production.work_order.po_mismatch IS
    'P/O 와 어긋난 채 남은 작업지시인가. 서버가 두 자리에서 세운다 — 관리자가 「기존 유지(강행)」를 고를 때, 그리고 「변경 반영」을 골랐는데 그 작업지시를 조정하지 않았을 때. 뒤엣것을 더한 것은 표식 없이 남는 쪽이 더 위험해서다. 화면이 스스로 계산하지 않는다. 근거: W-02-06 §5-2·§6 · 이슈 #73.';
