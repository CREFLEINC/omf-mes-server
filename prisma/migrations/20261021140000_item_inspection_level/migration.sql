-- 품목별 IQC 검사 수준과 자동 전환(omf-all-around#64 · 장부 P-85).
-- ⭐ 품목(mdm.item)에 칸을 달지 않는다 — 품목은 ERP 수신본이라 MES 가 고치지 않는다. 행이 없는 품목은 지금처럼 동작한다.
-- 수준: NONE(무검사) · REDUCED(수월) · NORMAL(보통) · TIGHTENED(엄격). 샘플 수량·판정 기준은 바꾸지 않는다 — 표시·기록만.
CREATE TABLE quality.item_inspection_level (
    item_inspection_level_id bigserial PRIMARY KEY,
    item_id                  bigint      NOT NULL REFERENCES mdm.item(item_id),
    inspection_level_code    varchar(50) NOT NULL,
    auto_switch_enabled      boolean     NOT NULL DEFAULT true,
    consecutive_accept_count integer     NOT NULL DEFAULT 0 CHECK (consecutive_accept_count >= 0),
    created_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by               bigint REFERENCES app.app_user(app_user_id),
    updated_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by               bigint REFERENCES app.app_user(app_user_id),
    version_no               integer     NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT uq_item_inspection_level_item UNIQUE (item_id),
    CONSTRAINT ck_item_inspection_level_code
        CHECK (inspection_level_code IN ('NONE', 'REDUCED', 'NORMAL', 'TIGHTENED'))
);

-- 전환 이력. 자동(AUTO)은 연속 합격 수 또는 불합격 의뢰를, 수동(MANUAL)은 입력 사유를 남긴다. 최초 지정은 이전 수준이 비어 있다.
-- 처리자는 계정 또는 단말 작업자 — 오프라인 큐로 들어온 IQC 확정은 계정이 없다(trace.lot_status_event 와 같은 규율).
CREATE TABLE quality.item_inspection_level_history (
    item_inspection_level_history_id bigserial PRIMARY KEY,
    item_id                  bigint      NOT NULL REFERENCES mdm.item(item_id),
    from_level_code          varchar(50),
    to_level_code            varchar(50) NOT NULL,
    change_type_code         varchar(50) NOT NULL,
    consecutive_accept_count integer CHECK (consecutive_accept_count >= 0),
    inspection_request_id    bigint REFERENCES quality.inspection_request(inspection_request_id),
    reason                   text,
    changed_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
    changed_by               bigint REFERENCES app.app_user(app_user_id),
    changed_worker_id        bigint REFERENCES mdm.worker(worker_id),
    CONSTRAINT ck_item_inspection_level_history_level
        CHECK (to_level_code IN ('NONE', 'REDUCED', 'NORMAL', 'TIGHTENED')
           AND (from_level_code IS NULL OR from_level_code IN ('NONE', 'REDUCED', 'NORMAL', 'TIGHTENED'))),
    CONSTRAINT ck_item_inspection_level_history_type
        CHECK (change_type_code IN ('AUTO', 'MANUAL')),
    CONSTRAINT ck_item_inspection_level_history_reason
        CHECK (change_type_code = 'AUTO' OR (reason IS NOT NULL AND btrim(reason) <> '')),
    CONSTRAINT ck_item_inspection_level_history_actor
        CHECK (changed_by IS NOT NULL OR changed_worker_id IS NOT NULL)
);

CREATE INDEX ix_item_inspection_level_history_item
    ON quality.item_inspection_level_history (item_id, changed_at DESC);
CREATE INDEX ix_item_inspection_level_history_changed_at
    ON quality.item_inspection_level_history (changed_at DESC);

-- 그 LOT 을 검사한 수준. IQC 첫 확정 때 한 번만 채운다 — 값이 있으면 이미 센 의뢰라 재검사 회차·재저장이 두 번 세지 않는다.
ALTER TABLE quality.inspection_request
    ADD COLUMN inspection_level_code varchar(50),
    ADD CONSTRAINT ck_inspection_request_level
        CHECK (inspection_level_code IS NULL OR inspection_level_code IN ('NONE', 'REDUCED', 'NORMAL', 'TIGHTENED'));
