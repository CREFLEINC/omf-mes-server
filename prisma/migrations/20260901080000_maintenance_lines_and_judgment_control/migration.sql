-- 설비보전 하위표 둘 + 판정유형 통제속성 별표.
--
-- 요청: 이슈 #44 하위 3표 중 둘 · #63 신규 테이블 · 설계 회신 B-4 · E-1
-- 계약: equipment-05설비툴.json 의 MaintenanceOrderItem·MaintenanceOrderItemInput·
--       MaintenanceOrderTrigger · mdm-기준정보.json 의 JudgmentTypeControl

-- ═══ 1. maintenance.maintenance_order_item — 보전지시 항목 라인 ══════════════
--
-- 기존 자유텍스트 itemNames 를 대체한다. 「불량 반출이 몇 건인가」를 세려면 자유
-- 텍스트가 아니라 행이어야 하는 것과 같은 이유다.
--
-- inspection_item_id 와 item_name 이 둘 다 nullable 이고 «적어도 하나»가 있어야 한다 —
-- 항목 마스터를 가리키는 경우와 자유 입력(툴 예방보전)이 갈린다. 계약이 「짝 제약은
-- 화면이 진다」고 두었으나 DB 에서도 막는다. 둘 다 빈 행은 어느 쪽으로도 읽히지
-- 않는다 — 화면이 지키지 못했을 때 남는 것은 뜻 없는 행이다.
--
-- ⚠ 「targetTypeCode=EQUIPMENT 이면 inspection_item_id 를 반드시 채운다」는 CHECK 로
--   걸지 않는다. 값에 따라 갈리는 규칙이고 targetTypeCode 는 이 표에 없다 — 서버가 건다.

CREATE TABLE maintenance.maintenance_order_item (
    maintenance_order_item_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    maintenance_order_id bigint NOT NULL REFERENCES maintenance.maintenance_order(maintenance_order_id),
    sequence_no integer NOT NULL,
    inspection_item_id bigint REFERENCES mdm.equipment_inspection_item(equipment_inspection_item_id),
    item_name app.name_t,
    status_code app.code_t NOT NULL,

    CONSTRAINT ck_maintenance_order_item_target
        CHECK (inspection_item_id IS NOT NULL OR item_name IS NOT NULL),
    CONSTRAINT ck_maintenance_order_item_seq CHECK (sequence_no > 0),
    CONSTRAINT uq_maintenance_order_item_seq UNIQUE (maintenance_order_id, sequence_no)
);

CREATE INDEX ix_maintenance_order_item_order
    ON maintenance.maintenance_order_item USING btree (maintenance_order_id, sequence_no);
CREATE INDEX ix_maintenance_order_item_inspection
    ON maintenance.maintenance_order_item USING btree (inspection_item_id);

COMMENT ON TABLE maintenance.maintenance_order_item IS
    '보전지시 항목 라인. 기존 자유텍스트 itemNames 를 대체한다 — 항목을 세거나 상태를 항목별로 갖게 하려면 행이어야 한다. 근거: 이슈 #44 · #63.';

COMMENT ON COLUMN maintenance.maintenance_order_item.item_name IS
    '항목 마스터가 없을 때의 자유 입력(툴 예방보전이 이쪽이다). inspection_item_id 와 둘 중 적어도 하나는 있어야 한다.';

-- ═══ 2. maintenance.maintenance_order_trigger — 발행 트리거 ══════════════════
--
-- 무엇이 이 보전지시를 발행시켰나. 스냅샷 넷을 함께 담는다(#63 은 셋이라 했으나
-- 계약은 snapshot_note 를 더해 넷이다 — 설계가 회신 B-4 에서 정정을 인정했다).
--
-- source_id 가 nullable 인 이유가 계약에 있다 — trigger_type_code=PM_DUE 이면 가리킬
-- 행이 없다. 주기 도래는 저장된 사건이 아니라 파생 조건이다. 나머지 두 유형(고장·
-- 점검 불합격)에서는 가리킬 기록이 있다.
--
-- ⚠ 「PM_DUE 이면 source_id 를 비운다」를 CHECK 로 걸지 않는다. 값 집합을 제약에
--   박으면 조용히 죽는다 — 20260901010000 이 걷어낸 'PREISSUED' 가 그랬다.
--
-- 스냅샷을 얼려 두는 이유도 계약이 적었다 — 누계 타발수는 뒤에 리셋되므로 발행
-- 시점의 값을 남기지 않으면 「왜 그때 발행했나」를 되짚을 수 없다.

CREATE TABLE maintenance.maintenance_order_trigger (
    maintenance_order_trigger_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    maintenance_order_id bigint NOT NULL REFERENCES maintenance.maintenance_order(maintenance_order_id),
    trigger_type_code app.code_t NOT NULL,
    source_id bigint,
    snapshot_note text,
    pm_due_axis_code app.code_t,
    shot_count_at_due integer,
    guaranteed_shot_count_at_due integer,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,

    CONSTRAINT uq_maintenance_order_trigger UNIQUE (maintenance_order_id),
    CONSTRAINT ck_maintenance_order_trigger_shots
        CHECK ((shot_count_at_due IS NULL OR shot_count_at_due >= 0)
               AND (guaranteed_shot_count_at_due IS NULL OR guaranteed_shot_count_at_due >= 0))
);

COMMENT ON TABLE maintenance.maintenance_order_trigger IS
    '보전지시를 발행시킨 트리거와 발행 시점 스냅샷. 보전지시 하나에 하나다. 근거: 이슈 #44 · #63 · 설계 회신 B-4.';

COMMENT ON COLUMN maintenance.maintenance_order_trigger.source_id IS
    '트리거가 가리키는 기록. trigger_type_code=PM_DUE 이면 비어 있다 — 주기 도래는 저장된 사건이 아니라 파생 조건이라 가리킬 행이 없다. 고장·점검 불합격에서는 채운다.';

COMMENT ON COLUMN maintenance.maintenance_order_trigger.shot_count_at_due IS
    '발행 시점의 누계 타발수 스냅샷. 누계는 뒤에 리셋되므로 얼려 두지 않으면 왜 그때 발행했는지 되짚을 수 없다.';

-- ═══ 3. mdm.judgment_type_control — 판정유형 통제속성 ════════════════════════
--
-- 요청: 이슈 #42 §I-11 · 설계 회신 E-1
--
-- 별표로 뺀다. 통제 속성은 판정유형 코드값에만 붙는데 mdm.code_value 에 컬럼으로
-- 달면 다른 코드값 «전부»에 NULL 일곱 칸이 생긴다. 코드값은 지금 53그룹이고 앞으로
-- 더 는다.
--
-- 1:1 이다 — 한 코드값에 통제 속성이 둘일 수 없다. PK 를 code_value_id 로 두어
-- 구조가 그것을 말하게 한다.
--
-- ⛔ 이 그룹은 G-31 마스터안전형이 «아니다». blocks_* 셋이 출고·출하·피킹을 막고
--    requires_approval 이 결재를 태운다 — 고객이 값을 바꾸면 출하가 막히거나 뚫린다.
--    JUDGMENT_TYPE 그룹은 시드에서 is_system_owned 로 잠가 두었다.

CREATE TABLE mdm.judgment_type_control (
    code_value_id bigint PRIMARY KEY REFERENCES mdm.code_value(code_value_id),
    blocks_issue boolean NOT NULL DEFAULT false,
    blocks_shipment boolean NOT NULL DEFAULT false,
    blocks_picking boolean NOT NULL DEFAULT false,
    requires_approval boolean NOT NULL DEFAULT false,
    approver_role_id bigint REFERENCES app.role(role_id),
    lot_status_code app.code_t,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,

    CONSTRAINT judgment_type_control_version_no_check CHECK (version_no > 0),
    -- 승인 권한은 승인이 필요할 때만 뜻이 있다(계약이 명시). 승인이 필요 없는데
    -- 권한만 지정된 행은 무엇을 뜻하는지 정해지지 않는다.
    CONSTRAINT ck_judgment_type_control_approver
        CHECK (requires_approval OR approver_role_id IS NULL)
);

CREATE INDEX ix_judgment_type_control_role
    ON mdm.judgment_type_control USING btree (approver_role_id);

COMMENT ON TABLE mdm.judgment_type_control IS
    '판정유형(JUDGMENT_TYPE 코드값)의 통제 속성. 코드값과 1:1 이며 PK 가 code_value_id 다. 값이 출고·출하·피킹을 막고 결재를 태우므로 G-31 마스터안전형이 아니다 — 그룹을 시스템 소유로 잠갔다. 근거: 이슈 #42 §I-11 · 설계 회신 E-1.';

COMMENT ON COLUMN mdm.judgment_type_control.lot_status_code IS
    '이 판정유형이 LOT 을 어느 품질 판정으로 전이시키는가(LOT_STATUS).';
