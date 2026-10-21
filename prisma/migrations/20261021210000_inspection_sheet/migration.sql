-- OA 제품 검사표 — 종이 성적서(B-05-101 · OP·PP향 제품검사표 공검및출하)를 시리얼 1대에 1장으로 옮긴다
-- (omf-all-around#89 · 장부 P-102). 부품 공정검사와 작업지시 단위 PQC(inspection_request·result)는 건드리지 않는다.
-- ⚠ 검사표 기준을 inspection_plan 에 두지 않은 이유 — OA 품목에 PQC 기준이 서면 W/O 발행 때 PQC 의뢰가 자동으로 선다.

-- 검사표 기준 — 모델(품목)마다 확정본은 하나다. 확정된 기준은 고치지 않고 새 판을 만든다(검사표가 기준 줄을 가리킨다).
CREATE TABLE quality.inspection_sheet_template (
    inspection_sheet_template_id bigserial PRIMARY KEY,
    item_id                      bigint       NOT NULL REFERENCES mdm.item(item_id),
    template_version             integer      NOT NULL CHECK (template_version > 0),
    -- 기준을 고칠 수 있는 사업부 — 로그인 계정의 데이터 범위(user_data_scope)와 비교한다.
    business_unit_id             bigint       NOT NULL REFERENCES mdm.business_unit(business_unit_id),
    -- 출력 배치는 코드가 그린다(양식 둘) — 공통코드가 아니라 CHECK 로 닫는다.
    form_layout_code             varchar(20)  NOT NULL CHECK (form_layout_code IN ('OP', 'PP')),
    status_code                  varchar(20)  NOT NULL DEFAULT 'DRAFT' CHECK (status_code IN ('DRAFT', 'CONFIRMED', 'OBSOLETE')),
    -- 머리 고정 문구 — 검사표를 만들 때 복사되고, 검사표에서 고칠 수 있다.
    material_text                varchar(500),
    structure_text               varchar(500),
    rohs_flag                    boolean      NOT NULL DEFAULT false,
    product_name_text            varchar(200), -- PP 양식만: 제품명
    power_text                   varchar(200), -- PP 양식만: 전압·주파수
    motor_text                   varchar(200), -- PP 양식만: 전동기 수량
    remarks                      varchar(500),
    confirmed_by                 bigint REFERENCES app.app_user(app_user_id),
    confirmed_at                 timestamptz,
    created_at                   timestamptz  NOT NULL DEFAULT clock_timestamp(),
    created_by                   bigint REFERENCES app.app_user(app_user_id),
    updated_at                   timestamptz  NOT NULL DEFAULT clock_timestamp(),
    updated_by                   bigint REFERENCES app.app_user(app_user_id),
    version_no                   integer      NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT ck_inspection_sheet_template_confirmed
        CHECK (status_code = 'DRAFT' OR (confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL))
);

CREATE UNIQUE INDEX uq_inspection_sheet_template_item_version ON quality.inspection_sheet_template (item_id, template_version);
CREATE UNIQUE INDEX uq_inspection_sheet_template_item_confirmed
    ON quality.inspection_sheet_template (item_id) WHERE status_code = 'CONFIRMED';

-- 머리 LOT 칸(PCB 기판·SD·스테이플)의 후보가 될 자재 품목 — 그 W/O 투입 기록에서 이 품목의 LOT 를 고른다.
CREATE TABLE quality.inspection_sheet_template_lot_source (
    inspection_sheet_template_lot_source_id bigserial PRIMARY KEY,
    inspection_sheet_template_id            bigint      NOT NULL REFERENCES quality.inspection_sheet_template(inspection_sheet_template_id),
    slot_code                               varchar(20) NOT NULL CHECK (slot_code IN ('PCB', 'SD', 'STAPLE')),
    item_id                                 bigint      NOT NULL REFERENCES mdm.item(item_id)
);

CREATE UNIQUE INDEX uq_inspection_sheet_template_lot_source
    ON quality.inspection_sheet_template_lot_source (inspection_sheet_template_id, slot_code, item_id);

-- 검사 단계 — 공정검사1~5·출하검사·교차 확인·발취 검사. 양식마다 쓰는 단계가 다르다(OP 1~5 · PP 1~3·발취).
CREATE TABLE quality.inspection_sheet_template_step (
    inspection_sheet_template_step_id bigserial PRIMARY KEY,
    inspection_sheet_template_id      bigint       NOT NULL REFERENCES quality.inspection_sheet_template(inspection_sheet_template_id),
    step_code                         varchar(30)  NOT NULL,
    sequence_no                       integer      NOT NULL CHECK (sequence_no > 0),
    name_ko                           varchar(100) NOT NULL,
    name_vi                           varchar(100),
    sign_required                     boolean      NOT NULL DEFAULT false
);

CREATE UNIQUE INDEX uq_inspection_sheet_template_step_code ON quality.inspection_sheet_template_step (inspection_sheet_template_id, step_code);
CREATE UNIQUE INDEX uq_inspection_sheet_template_step_seq ON quality.inspection_sheet_template_step (inspection_sheet_template_id, sequence_no);

-- 단계별 검사 항목 — 양식의 「항목 번호」(S 403 등)와 이름, 전수/발취.
CREATE TABLE quality.inspection_sheet_template_item (
    inspection_sheet_template_item_id bigserial PRIMARY KEY,
    inspection_sheet_template_step_id bigint       NOT NULL REFERENCES quality.inspection_sheet_template_step(inspection_sheet_template_step_id),
    sequence_no                       integer      NOT NULL CHECK (sequence_no > 0),
    check_item_code                   varchar(30)  NOT NULL,
    name_ko                           varchar(200) NOT NULL,
    name_vi                           varchar(200),
    method_code                       varchar(20)  NOT NULL CHECK (method_code IN ('FULL', 'SAMPLE'))
);

CREATE UNIQUE INDEX uq_inspection_sheet_template_item_seq ON quality.inspection_sheet_template_item (inspection_sheet_template_step_id, sequence_no);

-- 검사표 — 시리얼 1대에 1장. 머리 값은 만들 때 자동으로 채우고 사람이 고친다(담당자 결정 ①).
CREATE TABLE quality.inspection_sheet (
    inspection_sheet_id          bigserial PRIMARY KEY,
    serial_number_id             bigint       NOT NULL REFERENCES trace.serial_number(serial_number_id),
    inspection_sheet_template_id bigint       NOT NULL REFERENCES quality.inspection_sheet_template(inspection_sheet_template_id),
    item_id                      bigint       NOT NULL REFERENCES mdm.item(item_id),
    lot_id                       bigint       NOT NULL REFERENCES trace.lot(lot_id),
    work_order_id                bigint REFERENCES production.work_order(work_order_id),
    model_text                   varchar(200),
    spec_text                    varchar(200),
    destination_text             varchar(200),
    pcb_lot_no                   varchar(100),
    sd_lot_no                    varchar(100),
    staple_lot_no                varchar(100),
    fw_production_version        varchar(50),
    fw_quality_version           varchar(50),
    material_text                varchar(500),
    structure_text               varchar(500),
    rohs_flag                    boolean      NOT NULL DEFAULT false,
    product_name_text            varchar(200),
    power_text                   varchar(200),
    motor_text                   varchar(200),
    temp_pack_note               varchar(500), -- 가포장(오포장) 상황 기록
    overall_result_code          varchar(10) CHECK (overall_result_code IN ('OK', 'NG')),
    status_code                  varchar(20)  NOT NULL DEFAULT 'IN_PROGRESS' CHECK (status_code IN ('IN_PROGRESS', 'COMPLETED')),
    -- 양식의 「작성자」 — POP 은 단말 사번의 작업자다(계정이 없다).
    written_worker_id            bigint REFERENCES mdm.worker(worker_id),
    approved_by                  bigint REFERENCES app.app_user(app_user_id), -- 양식 「승인」
    approved_at                  timestamptz,
    checked_by                   bigint REFERENCES app.app_user(app_user_id), -- 양식 「확인」
    checked_at                   timestamptz,
    created_at                   timestamptz  NOT NULL DEFAULT clock_timestamp(),
    created_by                   bigint REFERENCES app.app_user(app_user_id),
    updated_at                   timestamptz  NOT NULL DEFAULT clock_timestamp(),
    updated_by                   bigint REFERENCES app.app_user(app_user_id),
    version_no                   integer      NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT ck_inspection_sheet_completed
        CHECK (status_code = 'IN_PROGRESS' OR (approved_by IS NOT NULL AND checked_by IS NOT NULL))
);

CREATE UNIQUE INDEX uq_inspection_sheet_serial ON quality.inspection_sheet (serial_number_id);
CREATE INDEX ix_inspection_sheet_lot ON quality.inspection_sheet (lot_id);
CREATE INDEX ix_inspection_sheet_work_order ON quality.inspection_sheet (work_order_id);

-- 단계 판정 — 한 단계에 한 줄. 「출하검사」 줄은 시리얼 OQC(omf-all-around#68)가 같은 서비스로 쓴다.
CREATE TABLE quality.inspection_sheet_step_result (
    inspection_sheet_step_result_id bigserial PRIMARY KEY,
    inspection_sheet_id             bigint      NOT NULL REFERENCES quality.inspection_sheet(inspection_sheet_id),
    step_code                       varchar(30) NOT NULL,
    first_judgment_code             varchar(10) NOT NULL CHECK (first_judgment_code IN ('OK', 'NG')),
    -- NG → 수리 → 재검 OK 이면 여기만 OK 로 바뀐다(양식 「□ NG → □ OK」).
    final_judgment_code             varchar(10) NOT NULL CHECK (final_judgment_code IN ('OK', 'NG')),
    source_code                     varchar(20) NOT NULL CHECK (source_code IN ('SHEET', 'OQC')),
    inspected_worker_id             bigint REFERENCES mdm.worker(worker_id),
    inspected_at                    timestamptz NOT NULL,
    inspection_result_id            bigint REFERENCES quality.inspection_result(inspection_result_id),
    signed_by                       bigint REFERENCES app.app_user(app_user_id),
    signed_at                       timestamptz,
    created_at                      timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by                      bigint REFERENCES app.app_user(app_user_id),
    updated_at                      timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by                      bigint REFERENCES app.app_user(app_user_id),
    version_no                      integer     NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT ck_inspection_sheet_step_result_first_ok
        CHECK (first_judgment_code = 'NG' OR final_judgment_code = 'OK'),
    CONSTRAINT ck_inspection_sheet_step_result_signed
        CHECK ((signed_by IS NULL) = (signed_at IS NULL))
);

CREATE UNIQUE INDEX uq_inspection_sheet_step_result ON quality.inspection_sheet_step_result (inspection_sheet_id, step_code);

-- 항목 판정 — 입력한 항목만 줄이 있다(발취 항목은 비어 있을 수 있다).
CREATE TABLE quality.inspection_sheet_item_result (
    inspection_sheet_item_result_id   bigserial PRIMARY KEY,
    inspection_sheet_id               bigint      NOT NULL REFERENCES quality.inspection_sheet(inspection_sheet_id),
    inspection_sheet_template_item_id bigint      NOT NULL REFERENCES quality.inspection_sheet_template_item(inspection_sheet_template_item_id),
    judgment_code                     varchar(10) NOT NULL CHECK (judgment_code IN ('OK', 'NG')),
    updated_at                        timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE UNIQUE INDEX uq_inspection_sheet_item_result ON quality.inspection_sheet_item_result (inspection_sheet_id, inspection_sheet_template_item_id);

-- NG 기록 — 양식의 NG 블록(OP 3칸 · PP 5칸 출력, 저장은 제한 없음). ⛔ quality.defect_record 를 만들지 않는다(담당자 결정 ⑥).
CREATE TABLE quality.inspection_sheet_ng (
    inspection_sheet_ng_id     bigserial PRIMARY KEY,
    inspection_sheet_id        bigint        NOT NULL REFERENCES quality.inspection_sheet(inspection_sheet_id),
    sequence_no                integer       NOT NULL CHECK (sequence_no > 0),
    found_department_code      varchar(20) CHECK (found_department_code IN ('PRODUCTION', 'QUALITY')),
    found_step_code            varchar(30),
    occurrence_process_text    varchar(200),
    standard_no                varchar(50),
    check_item_code            varchar(30),
    ng_content                 varchar(1000) NOT NULL,
    investigation_text         varchar(1000), -- 조사 또는 수리 내용
    ng_type_code               varchar(20) CHECK (ng_type_code IN ('WORK', 'PART')),
    repair_department_code     varchar(20) CHECK (repair_department_code IN ('PRODUCTION', 'TECH')),
    repair_worker_id           bigint REFERENCES mdm.worker(worker_id),
    repaired_at                timestamptz,
    recheck_result_code        varchar(10) CHECK (recheck_result_code IN ('OK', 'NG')),
    recheck_worker_id          bigint REFERENCES mdm.worker(worker_id),
    rechecked_at               timestamptz,
    created_at                 timestamptz   NOT NULL DEFAULT clock_timestamp(),
    created_by                 bigint REFERENCES app.app_user(app_user_id),
    updated_at                 timestamptz   NOT NULL DEFAULT clock_timestamp(),
    updated_by                 bigint REFERENCES app.app_user(app_user_id),
    version_no                 integer       NOT NULL DEFAULT 1 CHECK (version_no > 0)
);

CREATE UNIQUE INDEX uq_inspection_sheet_ng_seq ON quality.inspection_sheet_ng (inspection_sheet_id, sequence_no);

-- 서명·승인·확인·승인 취소·승인 풀림 이력 — 승인 취소 뒤에도 누가 언제 무엇을 했는지 남긴다(담당자 결정 ⑦).
-- 승인·확인 중 하나만 된 검사표를 고치면 그 승인·확인이 비워진다(APPROVAL_CLEARED) — 고친 사람이 POP 작업자일 수 있어
-- (계정이 없다) 행위자를 계정 또는 작업자로 받는다. 둘 중 하나는 반드시 있다.
CREATE TABLE quality.inspection_sheet_event (
    inspection_sheet_event_id bigserial PRIMARY KEY,
    inspection_sheet_id       bigint      NOT NULL REFERENCES quality.inspection_sheet(inspection_sheet_id),
    event_code                varchar(20) NOT NULL,
    step_code                 varchar(30),
    reason                    varchar(500),
    acted_by                  bigint REFERENCES app.app_user(app_user_id),
    acted_worker_id           bigint REFERENCES mdm.worker(worker_id),
    acted_at                  timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT ck_inspection_sheet_event_code
        CHECK (event_code IN ('SIGN_STEP', 'APPROVE', 'CHECK', 'REOPEN', 'APPROVAL_CLEARED')),
    CONSTRAINT ck_inspection_sheet_event_actor CHECK (acted_by IS NOT NULL OR acted_worker_id IS NOT NULL),
    CONSTRAINT ck_inspection_sheet_event_step CHECK ((event_code = 'SIGN_STEP') = (step_code IS NOT NULL)),
    CONSTRAINT ck_inspection_sheet_event_reason CHECK (event_code <> 'REOPEN' OR reason IS NOT NULL)
);

CREATE INDEX ix_inspection_sheet_event_sheet ON quality.inspection_sheet_event (inspection_sheet_id);

-- ⭐ 시드가 아니라 마이그인 이유 — 배포는 migrate deploy 만 돌고 시드를 안 돌린다. seed.ts 에도 같은 값이 있다.
-- 출력 배치가 이 코드를 보고 칸을 고른다 — 시스템 소유로 잠근다.
INSERT INTO mdm.code_group (group_code, group_name, is_system_owned)
VALUES ('INSPECTION_SHEET_STEP', '제품 검사표 단계', true)
ON CONFLICT (group_code) DO NOTHING;

INSERT INTO mdm.code_value (code_group_id, code, code_name, display_order)
SELECT cg.code_group_id, v.code, v.code_name, v.display_order
FROM mdm.code_group cg
CROSS JOIN (VALUES
    ('PROCESS_1', '공정검사1', 10), ('PROCESS_2', '공정검사2', 20), ('PROCESS_3', '공정검사3', 30),
    ('PROCESS_4', '공정검사4', 40), ('PROCESS_5', '공정검사5', 50), ('SHIPMENT', '출하검사', 60),
    ('CROSS_CHECK', '검사 교차 확인', 70), ('SAMPLING', '발취(샘플) 검사', 80)) AS v(code, code_name, display_order)
WHERE cg.group_code = 'INSPECTION_SHEET_STEP'
ON CONFLICT (code_group_id, code) DO NOTHING;

-- OA 제품 검사표를 쓰는 공장(omf-all-around#89 · 장부 P-102 · 담당자 결정 2026-10-21) — 검사표 화면·API 는 이 공장
-- 범위의 계정·단말에만 열린다. 사업부(VIETNAM)가 부품·OA 두 공장을 함께 가져 사업부로는 가를 수 없어 공장 코드로 둔다.
-- ⭐ 시드가 아니라 마이그인 이유 — 배포는 migrate deploy 만 돌고 시드를 안 돌린다. seed.ts 에도 같은 값이 있다.
INSERT INTO mdm.code_group (group_code, group_name, is_system_owned)
VALUES ('INSPECTION_SHEET_PLANT', '제품 검사표 사용 공장(OA)', true)
ON CONFLICT (group_code) DO NOTHING;

INSERT INTO mdm.code_value (code_group_id, code, code_name, display_order)
SELECT cg.code_group_id, 'PL13', 'OA Plant', 10
FROM mdm.code_group cg
WHERE cg.group_code = 'INSPECTION_SHEET_PLANT'
ON CONFLICT (code_group_id, code) DO NOTHING;
