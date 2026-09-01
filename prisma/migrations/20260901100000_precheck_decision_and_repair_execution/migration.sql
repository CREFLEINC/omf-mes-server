-- production.precheck_decision · production.repair_execution 신설.
--
-- 계약: production-02생산실행.json 의 PrecheckDecision · RepairExecution
--       (둘 다 x-source-table 로 표 이름을, 필드마다 x-source-column 으로 컬럼 이름을
--        확정해 두었다 — 이름을 우리가 정할 것이 없다)
--
-- 산출물의 마지막 결손 둘이다. 계약이 「이 표에서 온다」고 선언했는데 물리에 없어
-- 매핑이 비어 있었다(#65 부터 남아 있던 자리). 이 둘을 세우면 결손 0 이 된다.

-- ═══ 1. production.precheck_decision — 작업 전 점검 판정 ═════════════════════
--
-- 작업지시를 설비에 걸기 전에 점검 상태를 보고 통과·차단·경고·우회를 판정한 기록이다.
--
-- control_level_code 가 스냅샷인 것이 이 표의 요점이다. 계약이 적었다 — 「판정 시점에
-- 적용된 통제 수준의 스냅샷. app.operation_policy 의 PRECHECK_CONTROL_LEVEL 을 읽은
-- 값이다 — 정책이 나중에 바뀌어도 이 기록은 바뀌지 않는다」. 정책을 조인해 지금 값을
-- 읽으면 과거 판정의 근거가 사라진다.
--
-- decided_at 도 서버 시각이 아니다 — 단말 시계가 정하고 서버가 덮지 않는다(C-12).
--
-- basis_inspection_id 는 비어도 된다. 점검 이력이 없는 채로 판정하는 경우가 있다.
-- override_reason_code 는 decision_code=OVERRIDDEN 일 때만 값이 있는데, 값에 따라
-- 갈리는 규칙이라 CHECK 로 걸지 않고 서버가 건다 — 값 집합을 제약에 박으면 조용히
-- 죽는다(20260901010000 이 걷어낸 'PREISSUED').
--
-- worker_no 가 FK 가 아니라 문자열인 것은 현장 작업자가 계정을 갖지 않기 때문이다 —
-- 쓰기 요청의 X-Worker-No 를 서버가 옮겨 적는다. notice_acknowledgement 와 같은 판단이다.

CREATE TABLE production.precheck_decision (
    precheck_decision_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    work_order_id bigint NOT NULL REFERENCES production.work_order(work_order_id),
    equipment_id bigint NOT NULL REFERENCES mdm.equipment(equipment_id),
    decided_at timestamp with time zone NOT NULL,
    control_level_code app.code_t NOT NULL,
    decision_code app.code_t NOT NULL,
    basis_inspection_id bigint REFERENCES maintenance.equipment_inspection(equipment_inspection_id),
    override_reason_code app.code_t,
    worker_no app.business_no_t,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint REFERENCES app.app_user(app_user_id)
);

CREATE INDEX ix_precheck_decision_work_order
    ON production.precheck_decision USING btree (work_order_id, decided_at DESC);
CREATE INDEX ix_precheck_decision_equipment
    ON production.precheck_decision USING btree (equipment_id, decided_at DESC);

COMMENT ON TABLE production.precheck_decision IS
    '작업 전 점검 판정. 작업지시를 설비에 걸기 전 점검 상태를 보고 통과·차단·경고·우회를 정한 기록이다. 근거: P-02-02 §5-8.';

COMMENT ON COLUMN production.precheck_decision.control_level_code IS
    '판정 시점에 적용된 통제 수준의 스냅샷. app.operation_policy 의 PRECHECK_CONTROL_LEVEL 을 읽은 값이며, 정책이 나중에 바뀌어도 이 기록은 바뀌지 않는다 — 조인해 지금 값을 읽으면 과거 판정의 근거가 사라진다.';

COMMENT ON COLUMN production.precheck_decision.decided_at IS
    '단말 시계가 정한다. 서버 수신 시각으로 덮지 않는다(공유계약 C-12).';

COMMENT ON COLUMN production.precheck_decision.worker_no IS
    '판정 시점의 귀속 사번. FK 가 아니라 문자열인 것은 현장 작업자가 계정을 갖지 않기 때문이다 — 쓰기 요청의 X-Worker-No 를 서버가 옮겨 적는다.';

-- ═══ 2. production.repair_execution — 수리 투입·반출 ═════════════════════════
--
-- 불량을 수리에 넣고 빼는 기록이다. 계약이 「원 불량은 기록 전용 테이블이라 이쪽을
-- 갱신하지 않고 여기에 쌓는다」로 적었다 — defect_record 를 고치지 않는다.
--
-- returned_at 이 판정 축이다. 계약이 「비어 있으면 아직 수리 중이다 — 이것이 「투입
-- 대기 목록」의 판정 축이다」로 적었다. 상태 컬럼을 따로 두지 않는 이유이며,
-- trace.lot.completed_at 을 시각으로 둔 것과 같은 형태다.
--
-- repair_result_code 는 반출할 때 정해진다 — 투입 시점에는 비어 있다. returned_at 과
-- 짝으로 묶는다. 반출했는데 결과가 없거나 결과만 있고 반출 시각이 없는 행은 어느
-- 쪽으로도 읽히지 않는다.
--
-- ⚠ reintroduced_lot_id 는 지금 채워지지 않는다. 계약이 밝혀 두었다 — 이 값을 실을
--   쓰기가 계약에 없고(:return 본문은 둘뿐, PUT·PATCH 없음) 재투입 등록을 어느 화면이
--   하는지가 정해지지 않았다. 컬럼은 세운다 — 계약이 응답에 싣고 대응 표기까지 달아
--   두었으므로 자리가 확정된 것이고, 나중에 경로가 서면 채워진다.

CREATE TABLE production.repair_execution (
    repair_execution_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    defect_record_id bigint NOT NULL REFERENCES quality.defect_record(defect_record_id),
    repair_process_id bigint REFERENCES mdm.process(process_id),
    started_at timestamp with time zone NOT NULL,
    returned_at timestamp with time zone,
    repair_qty app.qty_t NOT NULL,
    uom_id bigint NOT NULL REFERENCES mdm.uom(uom_id),
    repair_result_code app.code_t,
    reintroduced_lot_id bigint REFERENCES trace.lot(lot_id),
    terminal_id bigint REFERENCES mdm.terminal(terminal_id),
    worker_no app.business_no_t,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint REFERENCES app.app_user(app_user_id),

    CONSTRAINT ck_repair_execution_qty CHECK (repair_qty > 0),
    -- 반출 시각과 결과는 짝이다. 반출했는데 결과가 없거나 결과만 있고 반출이 없는
    -- 행은 「수리 중」인지 「끝났는지」를 말하지 못한다.
    CONSTRAINT ck_repair_execution_return
        CHECK ((returned_at IS NULL) = (repair_result_code IS NULL)),
    CONSTRAINT ck_repair_execution_period
        CHECK (returned_at IS NULL OR returned_at >= started_at)
);

CREATE INDEX ix_repair_execution_defect
    ON production.repair_execution USING btree (defect_record_id, started_at DESC);
-- 「투입 대기 목록」이 반출되지 않은 것만 본다 — 부분 인덱스로 받친다.
CREATE INDEX ix_repair_execution_open
    ON production.repair_execution USING btree (started_at DESC) WHERE returned_at IS NULL;

COMMENT ON TABLE production.repair_execution IS
    '수리 투입·반출 기록. 원 불량(quality.defect_record)은 기록 전용이라 갱신하지 않고 여기에 쌓는다. 근거: M-02-02 §5-4.';

COMMENT ON COLUMN production.repair_execution.returned_at IS
    '반출 시각. 비어 있으면 아직 수리 중이다 — 「투입 대기 목록」의 판정 축이며 상태 컬럼을 따로 두지 않는 이유다.';

COMMENT ON COLUMN production.repair_execution.reintroduced_lot_id IS
    '수리분이 합류한 생산LOT. 원 LOT 이 아니다. ⚠ 지금은 채워지지 않는다 — 이 값을 실을 쓰기가 계약에 없고 재투입 등록을 어느 화면이 하는지가 정해지지 않았다. 경로가 서면 채워진다.';
