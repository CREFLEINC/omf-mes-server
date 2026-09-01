-- mdm.terminal 두 칸 · production_order_acknowledgement 확인 판정 세 칸.
--
-- 요청: 우리 이슈 #58(tokenIssuedAt) · #60(단말↔설비) · 설계 회신 E-10 · A-2
-- 계약: mdm-기준정보.json 의 Terminal · production-02생산실행.json 의
--       ProductionOrder · ProductionOrderAcknowledge

-- ═══ 1. mdm.terminal ═════════════════════════════════════════════════════════
--
-- 계약이 Terminal.equipmentId 에 x-source-column: equipment_id 를 달아 두었고
-- TerminalCreate·TerminalUpdate 양쪽에 있어 쓰기로도 받는다. 설계가 omf-mes#262 를
-- 종결하며 「계약이 앞서 있고 통지했다 — 기다리지 않는다」로 넘긴 자리다.
--
-- nullable 이다. 계약이 ["integer","null"] 이고 required 도 아니다 — 설비에 붙지
-- 않은 단말이 있다.
--
-- tokenIssuedAt 은 대응 표기가 없어 컬럼명이 우리 몫이다. required 가 아니므로
-- nullable 로 둔다 — 토큰을 한 번도 발급하지 않은 단말은 발급 시각이 없다.
-- token_version 과 짝 제약을 걸지 않는 것은 그 컬럼이 DEFAULT 1 로 시작해
-- 「발급 전」과 「1회 발급」이 값으로 구분되지 않기 때문이다.

ALTER TABLE mdm.terminal
    ADD COLUMN equipment_id bigint REFERENCES mdm.equipment(equipment_id),
    ADD COLUMN token_issued_at timestamp with time zone;

-- 이 표는 FK 에 인덱스를 다는 쪽이다(ix_terminal_location). 관례를 따른다.
CREATE INDEX ix_terminal_equipment ON mdm.terminal USING btree (equipment_id);

COMMENT ON COLUMN mdm.terminal.equipment_id IS
    '단말이 결속된 설비. 비어 있을 수 있다 — 설비에 붙지 않은 단말이 있다. 근거: omf-mes#262 · 우리 이슈 #60.';

COMMENT ON COLUMN mdm.terminal.token_issued_at IS
    '토큰을 마지막으로 발급한 시각. 한 번도 발급하지 않았으면 비어 있다. token_version 은 DEFAULT 1 로 시작해 발급 여부를 값으로 가르지 못하므로 이 칸이 필요하다. 근거: 우리 이슈 #58.';

-- ═══ 2. production.production_order_acknowledgement ══════════════════════════
--
-- 이 표를 존치하고 컬럼으로 평탄화하지 않는다 — 설계 회신 A-2 가 그쪽 판단으로
-- 맡겼고, 계약이 acknowledgedBy 를 「«마지막으로» 확인한 사용자」,
-- acknowledgeDecisionCode 를 「«마지막 확인»의 판정」이라 적어 복수를 전제한다.
-- 컬럼으로 내리면 마지막 확인만 남는다.
--
-- 표가 이미 ERP 수신 축을 담고 있다(upstream_version·received_at·
-- integration_message_id). 계약의 :acknowledge 가 「관리자가 ERP 변경을 반영할지
-- 강행할지 판정한다」이므로 같은 축의 뒷단이고, 그 판정을 담을 칸이 없었다.
--
-- 세 칸을 더한다. 기존 status_code·acknowledgement_type_code 와 다른 축이다 —
-- 저 둘은 각각 행의 진행 상태와 ERP 변경의 종류이고, 이건 사람의 판정이다.

ALTER TABLE production.production_order_acknowledgement
    ADD COLUMN acknowledged_by bigint REFERENCES app.app_user(app_user_id),
    ADD COLUMN acknowledge_decision_code app.code_t,
    ADD COLUMN reason text;

-- 확인 전이면 셋 다 비고, 확인했으면 판정과 사람이 함께 있어야 한다. 계약이
-- 「acknowledgedAt 이 비어 있으면 미확인」이라 두었고 목록 필터
-- (unacknowledgedOnly)가 그 값으로 판정하므로, 시각만 있고 판정이 없는 행은
-- 목록에서 확인된 것으로 세어지면서 무엇으로 확인했는지는 알 수 없게 된다.
ALTER TABLE production.production_order_acknowledgement
    ADD CONSTRAINT ck_production_order_ack_decision
        CHECK (
            (acknowledged_at IS NULL AND acknowledge_decision_code IS NULL AND acknowledged_by IS NULL)
            OR (acknowledged_at IS NOT NULL AND acknowledge_decision_code IS NOT NULL AND acknowledged_by IS NOT NULL)
        );

CREATE INDEX ix_production_order_ack_user
    ON production.production_order_acknowledgement USING btree (acknowledged_by);

COMMENT ON COLUMN production.production_order_acknowledgement.acknowledge_decision_code IS
    '관리자의 확인 판정 — 반영 / 강행. 행의 진행 상태(status_code)나 ERP 변경의 종류(acknowledgement_type_code)와 다른 축이다.';

COMMENT ON COLUMN production.production_order_acknowledgement.reason IS
    '판정 사유 자유문. 강행이면 필요하다 — 값에 따라 갈리는 규칙이라 CHECK 가 아니라 서버가 건다.';
