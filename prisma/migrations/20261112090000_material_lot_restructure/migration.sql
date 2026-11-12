-- 자재 LOT 운영 구조 변경(피처 005 · omf-all-around#254). 지금의 자재 LOT 를 「자재 관리 LOT」로 두고 그 위에
-- 「입하 LOT」(1:N)를 둔다. 표·칸·코드값을 더하고 기존 데이터를 입고별 전송(PER_RECEIPT) 입하 LOT 로 옮긴다.
-- ⚠ IQC 요청 CHECK(ck_inspection_request_iqc_confirmed)는 결과 단위 확정이 종합 판정·확정 시각을 함께 채우는
--   읽기 전환(S2) 코드와 «함께» 배포한다 — 이 마이그레이션만 나가면 이전된 진행 중 IQC 의 확정이 CHECK 에 걸린다.

-- ─────────────────────────────── 1. 멈춤 조건(배포 전 점검 SQL ①·⑤ 와 같은 뜻) ───────────────────────────────
DO $$
DECLARE missing int; unconfirmed int;
BEGIN
  -- 라벨을 아직 발행하지 않은(LOT 없는) 미취소 입하 줄은 새 흐름에서 처리할 길이 없다 — 배포 전에 운영에서 정리한다.
  SELECT count(*) INTO missing
    FROM logistics.inbound_receipt_line ln
    JOIN logistics.inbound_receipt ir ON ir.inbound_receipt_id = ln.inbound_receipt_id
   WHERE ln.lot_id IS NULL
     AND ln.status_code NOT IN ('CANCELLED', 'CANCEL_REQUESTED')
     AND ir.status_code NOT IN ('CANCELLED', 'CANCEL_REQUESTED')
     AND NOT EXISTS (SELECT 1 FROM trace.lot l
                      WHERE l.source_type_code = 'INBOUND_RECEIPT_LINE' AND l.source_id = ln.inbound_receipt_line_id);
  IF missing > 0 THEN
    RAISE EXCEPTION 'LOT 가 없는 미취소 입하 줄이 %건 남아 있습니다 — 옛 P-01-01 로 발행하거나 입하를 취소한 뒤 배포하세요', missing;
  END IF;

  -- 확정(COMPLETED)인데 CONFIRMED 결과가 하나도 없는 LOT IQC 요청 — 종합 판정을 채울 근거가 없다.
  SELECT count(*) INTO unconfirmed
    FROM quality.inspection_request r
   WHERE r.inspection_type_code = 'IQC' AND r.lot_id IS NOT NULL AND r.status_code = 'COMPLETED'
     AND NOT EXISTS (SELECT 1 FROM quality.inspection_result s
                      WHERE s.inspection_request_id = r.inspection_request_id AND s.status_code = 'CONFIRMED');
  IF unconfirmed > 0 THEN
    RAISE EXCEPTION 'CONFIRMED 결과가 없는 완료 IQC 요청이 %건 있습니다 — 운영과 상태를 정리한 뒤 배포하세요', unconfirmed;
  END IF;
END $$;

-- ─────────────────────────────── 2. 새 표 ───────────────────────────────
CREATE TABLE trace.material_lot_batch (
    material_lot_batch_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    plant_id              bigint        NOT NULL REFERENCES mdm.plant(plant_id),
    item_id               bigint        NOT NULL REFERENCES mdm.item(item_id),
    supplier_id           bigint        NOT NULL REFERENCES mdm.partner(partner_id),
    lot_qty               app.qty_t     NOT NULL,
    package_uom_id        bigint        REFERENCES mdm.uom(uom_id),
    package_count         int,
    qty_per_package       app.qty_t,
    supplier_lot_no       varchar(100),
    lot_count             int           NOT NULL,
    created_channel_code  app.code_t    NOT NULL,
    created_at            timestamptz   NOT NULL DEFAULT clock_timestamp(),
    created_by            bigint,
    created_worker_id     bigint,
    CONSTRAINT ck_material_lot_batch_qty CHECK (lot_qty > 0 AND lot_count > 0),
    CONSTRAINT ck_material_lot_batch_package CHECK (
        (package_uom_id IS NULL AND package_count IS NULL AND qty_per_package IS NULL)
        OR (package_uom_id IS NOT NULL AND package_count IS NOT NULL AND qty_per_package IS NOT NULL
            AND package_count > 0 AND qty_per_package > 0
            AND lot_qty = package_count * qty_per_package)),
    CONSTRAINT ck_material_lot_batch_channel CHECK (created_channel_code IN ('POP', 'WEB'))
);
COMMENT ON TABLE trace.material_lot_batch IS '자재 관리 LOT 발행 묶음 — 공급사·품목별로 한 번에 미리 만든 대기 LOT 들의 원천(source_type_code=MATERIAL_LOT_BATCH).';
COMMENT ON COLUMN trace.material_lot_batch.lot_qty IS '자재 관리 LOT 하나의 수량(품목 기본 단위).';
COMMENT ON COLUMN trace.material_lot_batch.supplier_lot_no IS '발행 기록일 뿐 — LOT 마다 lot_external_identifier(SUPPLIER_LOT)로 복사한다.';
COMMENT ON COLUMN trace.material_lot_batch.created_channel_code IS 'POP | WEB. POP 은 created_worker_id, WEB 은 created_by.';

CREATE TABLE trace.inbound_lot (
    inbound_lot_id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    inbound_lot_no            varchar(50)  NOT NULL,
    plant_id                  bigint       NOT NULL REFERENCES mdm.plant(plant_id),
    item_id                   bigint       NOT NULL REFERENCES mdm.item(item_id),
    supplier_id               bigint       NOT NULL REFERENCES mdm.partner(partner_id),
    uom_id                    bigint       NOT NULL REFERENCES mdm.uom(uom_id),
    status_code               app.code_t   NOT NULL,
    receiving_date            date         NOT NULL,
    open_since_date           date,
    received_closed_at        timestamptz,
    received_closed_by        bigint,
    closed_automatically      boolean      NOT NULL DEFAULT false,
    finalized_at              timestamptz,
    finalized_by              bigint,
    erp_send_mode_code        app.code_t   NOT NULL,
    inbound_receipt_line_id   bigint       NOT NULL REFERENCES logistics.inbound_receipt_line(inbound_receipt_line_id),
    split_from_inbound_lot_id bigint       REFERENCES trace.inbound_lot(inbound_lot_id),
    remarks                   text,
    created_at                timestamptz  NOT NULL DEFAULT clock_timestamp(),
    created_by                bigint,
    updated_at                timestamptz  NOT NULL DEFAULT clock_timestamp(),
    updated_by                bigint,
    version_no                int          NOT NULL DEFAULT 1,
    CONSTRAINT uq_inbound_lot UNIQUE (plant_id, inbound_lot_no),
    CONSTRAINT uq_inbound_lot_line UNIQUE (inbound_receipt_line_id),
    CONSTRAINT ck_inbound_lot_status CHECK (status_code IN ('RECEIVING', 'RECEIVED', 'FINALIZED', 'VOIDED')),
    CONSTRAINT ck_inbound_lot_open_since CHECK (status_code <> 'RECEIVING' OR open_since_date IS NOT NULL),
    CONSTRAINT ck_inbound_lot_closed CHECK (status_code NOT IN ('RECEIVED', 'FINALIZED') OR received_closed_at IS NOT NULL),
    CONSTRAINT ck_inbound_lot_finalized CHECK (status_code <> 'FINALIZED' OR finalized_at IS NOT NULL),
    CONSTRAINT ck_inbound_lot_erp_mode CHECK (erp_send_mode_code IN ('PER_RECEIPT', 'ON_FINALIZE')),
    CONSTRAINT ck_inbound_lot_per_receipt CHECK (erp_send_mode_code <> 'PER_RECEIPT' OR status_code <> 'FINALIZED'),
    CONSTRAINT ck_inbound_lot_version CHECK (version_no > 0)
);
COMMENT ON TABLE trace.inbound_lot IS '입하 LOT — 공장·공급사·품목 하나의 한 번 입하. 자재 관리 LOT(trace.lot.inbound_lot_id)를 1:N 으로 묶고 입하 줄과 1:1.';
COMMENT ON COLUMN trace.inbound_lot.inbound_lot_no IS '채번 INBOUND_LOT(IL-YYYYMMDD-NNNN). 이전 데이터는 IL-MIG-<입하 줄 id>.';
COMMENT ON COLUMN trace.inbound_lot.status_code IS 'INBOUND_LOT_STATUS: RECEIVING(입하 중) | RECEIVED(입하 마감) | FINALIZED(최종 마감) | VOIDED(마감 전 마지막 자재 관리 LOT 해제).';
COMMENT ON COLUMN trace.inbound_lot.receiving_date IS '첫 등록의 공장 현지 날짜(plant.timezone_code). 바뀌지 않는다.';
COMMENT ON COLUMN trace.inbound_lot.open_since_date IS '입하 중이 된 공장 현지 날짜(첫 등록, 마감 취소 때 그날). 날짜 자동 마감 기준. RECEIVING 일 때만.';
COMMENT ON COLUMN trace.inbound_lot.received_closed_by IS '입하 마감한 작업자(mdm.worker). 날짜 자동 마감이면 NULL.';
COMMENT ON COLUMN trace.inbound_lot.closed_automatically IS '날짜 자동 마감이면 true. 마감 취소 때 false.';
COMMENT ON COLUMN trace.inbound_lot.finalized_by IS '최종 마감한 사용자(app.app_user).';
COMMENT ON COLUMN trace.inbound_lot.erp_send_mode_code IS 'INBOUND_LOT_ERP_SEND_MODE: PER_RECEIPT(이 기능 전 데이터 — 입고별 전송) | ON_FINALIZE(새 흐름 — 최종 마감 때 한 번).';
COMMENT ON COLUMN trace.inbound_lot.split_from_inbound_lot_id IS '자재 관리 LOT 분리·선별로 생긴 입하 LOT 의 원래 입하 LOT.';

-- 공장·공급사·품목마다 입하 중은 하나.
CREATE UNIQUE INDEX uq_inbound_lot_open ON trace.inbound_lot (plant_id, supplier_id, item_id) WHERE status_code = 'RECEIVING';
CREATE INDEX ix_inbound_lot_auto_close ON trace.inbound_lot (open_since_date) WHERE status_code = 'RECEIVING';
CREATE INDEX ix_inbound_lot_status ON trace.inbound_lot (plant_id, status_code, received_closed_at);
CREATE INDEX ix_inbound_lot_split_from ON trace.inbound_lot (split_from_inbound_lot_id);

CREATE TABLE trace.inbound_lot_event (
    inbound_lot_event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    inbound_lot_id       bigint       NOT NULL REFERENCES trace.inbound_lot(inbound_lot_id),
    event_type_code      app.code_t   NOT NULL,
    summary              jsonb,
    reason               text,
    occurred_at          timestamptz  NOT NULL DEFAULT clock_timestamp(),
    actor_user_id        bigint       REFERENCES app.app_user(app_user_id),
    actor_worker_id      bigint       REFERENCES mdm.worker(worker_id),
    CONSTRAINT ck_inbound_lot_event_actor CHECK (actor_user_id IS NULL OR actor_worker_id IS NULL)
);
COMMENT ON TABLE trace.inbound_lot_event IS '입하 LOT 이력. 행위자가 둘 다 NULL 이면 시스템(summary.auto).';
COMMENT ON COLUMN trace.inbound_lot_event.event_type_code IS 'INBOUND_LOT_EVENT_TYPE 코드값.';
CREATE INDEX ix_inbound_lot_event_lot ON trace.inbound_lot_event (inbound_lot_id, occurred_at);

CREATE TABLE mdm.supplier_item_default (
    supplier_item_default_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    plant_id                 bigint       NOT NULL REFERENCES mdm.plant(plant_id),
    supplier_id              bigint       NOT NULL REFERENCES mdm.partner(partner_id),
    item_id                  bigint       NOT NULL REFERENCES mdm.item(item_id),
    lot_qty                  app.qty_t    NOT NULL,
    package_uom_id           bigint       REFERENCES mdm.uom(uom_id),
    package_count            int,
    qty_per_package          app.qty_t,
    remarks                  text,
    created_at               timestamptz  NOT NULL DEFAULT clock_timestamp(),
    created_by               bigint,
    updated_at               timestamptz  NOT NULL DEFAULT clock_timestamp(),
    updated_by               bigint,
    version_no               int          NOT NULL DEFAULT 1,
    CONSTRAINT uq_supplier_item_default UNIQUE (plant_id, supplier_id, item_id),
    CONSTRAINT ck_supplier_item_default_qty CHECK (lot_qty > 0),
    CONSTRAINT ck_supplier_item_default_package CHECK (
        (package_uom_id IS NULL AND package_count IS NULL AND qty_per_package IS NULL)
        OR (package_uom_id IS NOT NULL AND package_count IS NOT NULL AND qty_per_package IS NOT NULL
            AND package_count > 0 AND qty_per_package > 0
            AND lot_qty = package_count * qty_per_package)),
    CONSTRAINT ck_supplier_item_default_version CHECK (version_no > 0)
);
COMMENT ON TABLE mdm.supplier_item_default IS '공급사·품목 기본 정보(W-06-25) — 자재 관리 LOT 발행 화면의 기본값일 뿐. 바꿔도 이미 만든 LOT 는 그대로.';
COMMENT ON COLUMN mdm.supplier_item_default.lot_qty IS '자재 관리 LOT 당 재고 수량(품목 기본 단위).';

CREATE TABLE quality.inspection_result_lot (
    inspection_result_lot_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    inspection_result_id     bigint NOT NULL REFERENCES quality.inspection_result(inspection_result_id) ON DELETE CASCADE,
    lot_id                   bigint NOT NULL REFERENCES trace.lot(lot_id),
    CONSTRAINT uq_inspection_result_lot UNIQUE (inspection_result_id, lot_id)
);
COMMENT ON TABLE quality.inspection_result_lot IS 'IQC 결과 ↔ 자재 관리 LOT 매칭. LOT 는 결과의 요청이 가리키는 입하 LOT 소속(서비스 규칙).';
CREATE INDEX ix_inspection_result_lot_lot ON quality.inspection_result_lot (lot_id);

CREATE TABLE quality.inspection_request_event (
    inspection_request_event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    inspection_request_id       bigint       NOT NULL REFERENCES quality.inspection_request(inspection_request_id),
    event_type_code             app.code_t   NOT NULL,
    inspection_result_id        bigint,
    summary_before              jsonb,
    summary_after               jsonb,
    reason                      text,
    occurred_at                 timestamptz  NOT NULL DEFAULT clock_timestamp(),
    actor_user_id               bigint       REFERENCES app.app_user(app_user_id),
    actor_worker_id             bigint       REFERENCES mdm.worker(worker_id),
    CONSTRAINT ck_inspection_request_event_actor CHECK (num_nonnulls(actor_user_id, actor_worker_id) = 1)
);
COMMENT ON TABLE quality.inspection_request_event IS 'IQC(입하 LOT) 변경 이력 — 결과 추가·수정·삭제, 판정 확정·취소, 재열기, 생략, 분리.';
COMMENT ON COLUMN quality.inspection_request_event.inspection_result_id IS '지운 결과도 id 를 남기려고 FK 를 두지 않는다.';
CREATE INDEX ix_inspection_request_event_request ON quality.inspection_request_event (inspection_request_id, occurred_at);

-- ─────────────────────────────── 3. 바뀌는 표 ───────────────────────────────
ALTER TABLE trace.lot
    ADD COLUMN inbound_lot_id  bigint REFERENCES trace.inbound_lot(inbound_lot_id),
    ADD COLUMN package_uom_id  bigint REFERENCES mdm.uom(uom_id),
    ADD COLUMN package_count   int,
    ADD COLUMN qty_per_package app.qty_t,
    ADD CONSTRAINT ck_lot_package CHECK (
        (package_uom_id IS NULL AND package_count IS NULL AND qty_per_package IS NULL)
        OR (package_uom_id IS NOT NULL AND package_count IS NOT NULL AND qty_per_package IS NOT NULL
            AND package_count > 0 AND qty_per_package > 0
            AND initial_qty = package_count * qty_per_package));
COMMENT ON COLUMN trace.lot.inbound_lot_id IS '자재 관리 LOT 가 속한 입하 LOT. 받기 때 채운다(이전 데이터는 마이그레이션, LOT_SPLIT 자식은 조상의 것).';
COMMENT ON COLUMN trace.lot.package_count IS '패키징 개수. 패키징 세 칸은 셋 다 있거나 다 없다(ck_lot_package).';
COMMENT ON COLUMN trace.lot.lifecycle_status_code IS 'WAITING | ACTIVE | VOIDED — 생산 사전 발행·자재 대기/폐기. 기존 자재 LOT 는 NULL(사용 중).';
CREATE INDEX ix_lot_inbound_lot ON trace.lot (inbound_lot_id);

ALTER TABLE quality.inspection_request
    ADD COLUMN inbound_lot_id                   bigint REFERENCES trace.inbound_lot(inbound_lot_id),
    ADD COLUMN split_from_inspection_request_id bigint REFERENCES quality.inspection_request(inspection_request_id),
    ADD COLUMN overall_judgment_code            app.code_t,
    ADD COLUMN confirm_cycle                    int NOT NULL DEFAULT 1,
    ADD COLUMN confirmed_at                     timestamptz,
    ADD COLUMN confirmed_by                     bigint,
    ADD CONSTRAINT ck_inspection_request_confirm_cycle CHECK (confirm_cycle > 0);
COMMENT ON COLUMN quality.inspection_request.inbound_lot_id IS 'IQC 요청의 입하 LOT. 새 흐름은 target_type_code=INBOUND_LOT·lot_id NULL, 이전된 옛 요청은 lot_id 도 있다.';
COMMENT ON COLUMN quality.inspection_request.split_from_inspection_request_id IS '처분 단계 선별로 생긴 불합격 확정 기록의 원래 요청.';
COMMENT ON COLUMN quality.inspection_request.overall_judgment_code IS '판정 확정의 종합 판정. 입하 LOT 를 가진 IQC 요청이 COMPLETED 면 필수.';
COMMENT ON COLUMN quality.inspection_request.confirm_cycle IS '확정 주기 — 확정 취소·재작업 재열기 때 +1. 2 이상에서 기록한 결과가 재검사.';
COMMENT ON COLUMN quality.inspection_request.confirmed_by IS '판정 확정한 사용자(이전 데이터는 최종 확정 결과의 updated_by, NULL 가능).';
CREATE UNIQUE INDEX uq_iqc_inspection_request_inbound_lot ON quality.inspection_request (inbound_lot_id)
    WHERE inspection_type_code = 'IQC' AND inbound_lot_id IS NOT NULL;

ALTER TABLE quality.inspection_result ADD COLUMN confirm_cycle int;
COMMENT ON COLUMN quality.inspection_result.confirm_cycle IS '입하 LOT IQC 결과만 — 생성 때 요청의 확정 주기. 옛 행·PQC·OQC 는 NULL.';

ALTER TABLE quality.nonconformance
    ADD COLUMN inspection_request_id    bigint REFERENCES quality.inspection_request(inspection_request_id),
    ADD COLUMN source_nonconformance_id bigint REFERENCES quality.nonconformance(nonconformance_id);
COMMENT ON COLUMN quality.nonconformance.inspection_request_id IS 'IQC 판정이 만든 부적합의 요청(이전 데이터는 결과에서 채움).';
COMMENT ON COLUMN quality.nonconformance.source_nonconformance_id IS '선별로 생긴 부적합의 원래 부적합.';
CREATE INDEX ix_nonconformance_inspection_request ON quality.nonconformance (inspection_request_id);

ALTER TABLE quality.disposition_decision
    ADD COLUMN sort_good_qty   app.qty_t,
    ADD COLUMN sort_defect_qty app.qty_t,
    ADD CONSTRAINT ck_disposition_decision_sort_qty CHECK (
        (sort_good_qty IS NULL OR sort_good_qty >= 0) AND (sort_defect_qty IS NULL OR sort_defect_qty >= 0)
        AND (disposition_type_code = 'SORT' OR (sort_good_qty IS NULL AND sort_defect_qty IS NULL)));
COMMENT ON COLUMN quality.disposition_decision.sort_good_qty IS '선별(자재 관리 LOT 분리) 정보 수량 — 양품. SORT 판정만, 입력 없으면 NULL.';
COMMENT ON COLUMN quality.disposition_decision.sort_defect_qty IS '선별(자재 관리 LOT 분리) 정보 수량 — 불량. SORT 판정만, 입력 없으면 NULL.';

COMMENT ON COLUMN trace.lot_status_event.source_document_type_code IS
    '원천 문서 유형(entity_type_registry). IQC 판정 확정·취소는 INSPECTION_REQUEST. 유형과 id 는 함께 있거나 함께 없다(ck_lot_status_event_source).';

-- ─────────────────────────────── 4. 데이터 이전 ───────────────────────────────
-- 옮기기만 하므로 updated_at 을 건드리지 않는다.
ALTER TABLE trace.lot DISABLE TRIGGER trg_lot_set_updated_at;
ALTER TABLE quality.inspection_request DISABLE TRIGGER trg_inspection_request_set_updated_at;
ALTER TABLE quality.nonconformance DISABLE TRIGGER trg_nonconformance_set_updated_at;

-- 4-1. 원천이 입하 줄인 자재 LOT 의 줄마다 입하 LOT 하나(RECEIVED·PER_RECEIPT). 한 줄의 LOT 가 여럿이면 모두 그 입하 LOT 에.
INSERT INTO trace.inbound_lot (inbound_lot_no, plant_id, item_id, supplier_id, uom_id, status_code,
                               receiving_date, received_closed_at, erp_send_mode_code, inbound_receipt_line_id,
                               created_at, created_by, updated_at, updated_by)
SELECT 'IL-MIG-' || ln.inbound_receipt_line_id, ir.plant_id, ln.item_id, ir.supplier_id, it.base_uom_id, 'RECEIVED',
       (ir.receipt_datetime AT TIME ZONE p.timezone_code)::date, ir.receipt_datetime, 'PER_RECEIPT',
       ln.inbound_receipt_line_id, ln.created_at, ln.created_by, ln.created_at, ln.created_by
  FROM logistics.inbound_receipt_line ln
  JOIN logistics.inbound_receipt ir ON ir.inbound_receipt_id = ln.inbound_receipt_id
  JOIN mdm.plant p ON p.plant_id = ir.plant_id
  JOIN mdm.item it ON it.item_id = ln.item_id
 WHERE EXISTS (SELECT 1 FROM trace.lot l
                WHERE l.source_type_code = 'INBOUND_RECEIPT_LINE' AND l.source_id = ln.inbound_receipt_line_id);

UPDATE trace.lot l
   SET inbound_lot_id = il.inbound_lot_id
  FROM trace.inbound_lot il
 WHERE l.source_type_code = 'INBOUND_RECEIPT_LINE' AND il.inbound_receipt_line_id = l.source_id;

-- LOT_SPLIT 자식(옛 선별 불량분)은 조상의 입하 LOT.
WITH RECURSIVE heir AS (
    SELECT c.lot_id, p.inbound_lot_id
      FROM trace.lot c JOIN trace.lot p ON p.lot_id = c.parent_lot_id
     WHERE c.source_type_code = 'LOT_SPLIT' AND p.inbound_lot_id IS NOT NULL
    UNION ALL
    SELECT c.lot_id, h.inbound_lot_id
      FROM trace.lot c JOIN heir h ON h.lot_id = c.parent_lot_id
     WHERE c.source_type_code = 'LOT_SPLIT'
)
UPDATE trace.lot l SET inbound_lot_id = heir.inbound_lot_id FROM heir WHERE l.lot_id = heir.lot_id;

-- 4-2. P/O 배정 표는 손대지 않는다(줄 축 = 입하 LOT 축).

-- 4-3. LOT 대상 IQC 요청에 입하 LOT. 확정 요청은 가장 높은 회차의 CONFIRMED 결과로 종합 판정·확정 시각·사람.
-- ⚠ 한 입하 줄에 LOT·IQC 요청이 여럿인 옛 데이터(공급사 채널 발행·선별 자식)는 입하 LOT 당 요청 하나라는
--   유일 색인과 맞지 않아 채우지 않는다 — 그 요청은 lot_id 로 끝까지 옛 경로다.
UPDATE quality.inspection_request r
   SET inbound_lot_id = l.inbound_lot_id
  FROM trace.lot l
 WHERE r.inspection_type_code = 'IQC' AND r.lot_id = l.lot_id AND l.inbound_lot_id IS NOT NULL
   AND (SELECT count(*) FROM quality.inspection_request r2 JOIN trace.lot l2 ON l2.lot_id = r2.lot_id
         WHERE r2.inspection_type_code = 'IQC' AND l2.inbound_lot_id = l.inbound_lot_id) = 1;

UPDATE quality.inspection_request r
   SET overall_judgment_code = last.overall_judgment_code,
       confirmed_at          = coalesce(last.confirmed_at, last.updated_at),
       confirmed_by          = last.updated_by
  FROM (SELECT DISTINCT ON (s.inspection_request_id)
               s.inspection_request_id, s.overall_judgment_code, s.confirmed_at, s.updated_at, s.updated_by
          FROM quality.inspection_result s
         WHERE s.status_code = 'CONFIRMED'
         ORDER BY s.inspection_request_id, s.inspection_round DESC) last
 WHERE r.inspection_request_id = last.inspection_request_id
   AND r.inspection_type_code = 'IQC' AND r.inbound_lot_id IS NOT NULL AND r.status_code = 'COMPLETED';

-- 4-4. 열린 IQC_SKIP 결재의 대상 id 는 옮기지 않는다 — 지금 생략 코드가 대상을 LOT id 로 읽는다(설계 문의 중).

-- 4-5. IQC 결과에서 온 부적합에 요청.
UPDATE quality.nonconformance n
   SET inspection_request_id = s.inspection_request_id
  FROM quality.inspection_result s
  JOIN quality.inspection_request r ON r.inspection_request_id = s.inspection_request_id
 WHERE n.inspection_result_id = s.inspection_result_id AND r.inspection_type_code = 'IQC';

ALTER TABLE trace.lot ENABLE TRIGGER trg_lot_set_updated_at;
ALTER TABLE quality.inspection_request ENABLE TRIGGER trg_inspection_request_set_updated_at;
ALTER TABLE quality.nonconformance ENABLE TRIGGER trg_nonconformance_set_updated_at;

-- 이전을 마친 뒤 건다 — 입하 LOT 를 가진 IQC 요청이 COMPLETED 면 종합 판정·확정 시각이 있어야 한다.
ALTER TABLE quality.inspection_request ADD CONSTRAINT ck_inspection_request_iqc_confirmed CHECK (
    status_code <> 'COMPLETED' OR inspection_type_code <> 'IQC' OR inbound_lot_id IS NULL
    OR (overall_judgment_code IS NOT NULL AND confirmed_at IS NOT NULL));

-- 4-8. 권한 덧붙임 — 지금 동작이 그대로 되게 기존 역할에 새 권한을 준다(시드는 기본 역할에 권한을 주지 않는 관례).
INSERT INTO app.role_permission (role_id, permission_code)
SELECT rp.role_id, v.new_code
  FROM app.role_permission rp
  JOIN (VALUES ('W-01-01', 'W-01-15'), ('W-01-09', 'W-01-16'), ('M-01-01', 'M-01-03')) AS v(old_code, new_code)
    ON rp.permission_code = v.old_code
ON CONFLICT (role_id, permission_code) DO NOTHING;

-- ─────────────────────────────── 5. 코드값 ───────────────────────────────
-- ⭐ 시드가 아니라 마이그인 이유 — 배포는 migrate deploy 만 돌고 시드를 안 돌린다. seed.ts 에도 같은 줄을 둔다.
INSERT INTO mdm.code_group (group_code, group_name, is_system_owned)
VALUES ('INBOUND_LOT_STATUS', '입하 LOT 상태', true),
       ('INBOUND_LOT_EVENT_TYPE', '입하 LOT 이력 유형', true),
       ('INBOUND_LOT_ERP_SEND_MODE', '입하 LOT ERP 전송 방식', true),
       ('INSPECTION_REQUEST_EVENT_TYPE', 'IQC 변경 이력 유형', true)
ON CONFLICT (group_code) DO NOTHING;

INSERT INTO mdm.code_value (code_group_id, code, code_name, display_order, name_ko, name_vi)
SELECT cg.code_group_id, v.code, v.code_name, v.display_order, v.code_name, v.name_vi
  FROM mdm.code_group cg
  JOIN (VALUES
    ('INBOUND_LOT_STATUS', 'RECEIVING', '입하 중', 10, 'Đang nhận hàng'),
    ('INBOUND_LOT_STATUS', 'RECEIVED', '입하 완료', 20, 'Đã nhận hàng'),
    ('INBOUND_LOT_STATUS', 'FINALIZED', '최종 마감', 30, 'Đã chốt cuối'),
    ('INBOUND_LOT_STATUS', 'VOIDED', '폐기', 40, 'Đã hủy'),
    ('INBOUND_LOT_EVENT_TYPE', 'CREATED_BY_RECEIVE', '받기로 생성', 10, 'Tạo khi nhận'),
    ('INBOUND_LOT_EVENT_TYPE', 'LOTS_REGISTERED', '자재 관리 LOT 등록', 20, 'Đăng ký LOT quản lý vật tư'),
    ('INBOUND_LOT_EVENT_TYPE', 'LOTS_UNREGISTERED', '자재 관리 LOT 해제', 30, 'Hủy đăng ký LOT quản lý vật tư'),
    ('INBOUND_LOT_EVENT_TYPE', 'SUPPLIER_LOT_SET', '공급사 LOT 번호 변경', 40, 'Đổi số LOT nhà cung cấp'),
    ('INBOUND_LOT_EVENT_TYPE', 'RECEIPT_CLOSED', '입하 마감', 50, 'Chốt nhận hàng'),
    ('INBOUND_LOT_EVENT_TYPE', 'RECEIPT_REOPENED', '마감 취소', 60, 'Hủy chốt nhận hàng'),
    ('INBOUND_LOT_EVENT_TYPE', 'ALLOCATION_EDITED', '배정 수정', 70, 'Sửa phân bổ'),
    ('INBOUND_LOT_EVENT_TYPE', 'RECEIPT_FINALIZED', '최종 마감', 80, 'Chốt cuối'),
    ('INBOUND_LOT_EVENT_TYPE', 'SPLIT', '분리', 90, 'Tách'),
    ('INBOUND_LOT_EVENT_TYPE', 'VOIDED', '폐기', 100, 'Hủy'),
    ('INBOUND_LOT_ERP_SEND_MODE', 'PER_RECEIPT', '입고별 전송', 10, 'Gửi theo từng lần nhập kho'),
    ('INBOUND_LOT_ERP_SEND_MODE', 'ON_FINALIZE', '최종 마감 때 전송', 20, 'Gửi khi chốt cuối'),
    ('INSPECTION_REQUEST_EVENT_TYPE', 'RESULT_ADDED', '결과 추가', 10, 'Thêm kết quả'),
    ('INSPECTION_REQUEST_EVENT_TYPE', 'RESULT_UPDATED', '결과 수정', 20, 'Sửa kết quả'),
    ('INSPECTION_REQUEST_EVENT_TYPE', 'RESULT_DELETED', '결과 삭제', 30, 'Xóa kết quả'),
    ('INSPECTION_REQUEST_EVENT_TYPE', 'CONFIRMED', '판정 확정', 40, 'Xác nhận phán định'),
    ('INSPECTION_REQUEST_EVENT_TYPE', 'CONFIRM_CANCELLED', '확정 취소', 50, 'Hủy xác nhận'),
    ('INSPECTION_REQUEST_EVENT_TYPE', 'REOPENED_BY_REWORK', '재작업 재열기', 60, 'Mở lại do tái chế'),
    ('INSPECTION_REQUEST_EVENT_TYPE', 'SKIPPED', '생략', 70, 'Bỏ qua'),
    ('INSPECTION_REQUEST_EVENT_TYPE', 'SKIP_VOIDED', '생략 무효', 80, 'Hủy bỏ qua'),
    ('INSPECTION_REQUEST_EVENT_TYPE', 'SPLIT_OUT', '분리로 나감', 90, 'Tách ra'),
    ('INSPECTION_REQUEST_EVENT_TYPE', 'SPLIT_IN', '분리로 들어옴', 100, 'Tách vào'),
    ('INSPECTION_REQUEST_EVENT_TYPE', 'CANCELLED_BY_REOPEN', '마감 취소로 무효', 110, 'Hủy do mở lại nhận hàng'),
    ('LOT_SOURCE_TYPE', 'MATERIAL_LOT_BATCH', '자재 관리 LOT 발행 묶음', 50, 'Lô phát hành LOT quản lý vật tư'),
    ('NONCONFORMANCE_STATUS', 'CANCELLED', '취소', 40, 'Đã hủy'),
    ('LOT_STATUS_TRANSITION', 'C29', 'IQC 확정 취소 → 검사 대기', 220, 'Hủy xác nhận IQC → chờ kiểm tra'),
    ('LOT_STATUS_TRANSITION', 'C30', 'IQC 생략 무효 → 검사 대기', 230, 'Hủy bỏ qua IQC → chờ kiểm tra'),
    ('LOT_STATUS_TRANSITION', 'C31', '입하 등록 해제 → 검사 대기', 240, 'Hủy đăng ký nhận hàng → chờ kiểm tra'),
    ('LOT_LIFECYCLE_TRANSITION', 'L4', '대기 → 활성(자재 입하 등록)', 40, 'Chờ → hoạt động (đăng ký nhận vật tư)'),
    ('LOT_LIFECYCLE_TRANSITION', 'L5', '대기 → 폐번(자재 관리 LOT 폐기)', 50, 'Chờ → hủy (hủy LOT quản lý vật tư)'),
    ('LOT_LIFECYCLE_TRANSITION', 'L6', '활성 → 대기(자재 입하 등록 해제)', 60, 'Hoạt động → chờ (hủy đăng ký nhận vật tư)')
  ) AS v(group_code, code, code_name, display_order, name_vi) ON v.group_code = cg.group_code
ON CONFLICT (code_group_id, code) DO NOTHING;
