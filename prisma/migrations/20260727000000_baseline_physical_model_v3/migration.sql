-- Baseline — 물리 모델 정본을 그대로 적재한다.
-- 원본: docs/research/2026-07-23-데이터모델링/mes_postgresql_physical_model.sql (v3, ERPNext 벤치마킹 반영)
-- 이 파일은 손으로 고치지 않는다. 스키마 변경은 정본 SQL 갱신 → 후속 마이그레이션으로 반영한다.
-- Prisma가 마이그레이션을 자체 트랜잭션으로 감싸므로 원본의 BEGIN;/COMMIT; 두 줄만 제거했다.

-- ============================================================================
-- MES PostgreSQL Physical Model  (v3)
-- Baseline target: PostgreSQL 16+
-- Scope: MDM, Production, Inventory, Quality, Traceability, Logistics,
--        Integration, Audit
--
-- v3: ERPNext(frappe/erpnext) 벤치마킹 검토 반영본. 변경 내역은 v3/CHANGELOG.md 참조.
--     [E-1] 적치 규칙 마스터 (putaway_rule)
--     [E-2] 반제품 계획 계층 연결 (production_order.parent_production_order_id)
--     [E-3] 작업지시 기본 로케이션 (WIP/완성품/스크랩)
--     [E-4] 운영정책 코드 시드 (manufacturing_settings 벤치마킹)
--     [E-5] 원장 잔액 스냅샷 (qty_after_transaction 패턴)
--     [E-6] 기본 BOM 지정 (is_default)
--     [E-7] 재고상태 IN_TRANSIT 시드
--
-- v2: 요구사항 검토 결과 반영본. 변경 내역은 v2/CHANGELOG.md 참조.
--     [H-1] 사용자·부서·권한 기준정보 신설 및 참조 FK 정비
--     [H-2] 음수재고 정책 지원 (signed 도메인 + 조건부 검증 트리거)
--     [H-3] concession(특채) 물리 반영
--     [H-4] 생산라인·작업구역 기준정보 신설
--     [H-5] 작업지시 분할·재작업 계보
--     [H-6] 적치(putaway) 지시
--     [M-*] 정정 계보, 발행이력, 정책·채번, 품질 보강, ASN, LOT 보류 등
--     [L-*] 소형 컬럼 보강, 무결성 트리거(3-3 DB-C17~C20, TRG-05/06) 구현
-- ============================================================================


-- --------------------------------------------------------------------------
-- 0. Schemas
-- --------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS mdm;
CREATE SCHEMA IF NOT EXISTS planning;
CREATE SCHEMA IF NOT EXISTS production;
CREATE SCHEMA IF NOT EXISTS inventory;
CREATE SCHEMA IF NOT EXISTS quality;
CREATE SCHEMA IF NOT EXISTS trace;
CREATE SCHEMA IF NOT EXISTS logistics;
CREATE SCHEMA IF NOT EXISTS integration;
CREATE SCHEMA IF NOT EXISTS audit;

-- --------------------------------------------------------------------------
-- 1. Domains and common trigger
-- --------------------------------------------------------------------------
CREATE DOMAIN app.code_t AS varchar(50)
    CHECK (VALUE <> '');

CREATE DOMAIN app.name_t AS varchar(200)
    CHECK (VALUE <> '');

CREATE DOMAIN app.business_no_t AS varchar(100)
    CHECK (VALUE <> '');

CREATE DOMAIN app.qty_t AS numeric(20, 6)
    CHECK (VALUE >= 0);

-- [H-2] 음수재고 허용 품목(item.negative_stock_allowed = true)을 지원하기 위한
--       부호 있는 수량 도메인. 음수 허용 여부는 constraint trigger로 조건부 검증.
CREATE DOMAIN app.signed_qty_t AS numeric(20, 6);

CREATE DOMAIN app.rate_t AS numeric(18, 8)
    CHECK (VALUE >= 0);

CREATE OR REPLACE FUNCTION app.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
END;
$$;

-- --------------------------------------------------------------------------
-- 2. Common codes
-- --------------------------------------------------------------------------
CREATE TABLE mdm.code_group (
    code_group_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    group_code         app.code_t NOT NULL UNIQUE,
    group_name         app.name_t NOT NULL,
    description        text,
    is_active          boolean NOT NULL DEFAULT true,
    created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by         bigint,
    updated_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by         bigint,
    version_no         integer NOT NULL DEFAULT 1 CHECK (version_no > 0)
);

CREATE TABLE mdm.code_value (
    code_value_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code_group_id      bigint NOT NULL
                       REFERENCES mdm.code_group(code_group_id),
    code               app.code_t NOT NULL,
    code_name          app.name_t NOT NULL,
    display_order      integer NOT NULL DEFAULT 0,
    effective_from     date,
    effective_to       date,
    is_active          boolean NOT NULL DEFAULT true,
    created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by         bigint,
    updated_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by         bigint,
    version_no         integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT uq_code_value UNIQUE (code_group_id, code),
    CONSTRAINT ck_code_value_dates
        CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from)
);

-- --------------------------------------------------------------------------
-- 3. Organization / site / warehouse
-- --------------------------------------------------------------------------
CREATE TABLE mdm.legal_entity (
    legal_entity_id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    legal_entity_code  app.code_t NOT NULL UNIQUE,
    legal_entity_name  app.name_t NOT NULL,
    country_code       varchar(3) NOT NULL,
    timezone_code      varchar(64) NOT NULL,
    is_active          boolean NOT NULL DEFAULT true,
    created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by         bigint,
    updated_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by         bigint,
    version_no         integer NOT NULL DEFAULT 1 CHECK (version_no > 0)
);

CREATE TABLE mdm.business_unit (
    business_unit_id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    legal_entity_id     bigint NOT NULL
                        REFERENCES mdm.legal_entity(legal_entity_id),
    business_unit_code  app.code_t NOT NULL,
    business_unit_name  app.name_t NOT NULL,
    is_active           boolean NOT NULL DEFAULT true,
    created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by          bigint,
    updated_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by          bigint,
    version_no          integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT uq_business_unit UNIQUE (legal_entity_id, business_unit_code)
);

CREATE TABLE mdm.plant (
    plant_id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    legal_entity_id     bigint NOT NULL
                        REFERENCES mdm.legal_entity(legal_entity_id),
    business_unit_id    bigint
                        REFERENCES mdm.business_unit(business_unit_id),
    plant_code          app.code_t NOT NULL,
    plant_name          app.name_t NOT NULL,
    timezone_code       varchar(64) NOT NULL,
    is_active           boolean NOT NULL DEFAULT true,
    created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by          bigint,
    updated_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by          bigint,
    version_no          integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT uq_plant UNIQUE (legal_entity_id, plant_code)
);

-- [H-4] 생산라인·작업구역 기준정보 (2-1 FR-WO-006/013/018, 1-3 SCN-02)
--       line_type_code = LINE | WORK_AREA. 작업구역은 parent_line_id로
--       라인 하위에 계층 구성한다. 논리 모델 §9.2 planned_line_id의 참조 대상.
CREATE TABLE mdm.production_line (
    production_line_id  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    plant_id            bigint NOT NULL REFERENCES mdm.plant(plant_id),
    parent_line_id      bigint REFERENCES mdm.production_line(production_line_id),
    line_code           app.code_t NOT NULL,
    line_name           app.name_t NOT NULL,
    line_type_code      app.code_t NOT NULL DEFAULT 'LINE',
    is_active           boolean NOT NULL DEFAULT true,
    created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by          bigint,
    updated_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by          bigint,
    version_no          integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT uq_production_line UNIQUE (plant_id, line_code),
    CONSTRAINT ck_production_line_parent
        CHECK (parent_line_id IS NULL OR parent_line_id <> production_line_id)
);

CREATE TABLE mdm.partner (
    partner_id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    partner_code        app.code_t NOT NULL UNIQUE,
    partner_name        app.name_t NOT NULL,
    country_code        varchar(3),
    erp_partner_code    varchar(100),
    is_active           boolean NOT NULL DEFAULT true,
    created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by          bigint,
    updated_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by          bigint,
    version_no          integer NOT NULL DEFAULT 1 CHECK (version_no > 0)
);

CREATE TABLE mdm.partner_role (
    partner_role_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    partner_id          bigint NOT NULL
                        REFERENCES mdm.partner(partner_id),
    role_type_code      app.code_t NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by          bigint,
    CONSTRAINT uq_partner_role UNIQUE (partner_id, role_type_code)
);

-- --------------------------------------------------------------------------
-- 3.5 [H-1] Users / departments / roles
--     (1-2 사용자·권한 관리, 2-7 NFR-IM-010/011, 3-1 §5.10, 3-2 §22)
--     승인자·처리자·담당부서 참조 컬럼의 FK 대상.
--     전 테이블의 created_by/updated_by는 대량 적재 성능을 위해 FK를 걸지 않고
--     애플리케이션 계층에서 app_user 기준으로 검증한다(의도적 결정).
-- --------------------------------------------------------------------------
CREATE TABLE mdm.department (
    department_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    department_code      app.code_t NOT NULL UNIQUE,
    department_name      app.name_t NOT NULL,
    parent_department_id bigint REFERENCES mdm.department(department_id),
    business_unit_id     bigint REFERENCES mdm.business_unit(business_unit_id),
    is_active            boolean NOT NULL DEFAULT true,
    created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by           bigint,
    updated_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by           bigint,
    version_no           integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT ck_department_parent
        CHECK (parent_department_id IS NULL OR parent_department_id <> department_id)
);

CREATE TABLE app.app_user (
    app_user_id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    login_id             varchar(100) NOT NULL UNIQUE,
    user_name            app.name_t NOT NULL,
    department_id        bigint REFERENCES mdm.department(department_id),
    email                varchar(200),
    status_code          app.code_t NOT NULL DEFAULT 'ACTIVE',
    is_active            boolean NOT NULL DEFAULT true,
    created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by           bigint,
    updated_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by           bigint,
    version_no           integer NOT NULL DEFAULT 1 CHECK (version_no > 0)
);

CREATE TABLE app.role (
    role_id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    role_code            app.code_t NOT NULL UNIQUE,
    role_name            app.name_t NOT NULL,
    description          text,
    is_active            boolean NOT NULL DEFAULT true,
    created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by           bigint,
    updated_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by           bigint,
    version_no           integer NOT NULL DEFAULT 1 CHECK (version_no > 0)
);

-- 기능 권한: 조회·등록·수정·마감 등 permission_code 단위 (1-2 필수 공통 기능)
CREATE TABLE app.role_permission (
    role_permission_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    role_id              bigint NOT NULL REFERENCES app.role(role_id),
    permission_code      app.code_t NOT NULL,
    created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by           bigint,
    CONSTRAINT uq_role_permission UNIQUE (role_id, permission_code)
);

CREATE TABLE app.user_role (
    user_role_id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    app_user_id          bigint NOT NULL REFERENCES app.app_user(app_user_id),
    role_id              bigint NOT NULL REFERENCES app.role(role_id),
    created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by           bigint,
    CONSTRAINT uq_user_role UNIQUE (app_user_id, role_id)
);

-- 데이터 접근범위: 사용자별 사업부·공장 권한 (1-3 SCN-20 검증, RLS §24와 연동)
CREATE TABLE app.user_data_scope (
    user_data_scope_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    app_user_id          bigint NOT NULL REFERENCES app.app_user(app_user_id),
    business_unit_id     bigint REFERENCES mdm.business_unit(business_unit_id),
    plant_id             bigint REFERENCES mdm.plant(plant_id),
    created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by           bigint,
    CONSTRAINT ck_user_data_scope_target
        CHECK (business_unit_id IS NOT NULL OR plant_id IS NOT NULL)
);

CREATE UNIQUE INDEX uq_user_data_scope
ON app.user_data_scope (
    app_user_id,
    COALESCE(business_unit_id, 0),
    COALESCE(plant_id, 0)
);

CREATE TABLE mdm.warehouse (
    warehouse_id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    plant_id              bigint NOT NULL
                          REFERENCES mdm.plant(plant_id),
    business_unit_id      bigint NOT NULL
                          REFERENCES mdm.business_unit(business_unit_id),
    warehouse_code        app.code_t NOT NULL,
    warehouse_name        app.name_t NOT NULL,
    warehouse_type_code   app.code_t NOT NULL,
    management_level_code app.code_t NOT NULL,
    is_external           boolean NOT NULL DEFAULT false,
    partner_id            bigint
                          REFERENCES mdm.partner(partner_id),
    is_active             boolean NOT NULL DEFAULT true,
    created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by            bigint,
    updated_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by            bigint,
    version_no            integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT uq_warehouse UNIQUE (plant_id, warehouse_code),
    CONSTRAINT ck_external_warehouse_partner
        CHECK (NOT is_external OR partner_id IS NOT NULL)
);

CREATE TABLE mdm.uom (
    uom_id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    uom_code            app.code_t NOT NULL UNIQUE,
    uom_name            app.name_t NOT NULL,
    decimal_scale       smallint NOT NULL DEFAULT 0
                        CHECK (decimal_scale BETWEEN 0 AND 6),
    is_active           boolean NOT NULL DEFAULT true,
    created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by          bigint,
    updated_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by          bigint,
    version_no          integer NOT NULL DEFAULT 1 CHECK (version_no > 0)
);

CREATE TABLE mdm.location (
    location_id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    warehouse_id         bigint NOT NULL
                         REFERENCES mdm.warehouse(warehouse_id),
    parent_location_id   bigint
                         REFERENCES mdm.location(location_id),
    location_code        app.code_t NOT NULL,
    location_name        app.name_t NOT NULL,
    location_type_code   app.code_t NOT NULL,
    quality_zone_code    app.code_t,
    storage_condition_code app.code_t,                    -- [L] 보관조건: 온도·습도·위험물 (1-3 SCN-22)
    allow_mixed_item     boolean NOT NULL DEFAULT true,
    allow_mixed_lot      boolean NOT NULL DEFAULT true,
    capacity_qty         app.qty_t,
    capacity_uom_id      bigint
                         REFERENCES mdm.uom(uom_id),
    is_active            boolean NOT NULL DEFAULT true,
    created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by           bigint,
    updated_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by           bigint,
    version_no           integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT uq_location UNIQUE (warehouse_id, location_code),
    CONSTRAINT ck_location_capacity
        CHECK ((capacity_qty IS NULL) = (capacity_uom_id IS NULL))
);

-- --------------------------------------------------------------------------
-- 4. Item / process / equipment
-- --------------------------------------------------------------------------
CREATE TABLE mdm.item (
    item_id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    item_code                  app.code_t NOT NULL UNIQUE,
    item_name                  app.name_t NOT NULL,
    item_type_code             app.code_t NOT NULL,
    base_uom_id                bigint NOT NULL
                               REFERENCES mdm.uom(uom_id),
    lot_control_type_code      app.code_t NOT NULL,
    serial_control_type_code   app.code_t NOT NULL DEFAULT 'NONE',
    shelf_life_days            integer CHECK (shelf_life_days IS NULL OR shelf_life_days >= 0),
    inspection_required       boolean NOT NULL DEFAULT false,
    fifo_policy_code           app.code_t NOT NULL DEFAULT 'FIFO',
    negative_stock_allowed     boolean NOT NULL DEFAULT false,
    storage_condition_code     app.code_t,                       -- [L] 보관조건 (1-3 SCN-22)
    opened_shelf_life_hours    integer                           -- [L] 개봉 후 사용 가능시간 (1-3 SCN-25)
                               CHECK (opened_shelf_life_hours IS NULL OR opened_shelf_life_hours > 0),
    is_active                  boolean NOT NULL DEFAULT true,
    created_at                 timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by                 bigint,
    updated_at                 timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by                 bigint,
    version_no                 integer NOT NULL DEFAULT 1 CHECK (version_no > 0)
);

CREATE TABLE mdm.item_uom_conversion (
    item_uom_conversion_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    item_id                bigint NOT NULL REFERENCES mdm.item(item_id),
    from_uom_id            bigint NOT NULL REFERENCES mdm.uom(uom_id),
    to_uom_id              bigint NOT NULL REFERENCES mdm.uom(uom_id),
    conversion_rate        app.rate_t NOT NULL CHECK (conversion_rate > 0),
    effective_from         date NOT NULL,
    effective_to           date,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    CONSTRAINT uq_item_uom_conversion
        UNIQUE (item_id, from_uom_id, to_uom_id, effective_from),
    CONSTRAINT ck_item_uom_dates
        CHECK (effective_to IS NULL OR effective_to >= effective_from),
    CONSTRAINT ck_item_uom_distinct
        CHECK (from_uom_id <> to_uom_id)
);

CREATE TABLE mdm.item_external_code (
    item_external_code_id  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    item_id                bigint NOT NULL REFERENCES mdm.item(item_id),
    external_system_code   app.code_t NOT NULL,
    partner_id             bigint REFERENCES mdm.partner(partner_id),
    external_item_code     varchar(100) NOT NULL,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint
);

CREATE UNIQUE INDEX uq_item_external_code
ON mdm.item_external_code (
    item_id,
    external_system_code,
    COALESCE(partner_id, 0),
    external_item_code
);

-- [M] 사업부 간 품목코드 매핑 (1-3 SCN-28: 매핑 없으면 사업부 간 이동입고 차단,
--     3-3 APP-15). item_external_code는 외부 시스템·거래처용이므로 별도 관리.
CREATE TABLE mdm.item_bu_item_map (
    item_bu_item_map_id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    from_business_unit_id  bigint NOT NULL REFERENCES mdm.business_unit(business_unit_id),
    from_item_id           bigint NOT NULL REFERENCES mdm.item(item_id),
    to_business_unit_id    bigint NOT NULL REFERENCES mdm.business_unit(business_unit_id),
    to_item_id             bigint NOT NULL REFERENCES mdm.item(item_id),
    effective_from         date NOT NULL,
    effective_to           date,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    CONSTRAINT uq_item_bu_item_map
        UNIQUE (from_business_unit_id, from_item_id, to_business_unit_id, effective_from),
    CONSTRAINT ck_item_bu_map_dates
        CHECK (effective_to IS NULL OR effective_to >= effective_from),
    CONSTRAINT ck_item_bu_map_distinct
        CHECK (from_business_unit_id <> to_business_unit_id)
);

CREATE TABLE mdm.process (
    process_id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    process_code        app.code_t NOT NULL UNIQUE,
    process_name        app.name_t NOT NULL,
    process_type_code   app.code_t NOT NULL,
    is_active           boolean NOT NULL DEFAULT true,
    created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by          bigint,
    updated_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by          bigint,
    version_no          integer NOT NULL DEFAULT 1 CHECK (version_no > 0)
);

CREATE TABLE mdm.equipment (
    equipment_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    plant_id            bigint NOT NULL REFERENCES mdm.plant(plant_id),
    equipment_code      app.code_t NOT NULL,
    equipment_name      app.name_t NOT NULL,
    equipment_type_code app.code_t NOT NULL,
    process_id          bigint REFERENCES mdm.process(process_id),
    production_line_id  bigint REFERENCES mdm.production_line(production_line_id), -- [H-4] 소속 라인 (1-1 §1)
    status_code         app.code_t NOT NULL,
    calibration_required  boolean NOT NULL DEFAULT false,  -- [M] 검사장비 교정관리 (2-6 §7.1 P1)
    last_calibration_date date,
    calibration_due_date  date,
    is_active           boolean NOT NULL DEFAULT true,
    created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by          bigint,
    updated_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by          bigint,
    version_no          integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT uq_equipment UNIQUE (plant_id, equipment_code)
);

CREATE TABLE mdm.mold (
    mold_id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    plant_id               bigint NOT NULL REFERENCES mdm.plant(plant_id),
    mold_code              app.code_t NOT NULL,
    mold_name              app.name_t NOT NULL,
    cavity_count           integer NOT NULL DEFAULT 1 CHECK (cavity_count > 0),
    guaranteed_shot_count  bigint CHECK (guaranteed_shot_count IS NULL OR guaranteed_shot_count >= 0),
    current_shot_count     bigint NOT NULL DEFAULT 0 CHECK (current_shot_count >= 0),
    status_code            app.code_t NOT NULL,
    is_active              boolean NOT NULL DEFAULT true,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    updated_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by             bigint,
    version_no             integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT uq_mold UNIQUE (plant_id, mold_code)
);

CREATE TABLE mdm.worker (
    worker_id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    worker_no            app.code_t NOT NULL UNIQUE,
    worker_name          app.name_t NOT NULL,
    business_unit_id     bigint NOT NULL REFERENCES mdm.business_unit(business_unit_id),
    plant_id             bigint NOT NULL REFERENCES mdm.plant(plant_id),
    department_id        bigint REFERENCES mdm.department(department_id),   -- [H-1]
    app_user_id          bigint REFERENCES app.app_user(app_user_id),       -- [H-1] 작업자↔입력자 구분 (3-1 §5.10)
    status_code          app.code_t NOT NULL,
    is_active            boolean NOT NULL DEFAULT true,
    created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by           bigint,
    updated_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by           bigint,
    version_no           integer NOT NULL DEFAULT 1 CHECK (version_no > 0)
);

-- [M] 작업자 자격·인증: 공정 수행 자격(2-1 FR-WO-009/022), 검사자 자격(2-4 FR-QM-014,
--     NFR-QM-008 자격 만료 시 확정 제한, 1-3 SCN-05·21)
CREATE TABLE mdm.worker_qualification (
    worker_qualification_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    worker_id            bigint NOT NULL REFERENCES mdm.worker(worker_id),
    qualification_type_code app.code_t NOT NULL,
    process_id           bigint REFERENCES mdm.process(process_id),
    certificate_no       varchar(100),
    valid_from           date NOT NULL,
    valid_to             date,
    certified_by         bigint,
    created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by           bigint,
    CONSTRAINT ck_worker_qualification_dates
        CHECK (valid_to IS NULL OR valid_to >= valid_from)
);

CREATE UNIQUE INDEX uq_worker_qualification
ON mdm.worker_qualification (
    worker_id,
    qualification_type_code,
    COALESCE(process_id, 0),
    valid_from
);

CREATE TABLE mdm.shift (
    shift_id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    plant_id             bigint NOT NULL REFERENCES mdm.plant(plant_id),
    shift_code           app.code_t NOT NULL,
    shift_name           app.name_t NOT NULL,
    start_time           time NOT NULL,
    end_time             time NOT NULL,
    crosses_midnight     boolean NOT NULL DEFAULT false,
    is_active            boolean NOT NULL DEFAULT true,
    created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by           bigint,
    updated_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by           bigint,
    version_no           integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT uq_shift UNIQUE (plant_id, shift_code)
);

CREATE TABLE mdm.terminal (
    terminal_id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    terminal_code        app.code_t NOT NULL UNIQUE,
    plant_id             bigint NOT NULL REFERENCES mdm.plant(plant_id),
    location_id          bigint REFERENCES mdm.location(location_id),
    terminal_type_code   app.code_t NOT NULL,
    status_code          app.code_t NOT NULL,
    is_active            boolean NOT NULL DEFAULT true,
    created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by           bigint,
    updated_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by           bigint,
    version_no           integer NOT NULL DEFAULT 1 CHECK (version_no > 0)
);

CREATE TABLE mdm.terminal_process (
    terminal_process_id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    terminal_id            bigint NOT NULL REFERENCES mdm.terminal(terminal_id),
    process_id             bigint NOT NULL REFERENCES mdm.process(process_id),
    can_input_material     boolean NOT NULL DEFAULT false,
    can_input_result       boolean NOT NULL DEFAULT false,
    can_input_inspection   boolean NOT NULL DEFAULT false,
    can_print_label        boolean NOT NULL DEFAULT false,
    can_start_work         boolean NOT NULL DEFAULT false,  -- [L] 2-1 FR-WO-024
    can_complete_work      boolean NOT NULL DEFAULT false,  -- [L] 2-1 FR-WO-024
    can_cancel_input       boolean NOT NULL DEFAULT false,  -- [L] 2-2 FR-MI-017, 2-3 FR-PR-003
    can_return_material    boolean NOT NULL DEFAULT false,  -- [L] 2-2 FR-MI-017
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    CONSTRAINT uq_terminal_process UNIQUE (terminal_id, process_id)
);

-- --------------------------------------------------------------------------
-- 5. BOM / Routing
-- --------------------------------------------------------------------------
CREATE TABLE planning.bom (
    bom_id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    parent_item_id      bigint NOT NULL REFERENCES mdm.item(item_id),
    bom_code            app.code_t NOT NULL,
    bom_version         integer NOT NULL CHECK (bom_version > 0),
    status_code         app.code_t NOT NULL,
    is_default          boolean NOT NULL DEFAULT false,
                        -- [E-6] 동일 기간 활성 BOM 복수 시 계획 생성 기본값
                        --       (ERPNext bom.is_default 벤치마킹, 품목당 1개 부분 유니크)
    effective_from      date NOT NULL,
    effective_to        date,
    base_qty            app.qty_t NOT NULL CHECK (base_qty > 0),
    base_uom_id         bigint NOT NULL REFERENCES mdm.uom(uom_id),
    created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by          bigint,
    updated_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by          bigint,
    version_no          integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT uq_bom UNIQUE (parent_item_id, bom_code, bom_version),
    CONSTRAINT ck_bom_dates
        CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

-- [E-6] 품목당 기본 BOM은 1개만
CREATE UNIQUE INDEX uq_bom_default
ON planning.bom (parent_item_id)
WHERE is_default;

CREATE TABLE planning.routing (
    routing_id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    item_id             bigint NOT NULL REFERENCES mdm.item(item_id),
    routing_code        app.code_t NOT NULL,
    routing_version     integer NOT NULL CHECK (routing_version > 0),
    status_code         app.code_t NOT NULL,
    effective_from      date NOT NULL,
    effective_to        date,
    created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by          bigint,
    updated_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by          bigint,
    version_no          integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT uq_routing UNIQUE (item_id, routing_code, routing_version),
    CONSTRAINT ck_routing_dates
        CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE TABLE planning.routing_operation (
    routing_operation_id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    routing_id                 bigint NOT NULL REFERENCES planning.routing(routing_id),
    operation_seq              integer NOT NULL CHECK (operation_seq > 0),
    process_id                 bigint NOT NULL REFERENCES mdm.process(process_id),
    operation_name             app.name_t NOT NULL,
    mes_managed                boolean NOT NULL DEFAULT true,
    material_input_managed     boolean NOT NULL DEFAULT false,
    production_result_managed  boolean NOT NULL DEFAULT true,
    inspection_managed         boolean NOT NULL DEFAULT false,
    output_lot_required        boolean NOT NULL DEFAULT false,
    equipment_required         boolean NOT NULL DEFAULT false,
    mold_required              boolean NOT NULL DEFAULT false,
    standard_cycle_time_sec     numeric(18, 6)
                                CHECK (standard_cycle_time_sec IS NULL OR standard_cycle_time_sec > 0),
    standard_yield_rate        numeric(9, 6)                    -- [L] 공정 수율 (2-1 FR-WO-012)
                               CHECK (standard_yield_rate IS NULL OR standard_yield_rate BETWEEN 0 AND 1),
    created_at                 timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by                 bigint,
    updated_at                 timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by                 bigint,
    version_no                 integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT uq_routing_operation UNIQUE (routing_id, operation_seq)
);

CREATE TABLE planning.routing_operation_dependency (
    routing_operation_dependency_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    predecessor_operation_id        bigint NOT NULL
                                    REFERENCES planning.routing_operation(routing_operation_id),
    successor_operation_id          bigint NOT NULL
                                    REFERENCES planning.routing_operation(routing_operation_id),
    dependency_type_code            app.code_t NOT NULL DEFAULT 'FINISH_TO_START',
    -- [과함 제거] required_completion_rate: 문서의 부분 진행 통제는 전부 수량 기준
    -- (2-1 FR-WO-019/020)이므로 완료율 컬럼을 v2에서 삭제.
    created_at                      timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by                      bigint,
    CONSTRAINT uq_routing_dependency
        UNIQUE (predecessor_operation_id, successor_operation_id),
    CONSTRAINT ck_routing_dependency_self
        CHECK (predecessor_operation_id <> successor_operation_id)
);

CREATE TABLE planning.bom_component (
    bom_component_id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    bom_id                 bigint NOT NULL REFERENCES planning.bom(bom_id),
    component_item_id      bigint NOT NULL REFERENCES mdm.item(item_id),
    routing_operation_id   bigint REFERENCES planning.routing_operation(routing_operation_id),
    actual_use_process_id  bigint REFERENCES mdm.process(process_id),
                           -- [M] 실제 사용 공정. routing_operation_id는 MES 등록(관리) 공정,
                           --     이 컬럼은 실물이 소비되는 공정 (2-2 FR-MI-003, BR-MI-002)
    required_qty           app.qty_t NOT NULL CHECK (required_qty > 0),
    uom_id                 bigint NOT NULL REFERENCES mdm.uom(uom_id),
    scrap_rate             numeric(9, 6) NOT NULL DEFAULT 0 CHECK (scrap_rate BETWEEN 0 AND 1),
    is_mandatory           boolean NOT NULL DEFAULT true,
    lot_trace_required     boolean NOT NULL DEFAULT false,
    backflush_allowed      boolean NOT NULL DEFAULT false,
    sequence_no            integer NOT NULL DEFAULT 1 CHECK (sequence_no > 0),
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    updated_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by             bigint,
    version_no             integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT uq_bom_component UNIQUE (bom_id, sequence_no)
);

CREATE TABLE planning.material_substitution_rule (
    substitution_rule_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    bom_component_id         bigint NOT NULL REFERENCES planning.bom_component(bom_component_id),
    substitute_item_id       bigint NOT NULL REFERENCES mdm.item(item_id),
    priority_no              integer NOT NULL DEFAULT 1 CHECK (priority_no > 0),
    max_substitute_qty       app.qty_t,
    approval_required        boolean NOT NULL DEFAULT true,
    customer_restriction_id  bigint REFERENCES mdm.partner(partner_id),
    effective_from           date NOT NULL,
    effective_to             date,
    created_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by               bigint,
    CONSTRAINT ck_substitution_dates
        CHECK (effective_to IS NULL OR effective_to >= effective_from),
    CONSTRAINT uq_substitution_rule
        UNIQUE (bom_component_id, substitute_item_id, effective_from)
);

-- --------------------------------------------------------------------------
-- 6. Production order / plan / work order
-- --------------------------------------------------------------------------
CREATE TABLE planning.production_order (
    production_order_id  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    production_order_no  app.business_no_t NOT NULL UNIQUE,
    erp_order_no         varchar(100),
    parent_production_order_id bigint
                         REFERENCES planning.production_order(production_order_id),
                         -- [E-2] 반제품 오더의 상위(완제품) 오더 연결.
                         --       완제품 취소·수량 변경 시 연동 대상 식별
                         --       (ERPNext production_plan_sub_assembly_item 벤치마킹)
    bom_level            smallint NOT NULL DEFAULT 0 CHECK (bom_level >= 0),
                         -- [E-2] BOM 전개 단계 (0 = 최상위 완제품)
    business_unit_id     bigint NOT NULL REFERENCES mdm.business_unit(business_unit_id),
    plant_id             bigint NOT NULL REFERENCES mdm.plant(plant_id),
    item_id              bigint NOT NULL REFERENCES mdm.item(item_id),
    order_qty            app.qty_t NOT NULL CHECK (order_qty > 0),
    uom_id               bigint NOT NULL REFERENCES mdm.uom(uom_id),
    due_date             date,
    status_code          app.code_t NOT NULL,
    remarks              text,                                     -- [M] 공통 비고 복원 (3-2 §2.2)
    created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by           bigint,
    updated_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by           bigint,
    version_no           integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT ck_production_order_parent
        CHECK (parent_production_order_id IS NULL
               OR parent_production_order_id <> production_order_id)
);

CREATE TABLE planning.production_plan (
    production_plan_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    production_order_id  bigint NOT NULL
                         REFERENCES planning.production_order(production_order_id),
    plan_no              app.business_no_t NOT NULL UNIQUE,
    plan_date            date NOT NULL,
    planned_qty          app.qty_t NOT NULL CHECK (planned_qty > 0),
    uom_id               bigint NOT NULL REFERENCES mdm.uom(uom_id),
    bom_id               bigint NOT NULL REFERENCES planning.bom(bom_id),
    routing_id           bigint NOT NULL REFERENCES planning.routing(routing_id),
    planned_line_id      bigint REFERENCES mdm.production_line(production_line_id),
                         -- [H-4] 논리 모델 §9.2에서 탈락했던 컬럼 복원
    status_code          app.code_t NOT NULL,
    confirmed_at         timestamptz,
    confirmed_by         bigint,
    remarks              text,
    created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by           bigint,
    updated_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by           bigint,
    version_no           integer NOT NULL DEFAULT 1 CHECK (version_no > 0)
);

CREATE TABLE production.work_order (
    work_order_id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    work_order_no          app.business_no_t NOT NULL UNIQUE,
    production_plan_id     bigint NOT NULL
                           REFERENCES planning.production_plan(production_plan_id),
    routing_operation_id   bigint NOT NULL
                           REFERENCES planning.routing_operation(routing_operation_id),
    item_id                bigint NOT NULL REFERENCES mdm.item(item_id),
    order_qty              app.qty_t NOT NULL CHECK (order_qty > 0),
    uom_id                 bigint NOT NULL REFERENCES mdm.uom(uom_id),
    work_order_type_code   app.code_t NOT NULL DEFAULT 'NORMAL',
    parent_work_order_id   bigint REFERENCES production.work_order(work_order_id),
                           -- [H-5] 분할 원본 지시 (2-1 FR-WO-013/032, BR-WO-005)
    rework_source_work_order_id bigint REFERENCES production.work_order(work_order_id),
                           -- [H-5] 재작업 원본 지시 (2-1 FR-WO-039, 1-3 SCN-13)
    rework_source_lot_id   bigint,      -- [H-5] 재작업 원본 생산 LOT (late FK -> trace.lot)
    rework_source_nonconformance_id bigint, -- [H-5] 재작업 근거 부적합 (late FK -> quality.nonconformance)
    production_line_id     bigint REFERENCES mdm.production_line(production_line_id),
                           -- [H-4] 배정 라인·작업구역 (2-1 FR-WO-006/014)
    responsible_worker_id  bigint REFERENCES mdm.worker(worker_id),
                           -- [L] 책임 작업자 (2-1 FR-WO-014/016)
    planned_start_at       timestamptz,
    planned_end_at         timestamptz,
    planned_equipment_id   bigint REFERENCES mdm.equipment(equipment_id),
    planned_mold_id        bigint REFERENCES mdm.mold(mold_id),
    planned_shift_id       bigint REFERENCES mdm.shift(shift_id),
    priority_no            integer NOT NULL DEFAULT 100,
    default_wip_location_id    bigint REFERENCES mdm.location(location_id),
    default_fg_location_id     bigint REFERENCES mdm.location(location_id),
    default_scrap_location_id  bigint REFERENCES mdm.location(location_id),
                           -- [E-3] 재공품·완성품·스크랩 기본 위치. 강제가 아니라
                           --       현장 단말 기본값 제시·오입고 검증용
                           --       (ERPNext work_order.wip/fg/scrap_warehouse 벤치마킹)
    operation_settings_snapshot jsonb,
                           -- [M] 생성 당시 라우팅 공정설정 스냅샷 (2-1 FR-WO-005):
                           --     기준정보 in-place 변경이 기존 지시에 소급되지 않도록 고정
    status_code            app.code_t NOT NULL,
    released_at            timestamptz,
    completed_at           timestamptz,
    completion_variance_reason_code app.code_t,
                           -- [M] 미달·초과 완료 사유 (2-1 FR-WO-032)
    closed_at              timestamptz,
    remarks                text,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    updated_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by             bigint,
    version_no             integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT ck_work_order_plan_dates
        CHECK (planned_end_at IS NULL OR planned_start_at IS NULL OR planned_end_at >= planned_start_at),
    CONSTRAINT ck_work_order_split_self
        CHECK (parent_work_order_id IS NULL OR parent_work_order_id <> work_order_id),
    CONSTRAINT ck_work_order_rework_self
        CHECK (rework_source_work_order_id IS NULL OR rework_source_work_order_id <> work_order_id),
    CONSTRAINT ck_work_order_rework_type
        CHECK (rework_source_work_order_id IS NULL OR work_order_type_code = 'REWORK')
);

CREATE TABLE production.work_order_dependency (
    work_order_dependency_id  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    predecessor_work_order_id bigint NOT NULL
                              REFERENCES production.work_order(work_order_id),
    successor_work_order_id   bigint NOT NULL
                              REFERENCES production.work_order(work_order_id),
    dependency_type_code      app.code_t NOT NULL DEFAULT 'FINISH_TO_START',
    required_qty_rule_code    app.code_t NOT NULL DEFAULT 'AVAILABLE_GOOD_QTY',
    created_at                timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by                bigint,
    CONSTRAINT uq_work_order_dependency
        UNIQUE (predecessor_work_order_id, successor_work_order_id),
    CONSTRAINT ck_work_order_dependency_self
        CHECK (predecessor_work_order_id <> successor_work_order_id)
);

CREATE TABLE production.work_session (
    work_session_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    work_order_id        bigint NOT NULL REFERENCES production.work_order(work_order_id),
    session_no           integer NOT NULL CHECK (session_no > 0),
    shift_id             bigint NOT NULL REFERENCES mdm.shift(shift_id),
    equipment_id         bigint REFERENCES mdm.equipment(equipment_id),
    mold_id              bigint REFERENCES mdm.mold(mold_id),
    terminal_id          bigint NOT NULL REFERENCES mdm.terminal(terminal_id),
    started_at           timestamptz NOT NULL,
    ended_at             timestamptz,
    status_code          app.code_t NOT NULL,
    stop_reason_code     app.code_t,
    remarks              text,
    created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by           bigint,
    updated_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by           bigint,
    version_no           integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT uq_work_session UNIQUE (work_order_id, session_no),
    CONSTRAINT ck_work_session_dates
        CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE TABLE production.work_session_worker (
    work_session_worker_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    work_session_id        bigint NOT NULL
                           REFERENCES production.work_session(work_session_id),
    worker_id              bigint NOT NULL REFERENCES mdm.worker(worker_id),
    worker_role_code       app.code_t NOT NULL DEFAULT 'OPERATOR',
    joined_at              timestamptz NOT NULL,
    left_at                timestamptz,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    CONSTRAINT ck_work_session_worker_dates
        CHECK (left_at IS NULL OR left_at >= joined_at)
);

CREATE TABLE production.work_session_event (
    work_session_event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    work_session_id       bigint NOT NULL
                          REFERENCES production.work_session(work_session_id),
    event_type_code       app.code_t NOT NULL,
    occurred_at           timestamptz NOT NULL,
    reason_code           app.code_t,
    performed_by          bigint,
    terminal_id           bigint REFERENCES mdm.terminal(terminal_id),
    created_at            timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- --------------------------------------------------------------------------
-- 7. Purchase / inbound / goods receipt
-- --------------------------------------------------------------------------
CREATE TABLE logistics.purchase_order (
    purchase_order_id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    purchase_order_no       app.business_no_t NOT NULL UNIQUE,
    erp_purchase_order_no   varchar(100),
    supplier_id             bigint NOT NULL REFERENCES mdm.partner(partner_id),
    business_unit_id        bigint NOT NULL REFERENCES mdm.business_unit(business_unit_id),
    plant_id                bigint NOT NULL REFERENCES mdm.plant(plant_id),
    order_date              date NOT NULL,
    expected_receipt_date   date,
    status_code             app.code_t NOT NULL,
    created_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by              bigint,
    updated_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by              bigint,
    version_no              integer NOT NULL DEFAULT 1 CHECK (version_no > 0)
);

CREATE TABLE logistics.purchase_order_line (
    purchase_order_line_id  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    purchase_order_id       bigint NOT NULL
                            REFERENCES logistics.purchase_order(purchase_order_id),
    line_no                 integer NOT NULL CHECK (line_no > 0),
    item_id                 bigint NOT NULL REFERENCES mdm.item(item_id),
    ordered_qty             app.qty_t NOT NULL CHECK (ordered_qty > 0),
    uom_id                  bigint NOT NULL REFERENCES mdm.uom(uom_id),
    received_qty            app.qty_t NOT NULL DEFAULT 0,
    tolerance_over_qty      app.qty_t NOT NULL DEFAULT 0,
    tolerance_under_qty     app.qty_t NOT NULL DEFAULT 0,
    created_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by              bigint,
    updated_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by              bigint,
    version_no              integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT uq_purchase_order_line UNIQUE (purchase_order_id, line_no),
    CONSTRAINT ck_po_line_received CHECK (
        received_qty <= ordered_qty + tolerance_over_qty
    )
);

-- [M] 입하예정(ASN): 건 단위 납품예정 관리 (2-7 FR-IM-001/009, 상태흐름 "입하예정")
CREATE TABLE logistics.asn (
    asn_id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    asn_no                app.business_no_t NOT NULL UNIQUE,
    supplier_id           bigint NOT NULL REFERENCES mdm.partner(partner_id),
    plant_id              bigint NOT NULL REFERENCES mdm.plant(plant_id),
    expected_arrival_date date NOT NULL,
    delivery_note_no      varchar(100),
    status_code           app.code_t NOT NULL,
    remarks               text,
    created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by            bigint,
    updated_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by            bigint,
    version_no            integer NOT NULL DEFAULT 1 CHECK (version_no > 0)
);

CREATE TABLE logistics.asn_line (
    asn_line_id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    asn_id                bigint NOT NULL REFERENCES logistics.asn(asn_id),
    line_no               integer NOT NULL CHECK (line_no > 0),
    purchase_order_line_id bigint
                          REFERENCES logistics.purchase_order_line(purchase_order_line_id),
    item_id               bigint NOT NULL REFERENCES mdm.item(item_id),
    expected_qty          app.qty_t NOT NULL CHECK (expected_qty > 0),
    uom_id                bigint NOT NULL REFERENCES mdm.uom(uom_id),
    supplier_lot_no       varchar(100),
    created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by            bigint,
    CONSTRAINT uq_asn_line UNIQUE (asn_id, line_no)
);

CREATE TABLE logistics.inbound_receipt (
    inbound_receipt_id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    inbound_receipt_no    app.business_no_t NOT NULL UNIQUE,
    supplier_id           bigint NOT NULL REFERENCES mdm.partner(partner_id),
    plant_id              bigint NOT NULL REFERENCES mdm.plant(plant_id),
    receipt_datetime      timestamptz NOT NULL,
    delivery_note_no      varchar(100),
    vehicle_no            varchar(50),
    dock_location_id      bigint REFERENCES mdm.location(location_id),
                          -- [L] 입하장(도크) (2-7 FR-IM-002)
    exception_type_code   app.code_t,        -- [L] P/O 없는 예외입하 유형 (1-3 SCN-20, FR-IM-007)
    exception_reason      text,
    approval_request_id   bigint,            -- [L] 예외입하 승인 (late FK -> app.approval_request)
    status_code           app.code_t NOT NULL,
    received_by           bigint,
    remarks               text,
    created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by            bigint,
    updated_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by            bigint,
    version_no            integer NOT NULL DEFAULT 1 CHECK (version_no > 0)
);

CREATE TABLE logistics.inbound_receipt_line (
    inbound_receipt_line_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    inbound_receipt_id      bigint NOT NULL
                            REFERENCES logistics.inbound_receipt(inbound_receipt_id),
    line_no                 integer NOT NULL CHECK (line_no > 0),
    purchase_order_line_id  bigint
                            REFERENCES logistics.purchase_order_line(purchase_order_line_id),
    asn_line_id             bigint REFERENCES logistics.asn_line(asn_line_id),  -- [M] 입하예정 근거
    item_id                 bigint NOT NULL REFERENCES mdm.item(item_id),
    received_qty            app.qty_t NOT NULL CHECK (received_qty > 0),
    uom_id                  bigint NOT NULL REFERENCES mdm.uom(uom_id),
    package_count           integer CHECK (package_count IS NULL OR package_count > 0),
                            -- [L] 포장수량 (2-7 FR-IM-002)
    supplier_lot_no         varchar(100),
    supplier_lot_missing    boolean NOT NULL DEFAULT false,
                            -- [L] 공급사 LOT 미제공 → 대체 LOT 생성 기록 (2-7 FR-IM-008)
    substitute_lot_reason_code app.code_t,
    manufactured_date       date,
    expiry_date             date,
    inspection_required     boolean NOT NULL,
    status_code             app.code_t NOT NULL,
    created_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by              bigint,
    updated_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by              bigint,
    version_no              integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT uq_inbound_receipt_line UNIQUE (inbound_receipt_id, line_no),
    CONSTRAINT ck_inbound_expiry CHECK (
        expiry_date IS NULL OR manufactured_date IS NULL OR expiry_date >= manufactured_date
    )
);

CREATE TABLE logistics.inbound_variance (
    inbound_variance_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    inbound_receipt_line_id  bigint NOT NULL
                             REFERENCES logistics.inbound_receipt_line(inbound_receipt_line_id),
    variance_type_code       app.code_t NOT NULL,
    variance_qty             app.qty_t NOT NULL CHECK (variance_qty > 0),
    uom_id                   bigint NOT NULL REFERENCES mdm.uom(uom_id),
    reason_code              app.code_t NOT NULL,
    approval_request_id      bigint,
    created_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by               bigint
);

-- --------------------------------------------------------------------------
-- 8. Lot / inventory
-- --------------------------------------------------------------------------
CREATE TABLE trace.lot (
    lot_id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    lot_no                app.business_no_t NOT NULL,
    item_id               bigint NOT NULL REFERENCES mdm.item(item_id),
    lot_type_code         app.code_t NOT NULL,
    plant_id              bigint NOT NULL REFERENCES mdm.plant(plant_id),
    initial_qty           app.qty_t NOT NULL CHECK (initial_qty > 0),
    uom_id                bigint NOT NULL REFERENCES mdm.uom(uom_id),
    manufactured_at       timestamptz,
    expiry_date           date,
    source_type_code      app.code_t NOT NULL,
    source_id             bigint NOT NULL,
    status_code           app.code_t NOT NULL DEFAULT 'ACTIVE',
    parent_lot_id         bigint REFERENCES trace.lot(lot_id),
                          -- [M] 표시용 비정규화. 계보의 원천은 trace.lot_relation이며
                          --     본 컬럼은 단순 분할 조회 편의용 (2-5 FR-LT-053, 2-6 §8.2)
    remarks               text,
    created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by            bigint,
    updated_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by            bigint,
    version_no            integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT uq_lot UNIQUE (plant_id, lot_no),
    CONSTRAINT ck_lot_parent CHECK (parent_lot_id IS NULL OR parent_lot_id <> lot_id)
);

CREATE TABLE trace.lot_external_identifier (
    lot_external_identifier_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    lot_id                      bigint NOT NULL REFERENCES trace.lot(lot_id),
    identifier_type_code        app.code_t NOT NULL,
    external_identifier         varchar(150) NOT NULL,
    partner_id                  bigint REFERENCES mdm.partner(partner_id),
    external_system_code        app.code_t,
    created_at                  timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by                  bigint
);

CREATE UNIQUE INDEX uq_lot_external_identifier
ON trace.lot_external_identifier (
    lot_id,
    identifier_type_code,
    COALESCE(partner_id, 0),
    COALESCE(external_system_code, ''),
    external_identifier
);

CREATE TABLE inventory.inventory_balance (
    inventory_balance_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    legal_entity_id          bigint NOT NULL REFERENCES mdm.legal_entity(legal_entity_id),
    business_unit_id         bigint NOT NULL REFERENCES mdm.business_unit(business_unit_id),
    plant_id                 bigint NOT NULL REFERENCES mdm.plant(plant_id),
    warehouse_id             bigint NOT NULL REFERENCES mdm.warehouse(warehouse_id),
    location_id              bigint NOT NULL REFERENCES mdm.location(location_id),
    item_id                  bigint NOT NULL REFERENCES mdm.item(item_id),
    lot_id                   bigint REFERENCES trace.lot(lot_id),
    quality_status_code      app.code_t NOT NULL,
    inventory_status_code    app.code_t NOT NULL,
    ownership_type_code      app.code_t NOT NULL,
    owner_partner_id         bigint REFERENCES mdm.partner(partner_id),
    -- [H-2] on_hand_qty를 signed 도메인으로 변경. 음수 허용 여부는
    --       item.negative_stock_allowed 기준으로 constraint trigger가 검증한다
    --       (섹션 20.5 trg_inventory_balance_qty 참조. 2-2 FR-MI-025, 2-7 NFR-IM-016)
    on_hand_qty              app.signed_qty_t NOT NULL DEFAULT 0,
    reserved_qty             app.qty_t NOT NULL DEFAULT 0,
    picked_qty               app.qty_t NOT NULL DEFAULT 0,
    blocked_qty              app.qty_t NOT NULL DEFAULT 0,
    available_qty            numeric(20, 6)
                             GENERATED ALWAYS AS
                             (on_hand_qty - reserved_qty - picked_qty - blocked_qty) STORED,
    uom_id                   bigint NOT NULL REFERENCES mdm.uom(uom_id),
    last_transaction_at      timestamptz,
    created_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
    version_no               integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT ck_inventory_balance_lot_item CHECK (
        lot_id IS NULL OR item_id IS NOT NULL
    )
);

CREATE UNIQUE INDEX uq_inventory_balance_dim
ON inventory.inventory_balance (
    legal_entity_id,
    business_unit_id,
    plant_id,
    warehouse_id,
    location_id,
    item_id,
    COALESCE(lot_id, 0),
    quality_status_code,
    inventory_status_code,
    ownership_type_code,
    COALESCE(owner_partner_id, 0)
);

CREATE TABLE inventory.inventory_transaction (
    inventory_transaction_id bigint GENERATED ALWAYS AS IDENTITY,
    business_date            date NOT NULL,
    transaction_no           app.business_no_t NOT NULL,
    transaction_type_code    app.code_t NOT NULL,
    plant_id                 bigint NOT NULL REFERENCES mdm.plant(plant_id),
    occurred_at              timestamptz NOT NULL,
    recorded_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
    source_document_type_code app.code_t NOT NULL,
    source_document_id       bigint NOT NULL,
    status_code              app.code_t NOT NULL,
    idempotency_key          varchar(150) NOT NULL,
    -- [M] 취소(역처리) 원본 참조: 복합 PK(id, business_date)에 맞춰
    --     business_date를 추가해 FK를 성립시킨다 (3-3 DB-C20, 2-7 FR-IM-080)
    reversal_of_transaction_id bigint,
    reversal_of_business_date  date,
    created_by               bigint,
    PRIMARY KEY (inventory_transaction_id, business_date),
    CONSTRAINT uq_inventory_transaction_no UNIQUE (transaction_no, business_date),
    CONSTRAINT uq_inventory_idempotency UNIQUE (idempotency_key, business_date),
    CONSTRAINT ck_inventory_reversal_pair CHECK (
        (reversal_of_transaction_id IS NULL) = (reversal_of_business_date IS NULL)
    ),
    CONSTRAINT fk_inventory_transaction_reversal
        FOREIGN KEY (reversal_of_transaction_id, reversal_of_business_date)
        REFERENCES inventory.inventory_transaction(inventory_transaction_id, business_date)
) PARTITION BY RANGE (business_date);

CREATE TABLE inventory.inventory_transaction_default
PARTITION OF inventory.inventory_transaction DEFAULT;

CREATE TABLE inventory.inventory_transaction_line (
    inventory_transaction_line_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    inventory_transaction_id      bigint NOT NULL,
    business_date                 date NOT NULL,
    line_no                       integer NOT NULL CHECK (line_no > 0),
    item_id                       bigint NOT NULL REFERENCES mdm.item(item_id),
    lot_id                        bigint REFERENCES trace.lot(lot_id),
    qty                           app.qty_t NOT NULL CHECK (qty > 0),
    uom_id                        bigint NOT NULL REFERENCES mdm.uom(uom_id),
    from_warehouse_id             bigint REFERENCES mdm.warehouse(warehouse_id),
    from_location_id              bigint REFERENCES mdm.location(location_id),
    from_quality_status_code      app.code_t,
    from_inventory_status_code    app.code_t,
    to_warehouse_id               bigint REFERENCES mdm.warehouse(warehouse_id),
    to_location_id                bigint REFERENCES mdm.location(location_id),
    to_quality_status_code        app.code_t,
    to_inventory_status_code      app.code_t,
    ownership_type_code           app.code_t NOT NULL,
    owner_partner_id              bigint REFERENCES mdm.partner(partner_id),
    handling_unit_id              bigint,
    from_qty_after_transaction    numeric(20, 6),
    to_qty_after_transaction      numeric(20, 6),
                                  -- [E-5] 트랜잭션 직후 해당 잔액 차원의 on_hand 스냅샷.
                                  --       posting 함수가 잔액 갱신과 동시에 기록하며,
                                  --       시점 재고 조회(2-5 FR-LT-059)·감사 대사를
                                  --       원장 재합산 없이 수행하기 위한 컬럼
                                  --       (ERPNext stock_ledger_entry.qty_after_transaction)
    created_at                    timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by                    bigint,
    CONSTRAINT fk_inventory_transaction_line_header
        FOREIGN KEY (inventory_transaction_id, business_date)
        REFERENCES inventory.inventory_transaction(inventory_transaction_id, business_date),
    CONSTRAINT uq_inventory_transaction_line
        UNIQUE (inventory_transaction_id, business_date, line_no),
    CONSTRAINT ck_inventory_transaction_direction CHECK (
        (from_location_id IS NOT NULL) OR (to_location_id IS NOT NULL)
    )
);

CREATE TABLE inventory.inventory_reservation (
    inventory_reservation_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    reservation_no           app.business_no_t NOT NULL UNIQUE,
    reservation_type_code    app.code_t NOT NULL,
    source_document_type_code app.code_t NOT NULL,
    source_document_id       bigint NOT NULL,
    item_id                  bigint NOT NULL REFERENCES mdm.item(item_id),
    lot_id                   bigint REFERENCES trace.lot(lot_id),
    warehouse_id             bigint NOT NULL REFERENCES mdm.warehouse(warehouse_id),
    location_id              bigint REFERENCES mdm.location(location_id),
    reserved_qty             app.qty_t NOT NULL CHECK (reserved_qty > 0),
    released_qty             app.qty_t NOT NULL DEFAULT 0,
    consumed_qty             app.qty_t NOT NULL DEFAULT 0,
    uom_id                   bigint NOT NULL REFERENCES mdm.uom(uom_id),
    status_code              app.code_t NOT NULL,
    created_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by               bigint,
    updated_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by               bigint,
    version_no               integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT ck_reservation_qty CHECK (
        released_qty + consumed_qty <= reserved_qty
    )
);

-- --------------------------------------------------------------------------
-- 9. Handling units
-- --------------------------------------------------------------------------
CREATE TABLE inventory.handling_unit (
    handling_unit_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    handling_unit_no        app.business_no_t NOT NULL UNIQUE,
    handling_unit_type_code app.code_t NOT NULL,
    parent_handling_unit_id bigint REFERENCES inventory.handling_unit(handling_unit_id),
    warehouse_id            bigint REFERENCES mdm.warehouse(warehouse_id),
    location_id             bigint REFERENCES mdm.location(location_id),
    status_code             app.code_t NOT NULL,
    created_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by              bigint,
    updated_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by              bigint,
    version_no              integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT ck_handling_unit_parent
        CHECK (parent_handling_unit_id IS NULL OR parent_handling_unit_id <> handling_unit_id)
);

ALTER TABLE inventory.inventory_transaction_line
ADD CONSTRAINT fk_inventory_transaction_line_hu
FOREIGN KEY (handling_unit_id)
REFERENCES inventory.handling_unit(handling_unit_id);

CREATE TABLE inventory.handling_unit_content (
    handling_unit_content_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    handling_unit_id         bigint NOT NULL
                             REFERENCES inventory.handling_unit(handling_unit_id),
    item_id                  bigint NOT NULL REFERENCES mdm.item(item_id),
    lot_id                   bigint NOT NULL REFERENCES trace.lot(lot_id),
    qty                      app.qty_t NOT NULL CHECK (qty > 0),
    uom_id                   bigint NOT NULL REFERENCES mdm.uom(uom_id),
    created_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by               bigint,
    CONSTRAINT uq_handling_unit_content
        UNIQUE (handling_unit_id, item_id, lot_id)
);

-- --------------------------------------------------------------------------
-- 10. Goods receipt / issue / picking / shopfloor receipt
-- --------------------------------------------------------------------------
CREATE TABLE logistics.goods_receipt (
    goods_receipt_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    goods_receipt_no        app.business_no_t NOT NULL UNIQUE,
    receipt_type_code       app.code_t NOT NULL,
    plant_id                bigint NOT NULL REFERENCES mdm.plant(plant_id),
    warehouse_id            bigint NOT NULL REFERENCES mdm.warehouse(warehouse_id),
    receipt_datetime        timestamptz NOT NULL,
    status_code             app.code_t NOT NULL,
    source_document_type_code app.code_t NOT NULL,
    source_document_id      bigint NOT NULL,
    reason_code             app.code_t,       -- [M] 반품입고 등 사유 (2-7 FR-IM-068)
    remarks                 text,
    created_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by              bigint,
    updated_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by              bigint,
    version_no              integer NOT NULL DEFAULT 1 CHECK (version_no > 0)
);

CREATE TABLE logistics.goods_receipt_line (
    goods_receipt_line_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    goods_receipt_id          bigint NOT NULL
                              REFERENCES logistics.goods_receipt(goods_receipt_id),
    line_no                   integer NOT NULL CHECK (line_no > 0),
    inbound_receipt_line_id   bigint
                              REFERENCES logistics.inbound_receipt_line(inbound_receipt_line_id),
    item_id                   bigint NOT NULL REFERENCES mdm.item(item_id),
    lot_id                    bigint NOT NULL REFERENCES trace.lot(lot_id),
    receipt_qty               app.qty_t NOT NULL CHECK (receipt_qty > 0),
    uom_id                    bigint NOT NULL REFERENCES mdm.uom(uom_id),
    quality_status_code       app.code_t NOT NULL,
    inventory_status_code     app.code_t NOT NULL,
    destination_location_id   bigint NOT NULL REFERENCES mdm.location(location_id),
    original_shipment_lot_allocation_id bigint,
                              -- [M] 고객반품 시 원 출하 LOT 연결 (2-7 FR-IM-068,
                              --     late FK -> logistics.shipment_lot_allocation)
    inventory_transaction_line_id bigint
                                   REFERENCES inventory.inventory_transaction_line(inventory_transaction_line_id),
    created_at                timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by                bigint,
    CONSTRAINT uq_goods_receipt_line UNIQUE (goods_receipt_id, line_no)
);

-- [E-1] 적치 규칙 마스터: 권장 로케이션 산출의 근거 데이터
--       (2-7 FR-IM-020 "권장 도착위치 제시"; ERPNext putaway_rule 벤치마킹).
--       품목 × 로케이션(또는 창고) 단위 수용량·우선순위 규칙.
--       location.storage_condition_code / allow_mixed_* 와 조합하여 적용한다.
CREATE TABLE logistics.putaway_rule (
    putaway_rule_id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    item_id                 bigint NOT NULL REFERENCES mdm.item(item_id),
    warehouse_id            bigint NOT NULL REFERENCES mdm.warehouse(warehouse_id),
    location_id             bigint REFERENCES mdm.location(location_id),
                            -- NULL이면 창고 수준 규칙 (세부 위치는 창고 내 정책으로)
    capacity_qty            app.qty_t NOT NULL CHECK (capacity_qty > 0),
    uom_id                  bigint NOT NULL REFERENCES mdm.uom(uom_id),
    priority_no             integer NOT NULL DEFAULT 100,
    is_active               boolean NOT NULL DEFAULT true,
    remarks                 text,
    created_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by              bigint,
    updated_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by              bigint,
    version_no              integer NOT NULL DEFAULT 1 CHECK (version_no > 0)
);

CREATE UNIQUE INDEX uq_putaway_rule
ON logistics.putaway_rule (
    item_id,
    warehouse_id,
    COALESCE(location_id, 0)
);

-- [H-6] 적치(putaway) 지시: 입고 후 임시 위치 -> 보관 위치 이동 작업
--       (2-7 FR-IM-019~023 P0, 상태흐름 "적치대기", FR-IM-089 미적치 예외조회)
--       분산적치(FR-IM-022)는 같은 입고 Line에 여러 task 행으로 표현한다.
CREATE TABLE logistics.putaway_task (
    putaway_task_id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    putaway_task_no         app.business_no_t NOT NULL UNIQUE,
    goods_receipt_line_id   bigint NOT NULL
                            REFERENCES logistics.goods_receipt_line(goods_receipt_line_id),
    item_id                 bigint NOT NULL REFERENCES mdm.item(item_id),
    lot_id                  bigint NOT NULL REFERENCES trace.lot(lot_id),
    task_qty                app.qty_t NOT NULL CHECK (task_qty > 0),
    uom_id                  bigint NOT NULL REFERENCES mdm.uom(uom_id),
    from_location_id        bigint NOT NULL REFERENCES mdm.location(location_id),
    recommended_location_id bigint REFERENCES mdm.location(location_id),
    applied_putaway_rule_id bigint REFERENCES logistics.putaway_rule(putaway_rule_id),
                            -- [E-1] 권장 위치 산출에 적용된 규칙 역참조
    actual_location_id      bigint REFERENCES mdm.location(location_id),  -- 적치확정 시 기록
    priority_no             integer NOT NULL DEFAULT 100,
    assigned_worker_id      bigint REFERENCES mdm.worker(worker_id),
    status_code             app.code_t NOT NULL,
    completed_at            timestamptz,
    inventory_transaction_line_id bigint
                            REFERENCES inventory.inventory_transaction_line(inventory_transaction_line_id),
    remarks                 text,
    created_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by              bigint,
    updated_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by              bigint,
    version_no              integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT ck_putaway_completed
        CHECK (completed_at IS NULL OR actual_location_id IS NOT NULL)
);

CREATE TABLE logistics.material_issue_request (
    material_issue_request_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    issue_request_no          app.business_no_t NOT NULL UNIQUE,
    work_order_id             bigint NOT NULL REFERENCES production.work_order(work_order_id),
    destination_location_id   bigint NOT NULL REFERENCES mdm.location(location_id),
    required_at               timestamptz,
    status_code               app.code_t NOT NULL,
    requested_by              bigint REFERENCES app.app_user(app_user_id),   -- [H-1]
    remarks                   text,
    created_at                timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by                bigint,
    updated_at                timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by                bigint,
    version_no                integer NOT NULL DEFAULT 1 CHECK (version_no > 0)
);

CREATE TABLE logistics.material_issue_request_line (
    material_issue_request_line_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    material_issue_request_id      bigint NOT NULL
                                   REFERENCES logistics.material_issue_request(material_issue_request_id),
    line_no                        integer NOT NULL CHECK (line_no > 0),
    bom_component_id               bigint REFERENCES planning.bom_component(bom_component_id),
    item_id                        bigint NOT NULL REFERENCES mdm.item(item_id),
    requested_qty                  app.qty_t NOT NULL CHECK (requested_qty > 0),
    issued_qty                     app.qty_t NOT NULL DEFAULT 0,
    uom_id                         bigint NOT NULL REFERENCES mdm.uom(uom_id),
    created_at                     timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by                     bigint,
    CONSTRAINT uq_material_issue_request_line
        UNIQUE (material_issue_request_id, line_no),
    CONSTRAINT ck_material_issue_line_qty
        CHECK (issued_qty <= requested_qty)
);

CREATE TABLE logistics.picking_order (
    picking_order_id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    picking_order_no       app.business_no_t NOT NULL UNIQUE,
    picking_type_code      app.code_t NOT NULL,
    source_document_type_code app.code_t NOT NULL,
    source_document_id     bigint NOT NULL,
    warehouse_id           bigint NOT NULL REFERENCES mdm.warehouse(warehouse_id),
    status_code            app.code_t NOT NULL,
    assigned_worker_id     bigint REFERENCES mdm.worker(worker_id),
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    updated_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by             bigint,
    version_no             integer NOT NULL DEFAULT 1 CHECK (version_no > 0)
);

CREATE TABLE logistics.picking_line (
    picking_line_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    picking_order_id       bigint NOT NULL REFERENCES logistics.picking_order(picking_order_id),
    line_no                integer NOT NULL CHECK (line_no > 0),
    item_id                bigint NOT NULL REFERENCES mdm.item(item_id),
    lot_id                 bigint NOT NULL REFERENCES trace.lot(lot_id),
    location_id            bigint NOT NULL REFERENCES mdm.location(location_id),
    planned_qty            app.qty_t NOT NULL CHECK (planned_qty > 0),
    picked_qty             app.qty_t NOT NULL DEFAULT 0,
    uom_id                 bigint NOT NULL REFERENCES mdm.uom(uom_id),
    inventory_reservation_id bigint REFERENCES inventory.inventory_reservation(inventory_reservation_id),
    status_code            app.code_t NOT NULL,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    updated_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by             bigint,
    version_no             integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT uq_picking_line UNIQUE (picking_order_id, line_no),
    CONSTRAINT ck_picking_qty CHECK (picked_qty <= planned_qty)
);

CREATE TABLE logistics.goods_issue (
    goods_issue_id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    goods_issue_no         app.business_no_t NOT NULL UNIQUE,
    issue_type_code        app.code_t NOT NULL,
    source_document_type_code app.code_t NOT NULL,
    source_document_id     bigint NOT NULL,
    source_warehouse_id    bigint NOT NULL REFERENCES mdm.warehouse(warehouse_id),
    destination_type_code  app.code_t NOT NULL,
    destination_id         bigint NOT NULL,
    issued_at              timestamptz NOT NULL,
    status_code            app.code_t NOT NULL,
    reason_code            app.code_t,        -- [M] 공급사반품·폐기 등 사유 (2-7 FR-IM-067)
    replacement_expected   boolean,           -- [M] 공급사반품 시 대체입고 예정 여부 (FR-IM-067)
    remarks                text,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    updated_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by             bigint,
    version_no             integer NOT NULL DEFAULT 1 CHECK (version_no > 0)
);

CREATE TABLE logistics.goods_issue_line (
    goods_issue_line_id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    goods_issue_id         bigint NOT NULL REFERENCES logistics.goods_issue(goods_issue_id),
    line_no                integer NOT NULL CHECK (line_no > 0),
    picking_line_id        bigint REFERENCES logistics.picking_line(picking_line_id),
    item_id                bigint NOT NULL REFERENCES mdm.item(item_id),
    lot_id                 bigint NOT NULL REFERENCES trace.lot(lot_id),
    issue_qty              app.qty_t NOT NULL CHECK (issue_qty > 0),
    uom_id                 bigint NOT NULL REFERENCES mdm.uom(uom_id),
    source_location_id     bigint NOT NULL REFERENCES mdm.location(location_id),
    inventory_transaction_line_id bigint
                                  REFERENCES inventory.inventory_transaction_line(inventory_transaction_line_id),
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    CONSTRAINT uq_goods_issue_line UNIQUE (goods_issue_id, line_no)
);

CREATE TABLE logistics.shopfloor_receipt (
    shopfloor_receipt_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    shopfloor_receipt_no   app.business_no_t NOT NULL UNIQUE,
    goods_issue_id         bigint NOT NULL REFERENCES logistics.goods_issue(goods_issue_id),
    work_order_id          bigint NOT NULL REFERENCES production.work_order(work_order_id),
    destination_location_id bigint NOT NULL REFERENCES mdm.location(location_id),
    received_at            timestamptz NOT NULL,
    received_by            bigint,
    status_code            app.code_t NOT NULL,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    updated_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by             bigint,
    version_no             integer NOT NULL DEFAULT 1 CHECK (version_no > 0)
);

CREATE TABLE logistics.shopfloor_receipt_line (
    shopfloor_receipt_line_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    shopfloor_receipt_id      bigint NOT NULL
                              REFERENCES logistics.shopfloor_receipt(shopfloor_receipt_id),
    goods_issue_line_id       bigint NOT NULL
                              REFERENCES logistics.goods_issue_line(goods_issue_line_id),
    item_id                   bigint NOT NULL REFERENCES mdm.item(item_id),
    lot_id                    bigint NOT NULL REFERENCES trace.lot(lot_id),
    issued_qty                app.qty_t NOT NULL,
    received_qty              app.qty_t NOT NULL,
    variance_qty              numeric(20, 6)
                              GENERATED ALWAYS AS (issued_qty - received_qty) STORED,
    uom_id                    bigint NOT NULL REFERENCES mdm.uom(uom_id),
    variance_reason_code      app.code_t,
    created_at                timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by                bigint,
    CONSTRAINT ck_shopfloor_receipt_qty CHECK (
        issued_qty >= 0 AND received_qty >= 0 AND received_qty <= issued_qty
    )
);

-- --------------------------------------------------------------------------
-- 11. Material consumption / return / loss
-- --------------------------------------------------------------------------
CREATE TABLE production.material_consumption (
    material_consumption_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    consumption_no          app.business_no_t NOT NULL UNIQUE,
    work_order_id           bigint NOT NULL REFERENCES production.work_order(work_order_id),
    work_session_id         bigint REFERENCES production.work_session(work_session_id),
    shopfloor_receipt_line_id bigint
                              REFERENCES logistics.shopfloor_receipt_line(shopfloor_receipt_line_id),
    bom_component_id        bigint REFERENCES planning.bom_component(bom_component_id),
    item_id                 bigint NOT NULL REFERENCES mdm.item(item_id),
    lot_id                  bigint NOT NULL REFERENCES trace.lot(lot_id),
    consumption_type_code   app.code_t NOT NULL,
    corrects_consumption_id bigint
                            REFERENCES production.material_consumption(material_consumption_id),
                            -- [M] 정정·취소 시 원본 투입 참조 (2-2 FR-MI-034):
                            --     inventory_transaction.reversal_*와 동일 패턴
    replaced_consumption_id bigint
                            REFERENCES production.material_consumption(material_consumption_id),
                            -- [M] Running Change: 교체된 이전 투입 참조 (2-2 FR-MI-021/041)
    change_reason_code      app.code_t,       -- [M] Running Change·정정 사유
    actual_use_process_id   bigint REFERENCES mdm.process(process_id),
                            -- [M] 실제 사용 공정 (2-2 FR-MI-003; 등록 공정은 work_order 경유)
    input_qty               app.qty_t NOT NULL CHECK (input_qty > 0),
    actual_consumed_qty     app.qty_t NOT NULL DEFAULT 0,
    uom_id                  bigint NOT NULL REFERENCES mdm.uom(uom_id),
    entered_qty             app.qty_t,        -- [L] 사용자 입력 원단위 수량 (2-2 FR-MI-010)
    entered_uom_id          bigint REFERENCES mdm.uom(uom_id),
    occurred_at             timestamptz NOT NULL,
    recorded_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    late_entry_reason_code  app.code_t,       -- [M] 지연·사후입력 사유 (2-2 FR-MI-016)
    worker_id               bigint NOT NULL REFERENCES mdm.worker(worker_id),
    terminal_id             bigint NOT NULL REFERENCES mdm.terminal(terminal_id),
    status_code             app.code_t NOT NULL,
    idempotency_key         varchar(150) NOT NULL UNIQUE,
    remarks                 text,
    created_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by              bigint,
    updated_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by              bigint,
    version_no              integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT ck_material_consumption_qty
        CHECK (actual_consumed_qty <= input_qty),
    CONSTRAINT ck_material_consumption_entered
        CHECK ((entered_qty IS NULL) = (entered_uom_id IS NULL))
);

CREATE TABLE production.material_return (
    material_return_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    material_return_no      app.business_no_t NOT NULL UNIQUE,
    work_order_id           bigint NOT NULL REFERENCES production.work_order(work_order_id),
    source_location_id      bigint NOT NULL REFERENCES mdm.location(location_id),
    destination_warehouse_id bigint NOT NULL REFERENCES mdm.warehouse(warehouse_id),
    status_code             app.code_t NOT NULL,
    requested_at            timestamptz NOT NULL,
    received_at             timestamptz,
    created_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by              bigint,
    updated_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by              bigint,
    version_no              integer NOT NULL DEFAULT 1 CHECK (version_no > 0)
);

CREATE TABLE production.material_return_line (
    material_return_line_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    material_return_id      bigint NOT NULL
                            REFERENCES production.material_return(material_return_id),
    line_no                 integer NOT NULL CHECK (line_no > 0),
    item_id                 bigint NOT NULL REFERENCES mdm.item(item_id),
    lot_id                  bigint NOT NULL REFERENCES trace.lot(lot_id),
    return_qty              app.qty_t NOT NULL CHECK (return_qty > 0),
    uom_id                  bigint NOT NULL REFERENCES mdm.uom(uom_id),
    package_opened          boolean NOT NULL DEFAULT false,
    quality_check_required  boolean NOT NULL DEFAULT false,
    return_quality_status_code app.code_t NOT NULL,
    inventory_transaction_line_id bigint
                                  REFERENCES inventory.inventory_transaction_line(inventory_transaction_line_id),
    created_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by              bigint,
    CONSTRAINT uq_material_return_line UNIQUE (material_return_id, line_no)
);

CREATE TABLE production.material_loss (
    material_loss_id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    work_order_id          bigint NOT NULL REFERENCES production.work_order(work_order_id),
    material_consumption_id bigint NOT NULL
                            REFERENCES production.material_consumption(material_consumption_id),
    item_id                bigint NOT NULL REFERENCES mdm.item(item_id),
    lot_id                 bigint NOT NULL REFERENCES trace.lot(lot_id),
    loss_type_code         app.code_t NOT NULL,
    loss_qty               app.qty_t NOT NULL CHECK (loss_qty > 0),
    uom_id                 bigint NOT NULL REFERENCES mdm.uom(uom_id),
    reason_code            app.code_t NOT NULL,
    occurred_at            timestamptz NOT NULL,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint
);

-- --------------------------------------------------------------------------
-- 12. Production result / lot allocation / handover
-- --------------------------------------------------------------------------
CREATE TABLE production.production_result (
    production_result_id  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    production_result_no  app.business_no_t NOT NULL UNIQUE,
    work_order_id         bigint NOT NULL REFERENCES production.work_order(work_order_id),
    work_session_id       bigint REFERENCES production.work_session(work_session_id),
    result_sequence       integer NOT NULL CHECK (result_sequence > 0),
    corrects_production_result_id bigint
                          REFERENCES production.production_result(production_result_id),
                          -- [M] 정정·취소 시 원본 실적 참조 (2-3 FR-PR-033/034/045)
    good_qty              app.qty_t NOT NULL DEFAULT 0,
    defect_qty            app.qty_t NOT NULL DEFAULT 0,
    hold_qty              app.qty_t NOT NULL DEFAULT 0,
    scrap_qty             app.qty_t NOT NULL DEFAULT 0,
    rework_qty            app.qty_t NOT NULL DEFAULT 0,
    uom_id                bigint NOT NULL REFERENCES mdm.uom(uom_id),
    result_source_code    app.code_t NOT NULL,
    occurred_at           timestamptz NOT NULL,
    recorded_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
    late_entry_reason_code app.code_t,        -- [M] 지연·사후입력 사유 (2-3 FR-PR-029)
    worker_id             bigint NOT NULL REFERENCES mdm.worker(worker_id),
    equipment_id          bigint REFERENCES mdm.equipment(equipment_id),
    mold_id               bigint REFERENCES mdm.mold(mold_id),
    shift_id              bigint NOT NULL REFERENCES mdm.shift(shift_id),
    terminal_id           bigint REFERENCES mdm.terminal(terminal_id),
                          -- [L] 입력 단말기 (2-3 FR-PR-004/042; 투입과 대칭)
    status_code           app.code_t NOT NULL,
    idempotency_key       varchar(150) NOT NULL UNIQUE,
    remarks               text,               -- [M] 비고 (2-3 FR-PR-004)
    created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by            bigint,
    updated_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by            bigint,
    version_no            integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT uq_production_result_seq UNIQUE (work_order_id, result_sequence),
    CONSTRAINT ck_production_result_nonzero CHECK (
        good_qty + defect_qty + hold_qty + scrap_qty + rework_qty > 0
    )
);

CREATE TABLE production.production_result_lot_allocation (
    production_result_lot_allocation_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    production_result_id  bigint NOT NULL
                          REFERENCES production.production_result(production_result_id),
    lot_id                bigint NOT NULL REFERENCES trace.lot(lot_id),
    allocated_qty         app.qty_t NOT NULL CHECK (allocated_qty > 0),
    uom_id                bigint NOT NULL REFERENCES mdm.uom(uom_id),
    created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by            bigint,
    CONSTRAINT uq_production_result_lot
        UNIQUE (production_result_id, lot_id)
);

CREATE TABLE production.material_usage_allocation (
    material_usage_allocation_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    material_consumption_id      bigint NOT NULL
                                 REFERENCES production.material_consumption(material_consumption_id),
    production_result_id         bigint
                                 REFERENCES production.production_result(production_result_id),
    output_lot_id                bigint REFERENCES trace.lot(lot_id),
    allocated_qty                app.qty_t NOT NULL CHECK (allocated_qty > 0),
    uom_id                       bigint NOT NULL REFERENCES mdm.uom(uom_id),
    allocation_method_code       app.code_t NOT NULL,
    trace_accuracy_code          app.code_t NOT NULL,
    effective_from_at            timestamptz,
    effective_to_at              timestamptz,
    created_at                   timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by                   bigint,
    CONSTRAINT ck_material_usage_target CHECK (
        production_result_id IS NOT NULL OR output_lot_id IS NOT NULL
    ),
    CONSTRAINT ck_material_usage_dates CHECK (
        effective_to_at IS NULL OR effective_from_at IS NULL OR effective_to_at >= effective_from_at
    )
);

CREATE TABLE production.operation_handover (
    operation_handover_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    handover_no           app.business_no_t NOT NULL UNIQUE,
    from_work_order_id    bigint NOT NULL REFERENCES production.work_order(work_order_id),
    to_work_order_id      bigint NOT NULL REFERENCES production.work_order(work_order_id),
    status_code           app.code_t NOT NULL,
    handed_over_at        timestamptz NOT NULL,
    received_at           timestamptz,
    created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by            bigint,
    updated_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by            bigint,
    version_no            integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT ck_handover_work_orders
        CHECK (from_work_order_id <> to_work_order_id)
);

CREATE TABLE production.operation_handover_line (
    operation_handover_line_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    operation_handover_id      bigint NOT NULL
                               REFERENCES production.operation_handover(operation_handover_id),
    line_no                    integer NOT NULL CHECK (line_no > 0),
    source_lot_id              bigint NOT NULL REFERENCES trace.lot(lot_id),
    handover_qty               app.qty_t NOT NULL CHECK (handover_qty > 0),
    received_qty               app.qty_t NOT NULL DEFAULT 0,
    uom_id                     bigint NOT NULL REFERENCES mdm.uom(uom_id),
    source_location_id         bigint NOT NULL REFERENCES mdm.location(location_id),
    destination_location_id    bigint NOT NULL REFERENCES mdm.location(location_id),
    created_at                 timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by                 bigint,
    CONSTRAINT uq_operation_handover_line
        UNIQUE (operation_handover_id, line_no),
    CONSTRAINT ck_handover_qty CHECK (received_qty <= handover_qty)
);

-- --------------------------------------------------------------------------
-- 13. Quality
-- --------------------------------------------------------------------------
CREATE TABLE quality.inspection_plan (
    inspection_plan_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    inspection_plan_code   app.code_t NOT NULL UNIQUE,
    inspection_plan_name   app.name_t NOT NULL,
    item_id                bigint REFERENCES mdm.item(item_id),
    process_id             bigint REFERENCES mdm.process(process_id),
    routing_id             bigint REFERENCES planning.routing(routing_id),
                           -- [M] 적용 라우팅(버전) 연결 (2-4 FR-QM-001)
    inspection_type_code   app.code_t NOT NULL,
    approved_by            bigint REFERENCES app.app_user(app_user_id),  -- [M] 승인자 (FR-QM-001)
    approved_at            timestamptz,
    is_active              boolean NOT NULL DEFAULT true,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    updated_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by             bigint,
    version_no             integer NOT NULL DEFAULT 1 CHECK (version_no > 0)
);

CREATE TABLE quality.inspection_plan_version (
    inspection_plan_version_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    inspection_plan_id         bigint NOT NULL
                               REFERENCES quality.inspection_plan(inspection_plan_id),
    plan_version               integer NOT NULL CHECK (plan_version > 0),
    effective_from             date NOT NULL,
    effective_to               date,
    sampling_method_code       app.code_t NOT NULL,
    sampling_qty               app.qty_t,
    aql_value                  numeric(9, 4),   -- [M] AQL·허용불량수 (2-4 §2.3, FR-QM-015)
    acceptance_number          integer CHECK (acceptance_number IS NULL OR acceptance_number >= 0),
    rejection_number           integer CHECK (rejection_number IS NULL OR rejection_number > 0),
    inspection_frequency_code  app.code_t NOT NULL,
    frequency_interval_value   numeric(18, 6),  -- [M] 주기 파라미터: N시간·N수량 (FR-QM-005)
    frequency_interval_uom_code app.code_t,
    status_code                app.code_t NOT NULL,
    created_at                 timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by                 bigint,
    updated_at                 timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by                 bigint,
    version_no                 integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT uq_inspection_plan_version
        UNIQUE (inspection_plan_id, plan_version),
    CONSTRAINT ck_inspection_plan_version_dates
        CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE TABLE quality.inspection_item_spec (
    inspection_item_spec_id  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    inspection_plan_version_id bigint NOT NULL
                               REFERENCES quality.inspection_plan_version(inspection_plan_version_id),
    sequence_no              integer NOT NULL CHECK (sequence_no > 0),
    inspection_item_code     app.code_t NOT NULL,
    inspection_item_name     app.name_t NOT NULL,
    data_type_code           app.code_t NOT NULL,
    uom_id                   bigint REFERENCES mdm.uom(uom_id),
    target_value             numeric(20, 6),
    lower_limit              numeric(20, 6),
    upper_limit              numeric(20, 6),
    measurement_count        integer NOT NULL DEFAULT 1 CHECK (measurement_count > 0),
                             -- [M] 항목별 측정횟수 (2-4 FR-QM-017)
    inspection_method_code   app.code_t,      -- [M] 검사방법 (2-4 FR-QM-016)
    default_inspection_equipment_id bigint REFERENCES mdm.equipment(equipment_id),
                             -- [M] 지정 검사장비 (2-4 FR-QM-016)
    required_flag            boolean NOT NULL DEFAULT true,
    automatic_judgment       boolean NOT NULL DEFAULT true,
    created_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by               bigint,
    CONSTRAINT uq_inspection_item_spec
        UNIQUE (inspection_plan_version_id, sequence_no),
    CONSTRAINT ck_inspection_limits
        CHECK (upper_limit IS NULL OR lower_limit IS NULL OR upper_limit >= lower_limit)
);

CREATE TABLE quality.inspection_request (
    inspection_request_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    inspection_request_no     app.business_no_t NOT NULL UNIQUE,
    inspection_type_code      app.code_t NOT NULL,
    inspection_plan_version_id bigint NOT NULL
                               REFERENCES quality.inspection_plan_version(inspection_plan_version_id),
    target_type_code          app.code_t NOT NULL,
    target_id                 bigint NOT NULL,
    item_id                   bigint NOT NULL REFERENCES mdm.item(item_id),
    lot_id                    bigint REFERENCES trace.lot(lot_id),
    work_order_id             bigint REFERENCES production.work_order(work_order_id),
    production_result_id      bigint REFERENCES production.production_result(production_result_id),
    target_qty                app.qty_t NOT NULL CHECK (target_qty > 0),
    uom_id                    bigint NOT NULL REFERENCES mdm.uom(uom_id),
    coverage_from_at          timestamptz,   -- [L] 검사결과 적용 생산구간: 시간 (2-6 §7.5)
    coverage_to_at            timestamptz,
    status_code               app.code_t NOT NULL,
    requested_at              timestamptz NOT NULL,
    created_at                timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by                bigint,
    updated_at                timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by                bigint,
    version_no                integer NOT NULL DEFAULT 1 CHECK (version_no > 0)
);

CREATE TABLE quality.inspection_result (
    inspection_result_id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    inspection_result_no    app.business_no_t NOT NULL UNIQUE,
    inspection_request_id   bigint NOT NULL
                            REFERENCES quality.inspection_request(inspection_request_id),
    inspection_round        integer NOT NULL DEFAULT 1 CHECK (inspection_round > 0),
    inspected_qty           app.qty_t NOT NULL CHECK (inspected_qty > 0),
    accepted_qty            app.qty_t NOT NULL DEFAULT 0,
    rejected_qty            app.qty_t NOT NULL DEFAULT 0,
    held_qty                app.qty_t NOT NULL DEFAULT 0,
    uom_id                  bigint NOT NULL REFERENCES mdm.uom(uom_id),
    overall_judgment_code   app.code_t NOT NULL,
    inspector_id            bigint NOT NULL REFERENCES mdm.worker(worker_id),
    inspected_at            timestamptz NOT NULL,
    confirmed_at            timestamptz,
    terminal_id             bigint REFERENCES mdm.terminal(terminal_id),
                            -- [M] 처리 단말기 (2-4 FR-QM-009/050, NFR-QM-006)
    status_code             app.code_t NOT NULL,
    previous_result_id      bigint REFERENCES quality.inspection_result(inspection_result_id),
    reinspection_reason_code app.code_t,      -- [L] 재검사 사유 (2-4 FR-QM-030)
    idempotency_key         varchar(150) NOT NULL UNIQUE,
                            -- [M] 멱등성 (2-4 NFR-QM-002; 타 원장과 패턴 통일)
    remarks                 text,
    created_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by              bigint,
    updated_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by              bigint,
    version_no              integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT uq_inspection_round
        UNIQUE (inspection_request_id, inspection_round),
    CONSTRAINT ck_inspection_result_qty
        CHECK (accepted_qty + rejected_qty + held_qty = inspected_qty)
);

CREATE TABLE quality.inspection_measurement (
    inspection_measurement_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    inspection_result_id      bigint NOT NULL
                              REFERENCES quality.inspection_result(inspection_result_id),
    inspection_item_spec_id   bigint NOT NULL
                              REFERENCES quality.inspection_item_spec(inspection_item_spec_id),
    sample_no                 integer NOT NULL CHECK (sample_no > 0),
    numeric_value             numeric(20, 6),
    text_value                text,
    boolean_value             boolean,
    judgment_code             app.code_t NOT NULL,
    measured_at               timestamptz NOT NULL,
    inspection_equipment_id   bigint REFERENCES mdm.equipment(equipment_id),
    created_at                timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by                bigint,
    CONSTRAINT uq_inspection_measurement
        UNIQUE (inspection_result_id, inspection_item_spec_id, sample_no),
    CONSTRAINT ck_measurement_single_value CHECK (
        num_nonnulls(numeric_value, text_value, boolean_value) <= 1
    )
);

CREATE TABLE quality.defect_code (
    defect_code_id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    defect_code            app.code_t NOT NULL UNIQUE,
    defect_name            app.name_t NOT NULL,
    parent_defect_code_id  bigint REFERENCES quality.defect_code(defect_code_id),
    process_id             bigint REFERENCES mdm.process(process_id),
    is_active              boolean NOT NULL DEFAULT true,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    updated_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by             bigint,
    version_no             integer NOT NULL DEFAULT 1 CHECK (version_no > 0)
);

-- [M] 불량 원인 기준정보: 불량현상(defect_code)과 분리 관리 (2-6 §7.3)
CREATE TABLE quality.cause_code (
    cause_code_id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    cause_code             app.code_t NOT NULL UNIQUE,
    cause_name             app.name_t NOT NULL,
    parent_cause_code_id   bigint REFERENCES quality.cause_code(cause_code_id),
    process_id             bigint REFERENCES mdm.process(process_id),
    is_active              boolean NOT NULL DEFAULT true,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    updated_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by             bigint,
    version_no             integer NOT NULL DEFAULT 1 CHECK (version_no > 0)
);

CREATE TABLE quality.defect_record (
    defect_record_id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    production_result_id   bigint REFERENCES production.production_result(production_result_id),
    inspection_result_id   bigint REFERENCES quality.inspection_result(inspection_result_id),
    work_order_id          bigint NOT NULL REFERENCES production.work_order(work_order_id),
    lot_id                 bigint REFERENCES trace.lot(lot_id),
    defect_code_id         bigint NOT NULL REFERENCES quality.defect_code(defect_code_id),
    suspected_cause_code_id bigint REFERENCES quality.cause_code(cause_code_id),
                           -- [M] 추정원인 (2-6 §7.3)
    confirmed_cause_code_id bigint REFERENCES quality.cause_code(cause_code_id),
                           -- [M] 확정원인 (2-6 §7.3)
    responsibility_type_code app.code_t,      -- [M] 귀책구분: 자체·공급사·외주 등 (2-4 FR-QM-047)
    responsible_department_id bigint REFERENCES mdm.department(department_id),
                           -- [M] 귀책부서 (2-6 §7.3)
    worker_id              bigint REFERENCES mdm.worker(worker_id),
                           -- [M] 발생·기록 작업자 (2-4 FR-QM-026)
    defect_description     text,              -- [M] 불량 설명 (2-4 FR-QM-026)
    defect_qty             app.qty_t NOT NULL CHECK (defect_qty > 0),
    uom_id                 bigint NOT NULL REFERENCES mdm.uom(uom_id),
    occurrence_process_id  bigint NOT NULL REFERENCES mdm.process(process_id),
    detection_process_id   bigint NOT NULL REFERENCES mdm.process(process_id),
    equipment_id           bigint REFERENCES mdm.equipment(equipment_id),
    mold_id                bigint REFERENCES mdm.mold(mold_id),
    occurred_at            timestamptz,
    detected_at            timestamptz NOT NULL,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    CONSTRAINT ck_defect_source CHECK (
        production_result_id IS NOT NULL OR inspection_result_id IS NOT NULL
    )
);

CREATE TABLE quality.nonconformance (
    nonconformance_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nonconformance_no      app.business_no_t NOT NULL UNIQUE,
    item_id                bigint NOT NULL REFERENCES mdm.item(item_id),
    work_order_id          bigint REFERENCES production.work_order(work_order_id),
    inspection_result_id   bigint REFERENCES quality.inspection_result(inspection_result_id),
    severity_code          app.code_t NOT NULL,
    description            text NOT NULL,
    responsible_department_id bigint REFERENCES mdm.department(department_id),  -- [H-1] FK 성립
    action_description     text,              -- [M] 최소 조치사항 (2-6 §7.4)
    action_owner_id        bigint REFERENCES app.app_user(app_user_id),
    action_due_date        date,
    action_completed_at    timestamptz,
    status_code            app.code_t NOT NULL,
    opened_at              timestamptz NOT NULL,
    closed_at              timestamptz,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    updated_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by             bigint,
    version_no             integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT ck_nonconformance_dates
        CHECK (closed_at IS NULL OR closed_at >= opened_at)
);

CREATE TABLE quality.nonconformance_lot (
    nonconformance_lot_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nonconformance_id       bigint NOT NULL
                            REFERENCES quality.nonconformance(nonconformance_id),
    lot_id                  bigint NOT NULL REFERENCES trace.lot(lot_id),
    affected_qty            app.qty_t NOT NULL CHECK (affected_qty > 0),
    uom_id                  bigint NOT NULL REFERENCES mdm.uom(uom_id),
    quality_status_before_code app.code_t NOT NULL,
    quality_status_after_code  app.code_t NOT NULL,
    created_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by              bigint,
    CONSTRAINT uq_nonconformance_lot UNIQUE (nonconformance_id, lot_id)
);

CREATE TABLE quality.disposition_decision (
    disposition_decision_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nonconformance_id       bigint NOT NULL
                            REFERENCES quality.nonconformance(nonconformance_id),
    disposition_type_code   app.code_t NOT NULL,
    decision_qty            app.qty_t NOT NULL CHECK (decision_qty > 0),
    uom_id                  bigint NOT NULL REFERENCES mdm.uom(uom_id),
    reason                  text NOT NULL,
    decided_by              bigint NOT NULL REFERENCES app.app_user(app_user_id),  -- [H-1] FK 성립
    decided_at              timestamptz NOT NULL,
    approval_request_id     bigint,
    created_at              timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- [M] 선별 실행 결과: 처리결정(선별)의 실제 수행 기록 (2-4 FR-QM-032)
CREATE TABLE quality.sorting_result (
    sorting_result_id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    disposition_decision_id bigint NOT NULL
                            REFERENCES quality.disposition_decision(disposition_decision_id),
    sorted_qty              app.qty_t NOT NULL CHECK (sorted_qty > 0),
    good_qty                app.qty_t NOT NULL DEFAULT 0,
    defect_qty              app.qty_t NOT NULL DEFAULT 0,
    hold_qty                app.qty_t NOT NULL DEFAULT 0,
    uom_id                  bigint NOT NULL REFERENCES mdm.uom(uom_id),
    sorting_criteria        text,
    worker_id               bigint NOT NULL REFERENCES mdm.worker(worker_id),
    started_at              timestamptz NOT NULL,
    ended_at                timestamptz,
    good_lot_id             bigint REFERENCES trace.lot(lot_id),   -- 선별 후 양품 LOT
    defect_lot_id           bigint REFERENCES trace.lot(lot_id),   -- 선별 후 불량 LOT
    status_code             app.code_t NOT NULL,
    remarks                 text,
    created_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by              bigint,
    CONSTRAINT ck_sorting_qty CHECK (good_qty + defect_qty + hold_qty <= sorted_qty)
);

-- [H-3] 특채(concession): 논리 모델 §16.12의 물리 반영.
--       단순 판정이 아니라 사용범위 통제 데이터 — 허용 작업지시·공정·고객·수량·기간을
--       한정하여 투입·출하 시 검증한다 (2-4 FR-QM-024/033, BR-QM-007, 2-5 FR-LT-034)
CREATE TABLE quality.concession (
    concession_id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    concession_no           app.business_no_t NOT NULL UNIQUE,
    nonconformance_id       bigint NOT NULL
                            REFERENCES quality.nonconformance(nonconformance_id),
    lot_id                  bigint NOT NULL REFERENCES trace.lot(lot_id),
    approved_qty            app.qty_t NOT NULL CHECK (approved_qty > 0),
    consumed_qty            app.qty_t NOT NULL DEFAULT 0,
    uom_id                  bigint NOT NULL REFERENCES mdm.uom(uom_id),
    valid_from              date NOT NULL,
    valid_to                date,
    allowed_work_order_id   bigint REFERENCES production.work_order(work_order_id),
    allowed_process_id      bigint REFERENCES mdm.process(process_id),
    allowed_customer_id     bigint REFERENCES mdm.partner(partner_id),
    approval_request_id     bigint NOT NULL,   -- late FK -> app.approval_request
    status_code             app.code_t NOT NULL,
    remarks                 text,
    created_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by              bigint,
    updated_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by              bigint,
    version_no              integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT ck_concession_dates
        CHECK (valid_to IS NULL OR valid_to >= valid_from),
    CONSTRAINT ck_concession_consumed
        CHECK (consumed_qty <= approved_qty)
);

-- [M] 검사장비 교정 이력 (2-6 §7.1 P1: 교정 유효기간 경과 장비의 검사확정 차단 근거)
CREATE TABLE quality.equipment_calibration (
    equipment_calibration_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    equipment_id            bigint NOT NULL REFERENCES mdm.equipment(equipment_id),
    calibration_date        date NOT NULL,
    result_code             app.code_t NOT NULL,
    valid_until             date,
    certificate_no          varchar(100),
    calibrated_by           bigint REFERENCES app.app_user(app_user_id),
    remarks                 text,
    created_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by              bigint,
    CONSTRAINT uq_equipment_calibration UNIQUE (equipment_id, calibration_date)
);

-- --------------------------------------------------------------------------
-- 14. Lot genealogy / serial
-- --------------------------------------------------------------------------
CREATE TABLE trace.lot_relation (
    lot_relation_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_lot_id          bigint NOT NULL REFERENCES trace.lot(lot_id),
    target_lot_id          bigint NOT NULL REFERENCES trace.lot(lot_id),
    relation_type_code     app.code_t NOT NULL,
    relation_qty           app.qty_t NOT NULL CHECK (relation_qty > 0),
    uom_id                 bigint NOT NULL REFERENCES mdm.uom(uom_id),
    source_event_type_code app.code_t NOT NULL,
    source_event_id        bigint NOT NULL,
    allocation_method_code app.code_t NOT NULL,
    trace_accuracy_code    app.code_t NOT NULL,
    occurred_at            timestamptz NOT NULL,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    CONSTRAINT ck_lot_relation_self CHECK (source_lot_id <> target_lot_id),
    -- [L] 동일 이벤트 기준 중복 관계 방지
    CONSTRAINT uq_lot_relation
        UNIQUE (source_lot_id, target_lot_id, relation_type_code,
                source_event_type_code, source_event_id)
);

-- [M] LOT 보류: 특정 LOT(전량 또는 일부 수량) 사용 중지와 해제 이력
--     (3-1 §13.5; lot.status_code만으로는 사유·범위·해제조건 이력이 남지 않음)
CREATE TABLE trace.lot_hold (
    lot_hold_id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    lot_id                 bigint NOT NULL REFERENCES trace.lot(lot_id),
    hold_qty               app.qty_t,          -- NULL = 전량 보류
    uom_id                 bigint REFERENCES mdm.uom(uom_id),
    reason_code            app.code_t NOT NULL,
    release_condition      text,
    status_code            app.code_t NOT NULL,
    held_by                bigint REFERENCES app.app_user(app_user_id),
    held_at                timestamptz NOT NULL,
    released_by            bigint REFERENCES app.app_user(app_user_id),
    released_at            timestamptz,
    remarks                text,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    CONSTRAINT ck_lot_hold_qty_uom CHECK ((hold_qty IS NULL) = (uom_id IS NULL)),
    CONSTRAINT ck_lot_hold_release
        CHECK (released_at IS NULL OR released_at >= held_at)
);

-- [M] 영향범위 분석 스냅샷: 리콜·품질사고 시 분석 시점·조건·결과 보존
--     (3-1 §13.6, 3-3 WRK-09. 대규모 리콜 '사건관리'는 2-6 §11 P2로 명시 이연)
CREATE TABLE trace.impact_analysis (
    impact_analysis_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    analysis_no            app.business_no_t NOT NULL UNIQUE,
    source_lot_id          bigint NOT NULL REFERENCES trace.lot(lot_id),
    direction_code         app.code_t NOT NULL,   -- FORWARD | BACKWARD | BOTH
    analysis_condition     text,
    analyzed_at            timestamptz NOT NULL,
    analyzed_by            bigint REFERENCES app.app_user(app_user_id),
    affected_lot_count     integer,
    result_summary         jsonb,
    status_code            app.code_t NOT NULL,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint
);

CREATE TABLE trace.serial_number (
    serial_number_id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    serial_no              varchar(150) NOT NULL UNIQUE,
    item_id                bigint NOT NULL REFERENCES mdm.item(item_id),
    lot_id                 bigint NOT NULL REFERENCES trace.lot(lot_id),
    status_code            app.code_t NOT NULL,
    produced_at            timestamptz,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    updated_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by             bigint,
    version_no             integer NOT NULL DEFAULT 1 CHECK (version_no > 0)
);

CREATE TABLE trace.serial_component_relation (
    serial_component_relation_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    parent_serial_number_id      bigint NOT NULL
                                 REFERENCES trace.serial_number(serial_number_id),
    component_serial_number_id   bigint NOT NULL
                                 REFERENCES trace.serial_number(serial_number_id),
    work_order_id                bigint NOT NULL REFERENCES production.work_order(work_order_id),
    assembled_at                 timestamptz NOT NULL,
    created_at                   timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by                   bigint,
    CONSTRAINT uq_serial_component
        UNIQUE (parent_serial_number_id, component_serial_number_id),
    CONSTRAINT ck_serial_component_self
        CHECK (parent_serial_number_id <> component_serial_number_id)
);

-- --------------------------------------------------------------------------
-- 15. Stock transfer / subcontract
-- --------------------------------------------------------------------------
CREATE TABLE logistics.stock_transfer (
    stock_transfer_id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    stock_transfer_no       app.business_no_t NOT NULL UNIQUE,
    transfer_type_code      app.code_t NOT NULL,
    from_business_unit_id   bigint NOT NULL REFERENCES mdm.business_unit(business_unit_id),
    to_business_unit_id     bigint NOT NULL REFERENCES mdm.business_unit(business_unit_id),
    from_warehouse_id       bigint NOT NULL REFERENCES mdm.warehouse(warehouse_id),
    to_warehouse_id         bigint NOT NULL REFERENCES mdm.warehouse(warehouse_id),
    requested_at            timestamptz NOT NULL,
    shipped_at              timestamptz,
    received_at             timestamptz,
    status_code             app.code_t NOT NULL,
    created_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by              bigint,
    updated_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by              bigint,
    version_no              integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT ck_stock_transfer_warehouses
        CHECK (from_warehouse_id <> to_warehouse_id)
);

CREATE TABLE logistics.stock_transfer_line (
    stock_transfer_line_id  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    stock_transfer_id       bigint NOT NULL REFERENCES logistics.stock_transfer(stock_transfer_id),
    line_no                 integer NOT NULL CHECK (line_no > 0),
    item_id                 bigint NOT NULL REFERENCES mdm.item(item_id),
    lot_id                  bigint NOT NULL REFERENCES trace.lot(lot_id),
    requested_qty           app.qty_t NOT NULL CHECK (requested_qty > 0),
    shipped_qty             app.qty_t NOT NULL DEFAULT 0,
    received_qty            app.qty_t NOT NULL DEFAULT 0,
    uom_id                  bigint NOT NULL REFERENCES mdm.uom(uom_id),
    from_location_id        bigint NOT NULL REFERENCES mdm.location(location_id),
    to_location_id          bigint NOT NULL REFERENCES mdm.location(location_id),
    issue_transaction_line_id bigint
                              REFERENCES inventory.inventory_transaction_line(inventory_transaction_line_id),
    receipt_transaction_line_id bigint
                                REFERENCES inventory.inventory_transaction_line(inventory_transaction_line_id),
    created_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by              bigint,
    CONSTRAINT uq_stock_transfer_line UNIQUE (stock_transfer_id, line_no),
    CONSTRAINT ck_stock_transfer_qty CHECK (
        shipped_qty <= requested_qty AND received_qty <= shipped_qty
    )
);

CREATE TABLE logistics.subcontract_order (
    subcontract_order_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    subcontract_order_no     app.business_no_t NOT NULL UNIQUE,
    work_order_id            bigint REFERENCES production.work_order(work_order_id),
    partner_id               bigint NOT NULL REFERENCES mdm.partner(partner_id),
    process_id               bigint NOT NULL REFERENCES mdm.process(process_id),
    item_id                  bigint NOT NULL REFERENCES mdm.item(item_id),
    order_qty                app.qty_t NOT NULL CHECK (order_qty > 0),
    uom_id                   bigint NOT NULL REFERENCES mdm.uom(uom_id),
    expected_return_date     date,
    status_code              app.code_t NOT NULL,
    created_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by               bigint,
    updated_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by               bigint,
    version_no               integer NOT NULL DEFAULT 1 CHECK (version_no > 0)
);

CREATE TABLE logistics.subcontract_issue (
    subcontract_issue_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    subcontract_order_id     bigint NOT NULL
                             REFERENCES logistics.subcontract_order(subcontract_order_id),
    goods_issue_id           bigint NOT NULL REFERENCES logistics.goods_issue(goods_issue_id),
    issued_at                timestamptz NOT NULL,
    created_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by               bigint,
    CONSTRAINT uq_subcontract_issue UNIQUE (subcontract_order_id, goods_issue_id)
);

CREATE TABLE logistics.subcontract_receipt (
    subcontract_receipt_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    subcontract_order_id     bigint NOT NULL
                             REFERENCES logistics.subcontract_order(subcontract_order_id),
    goods_receipt_id         bigint NOT NULL REFERENCES logistics.goods_receipt(goods_receipt_id),
    supplier_lot_no          varchar(100),
    received_at              timestamptz NOT NULL,
    created_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by               bigint,
    CONSTRAINT uq_subcontract_receipt UNIQUE (subcontract_order_id, goods_receipt_id)
);

-- [M] 외주 수량 정산: 출고 = 입고 + 잔량 + 불량 + 폐기 + 분실 + 조정 관계식의
--     유형별 차이수량과 정산확정 기록 (1-3 SCN-29, 2-5 FR-LT-062)
CREATE TABLE logistics.subcontract_reconciliation (
    subcontract_reconciliation_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    subcontract_order_id     bigint NOT NULL
                             REFERENCES logistics.subcontract_order(subcontract_order_id),
    settlement_seq           integer NOT NULL CHECK (settlement_seq > 0),
    reconciled_at            timestamptz NOT NULL,
    issued_qty               app.qty_t NOT NULL DEFAULT 0,
    received_good_qty        app.qty_t NOT NULL DEFAULT 0,
    received_defect_qty      app.qty_t NOT NULL DEFAULT 0,
    scrap_qty                app.qty_t NOT NULL DEFAULT 0,
    lost_qty                 app.qty_t NOT NULL DEFAULT 0,
    adjusted_qty             app.qty_t NOT NULL DEFAULT 0,
    remaining_qty            app.qty_t NOT NULL DEFAULT 0,   -- 외주처 잔량
    uom_id                   bigint NOT NULL REFERENCES mdm.uom(uom_id),
    status_code              app.code_t NOT NULL,
    confirmed_by             bigint REFERENCES app.app_user(app_user_id),
    confirmed_at             timestamptz,
    remarks                  text,
    created_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by               bigint,
    CONSTRAINT uq_subcontract_reconciliation
        UNIQUE (subcontract_order_id, settlement_seq)
);

-- --------------------------------------------------------------------------
-- 16. Sales / shipment
-- --------------------------------------------------------------------------
CREATE TABLE logistics.sales_order (
    sales_order_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sales_order_no        app.business_no_t NOT NULL UNIQUE,
    erp_sales_order_no    varchar(100),
    customer_id           bigint NOT NULL REFERENCES mdm.partner(partner_id),
    ship_to_partner_id    bigint NOT NULL REFERENCES mdm.partner(partner_id),
    order_date            date NOT NULL,
    status_code           app.code_t NOT NULL,
    created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by            bigint,
    updated_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by            bigint,
    version_no            integer NOT NULL DEFAULT 1 CHECK (version_no > 0)
);

CREATE TABLE logistics.sales_order_line (
    sales_order_line_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sales_order_id        bigint NOT NULL REFERENCES logistics.sales_order(sales_order_id),
    line_no               integer NOT NULL CHECK (line_no > 0),
    item_id               bigint NOT NULL REFERENCES mdm.item(item_id),
    ordered_qty           app.qty_t NOT NULL CHECK (ordered_qty > 0),
    uom_id                bigint NOT NULL REFERENCES mdm.uom(uom_id),
    requested_delivery_date date,
    shipped_qty           app.qty_t NOT NULL DEFAULT 0,
    created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by            bigint,
    updated_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by            bigint,
    version_no            integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT uq_sales_order_line UNIQUE (sales_order_id, line_no),
    CONSTRAINT ck_sales_shipped_qty CHECK (shipped_qty <= ordered_qty)
);

CREATE TABLE logistics.shipment_request (
    shipment_request_id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    shipment_request_no    app.business_no_t NOT NULL UNIQUE,
    customer_id            bigint NOT NULL REFERENCES mdm.partner(partner_id),
    ship_to_partner_id     bigint NOT NULL REFERENCES mdm.partner(partner_id),
    requested_ship_date    date NOT NULL,
    status_code            app.code_t NOT NULL,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    updated_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by             bigint,
    version_no             integer NOT NULL DEFAULT 1 CHECK (version_no > 0)
);

CREATE TABLE logistics.shipment_request_line (
    shipment_request_line_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    shipment_request_id      bigint NOT NULL
                             REFERENCES logistics.shipment_request(shipment_request_id),
    line_no                  integer NOT NULL CHECK (line_no > 0),
    sales_order_line_id      bigint REFERENCES logistics.sales_order_line(sales_order_line_id),
    item_id                  bigint NOT NULL REFERENCES mdm.item(item_id),
    requested_qty            app.qty_t NOT NULL CHECK (requested_qty > 0),
    allocated_qty            app.qty_t NOT NULL DEFAULT 0,
    shipped_qty              app.qty_t NOT NULL DEFAULT 0,
    uom_id                   bigint NOT NULL REFERENCES mdm.uom(uom_id),
    customer_lot_requirement varchar(200),
    shipping_inspection_required boolean NOT NULL DEFAULT false,
                             -- [L] 출하검사 필요 여부 (2-7 FR-IM-057)
    minimum_remaining_shelf_life_days integer
                             CHECK (minimum_remaining_shelf_life_days IS NULL
                                    OR minimum_remaining_shelf_life_days >= 0),
    created_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by               bigint,
    updated_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by               bigint,
    version_no               integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT uq_shipment_request_line UNIQUE (shipment_request_id, line_no),
    CONSTRAINT ck_shipment_request_qty CHECK (
        shipped_qty <= allocated_qty AND allocated_qty <= requested_qty
    )
);

CREATE TABLE logistics.shipment (
    shipment_id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    shipment_no           app.business_no_t NOT NULL UNIQUE,
    shipment_request_id   bigint NOT NULL
                          REFERENCES logistics.shipment_request(shipment_request_id),
    warehouse_id          bigint NOT NULL REFERENCES mdm.warehouse(warehouse_id),
    vehicle_no            varchar(50),
    driver_name           varchar(100),      -- [L] 운전자 (1-3 SCN-30, 2-7 FR-IM-063)
    seal_no               varchar(50),       -- [L] 봉인번호 (2-7 FR-IM-063)
    transport_document_no varchar(100),      -- [L] 운송문서 번호 (2-7 FR-IM-063)
    loading_worker_id     bigint REFERENCES mdm.worker(worker_id),  -- [L] 상차 담당자
    carrier_id            bigint REFERENCES mdm.partner(partner_id),
    loaded_at             timestamptz,
    shipped_at            timestamptz,
    status_code           app.code_t NOT NULL,
    erp_delivery_no       varchar(100),
    remarks               text,
    created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by            bigint,
    updated_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by            bigint,
    version_no            integer NOT NULL DEFAULT 1 CHECK (version_no > 0)
);

CREATE TABLE logistics.shipment_line (
    shipment_line_id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    shipment_id            bigint NOT NULL REFERENCES logistics.shipment(shipment_id),
    line_no                integer NOT NULL CHECK (line_no > 0),
    shipment_request_line_id bigint NOT NULL
                             REFERENCES logistics.shipment_request_line(shipment_request_line_id),
    item_id                bigint NOT NULL REFERENCES mdm.item(item_id),
    shipped_qty            app.qty_t NOT NULL CHECK (shipped_qty > 0),
    uom_id                 bigint NOT NULL REFERENCES mdm.uom(uom_id),
    goods_issue_line_id    bigint REFERENCES logistics.goods_issue_line(goods_issue_line_id),
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    CONSTRAINT uq_shipment_line UNIQUE (shipment_id, line_no)
);

CREATE TABLE logistics.shipment_lot_allocation (
    shipment_lot_allocation_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    shipment_line_id           bigint NOT NULL
                               REFERENCES logistics.shipment_line(shipment_line_id),
    lot_id                     bigint NOT NULL REFERENCES trace.lot(lot_id),
    handling_unit_id           bigint REFERENCES inventory.handling_unit(handling_unit_id),
    allocated_qty              app.qty_t NOT NULL CHECK (allocated_qty > 0),
    uom_id                     bigint NOT NULL REFERENCES mdm.uom(uom_id),
    created_at                 timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by                 bigint
);

-- [L] 동일 출하 Line 내 중복 배분 방지
CREATE UNIQUE INDEX uq_shipment_lot_allocation
ON logistics.shipment_lot_allocation (
    shipment_line_id,
    lot_id,
    COALESCE(handling_unit_id, 0)
);

-- --------------------------------------------------------------------------
-- 17. Inventory count / adjustment
-- --------------------------------------------------------------------------
CREATE TABLE inventory.inventory_count (
    inventory_count_id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    inventory_count_no    app.business_no_t NOT NULL UNIQUE,
    count_type_code       app.code_t NOT NULL,
    warehouse_id          bigint NOT NULL REFERENCES mdm.warehouse(warehouse_id),
    planned_date          date NOT NULL,
    blind_count           boolean NOT NULL DEFAULT false,
    status_code           app.code_t NOT NULL,
    created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by            bigint,
    updated_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by            bigint,
    version_no            integer NOT NULL DEFAULT 1 CHECK (version_no > 0)
);

CREATE TABLE inventory.inventory_count_line (
    inventory_count_line_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    inventory_count_id      bigint NOT NULL
                            REFERENCES inventory.inventory_count(inventory_count_id),
    line_no                 integer NOT NULL CHECK (line_no > 0),
    location_id             bigint NOT NULL REFERENCES mdm.location(location_id),
    item_id                 bigint NOT NULL REFERENCES mdm.item(item_id),
    lot_id                  bigint REFERENCES trace.lot(lot_id),
    system_qty              app.qty_t NOT NULL,
    counted_qty             app.qty_t NOT NULL,
    variance_qty            numeric(20, 6)
                            GENERATED ALWAYS AS (counted_qty - system_qty) STORED,
    uom_id                  bigint NOT NULL REFERENCES mdm.uom(uom_id),
    variance_reason_code    app.code_t,
    counted_by              bigint,
    counted_at              timestamptz NOT NULL,
    created_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by              bigint,
    CONSTRAINT uq_inventory_count_line UNIQUE (inventory_count_id, line_no)
);

CREATE TABLE inventory.inventory_adjustment (
    inventory_adjustment_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    inventory_adjustment_no app.business_no_t NOT NULL UNIQUE,
    inventory_count_id      bigint REFERENCES inventory.inventory_count(inventory_count_id),
    reason_code             app.code_t NOT NULL,
    approval_request_id     bigint,
    status_code             app.code_t NOT NULL,
    adjusted_at             timestamptz,
    created_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by              bigint,
    updated_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by              bigint,
    version_no              integer NOT NULL DEFAULT 1 CHECK (version_no > 0)
);

-- --------------------------------------------------------------------------
-- 18. Approval / exception / attachment / audit
-- --------------------------------------------------------------------------
CREATE TABLE app.approval_request (
    approval_request_id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    approval_request_no    app.business_no_t NOT NULL UNIQUE,
    approval_type_code     app.code_t NOT NULL,
    target_type_code       app.code_t NOT NULL,
    target_id              bigint NOT NULL,
    requested_by           bigint NOT NULL REFERENCES app.app_user(app_user_id),  -- [H-1]
    requested_at           timestamptz NOT NULL,
    status_code            app.code_t NOT NULL,
    reason                 text NOT NULL,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    version_no             integer NOT NULL DEFAULT 1 CHECK (version_no > 0)
);

CREATE TABLE app.approval_step (
    approval_step_id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    approval_request_id    bigint NOT NULL REFERENCES app.approval_request(approval_request_id),
    step_no                integer NOT NULL CHECK (step_no > 0),
    approver_id            bigint NOT NULL REFERENCES app.app_user(app_user_id),  -- [H-1]
    decision_code          app.code_t,
    decision_at            timestamptz,
    decision_comment       text,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_approval_step UNIQUE (approval_request_id, step_no)
);

-- [M] 승인경로 기준정보: 업무유형·사업부·수량(금액) 구간별 승인단계 설정 (2-6 CR-FR-004)
CREATE TABLE app.approval_route (
    approval_route_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    approval_type_code     app.code_t NOT NULL,
    business_unit_id       bigint REFERENCES mdm.business_unit(business_unit_id),
    min_value              numeric(20, 6),
    max_value              numeric(20, 6),
    is_active              boolean NOT NULL DEFAULT true,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    updated_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by             bigint,
    version_no             integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT ck_approval_route_range
        CHECK (max_value IS NULL OR min_value IS NULL OR max_value >= min_value)
);

CREATE TABLE app.approval_route_step (
    approval_route_step_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    approval_route_id      bigint NOT NULL REFERENCES app.approval_route(approval_route_id),
    step_no                integer NOT NULL CHECK (step_no > 0),
    approver_type_code     app.code_t NOT NULL,   -- USER | ROLE | DEPARTMENT
    approver_user_id       bigint REFERENCES app.app_user(app_user_id),
    approver_role_id       bigint REFERENCES app.role(role_id),
    approver_department_id bigint REFERENCES mdm.department(department_id),
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    CONSTRAINT uq_approval_route_step UNIQUE (approval_route_id, step_no),
    CONSTRAINT ck_approval_route_step_target CHECK (
        num_nonnulls(approver_user_id, approver_role_id, approver_department_id) = 1
    )
);

-- [M] 운영정책 파라미터: "소스 수정 없이 설정" NFR 다수 대응.
--     초과생산·FIFO 위반·초과투입 정책, 사후입력 허용시간, LOT 생성시점,
--     품목별 LOT 정책 등 수치·불리언 파라미터를 범위(사업부·공장·품목·공정)별로 관리
--     (2-1 FR-WO-033, 2-2 FR-MI-019/023, 2-3 NFR-PR-015, 2-5 FR-LT-001, NFR-LT-016)
CREATE TABLE app.operation_policy (
    operation_policy_id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    policy_code            app.code_t NOT NULL,
    business_unit_id       bigint REFERENCES mdm.business_unit(business_unit_id),
    plant_id               bigint REFERENCES mdm.plant(plant_id),
    item_id                bigint REFERENCES mdm.item(item_id),
    process_id             bigint REFERENCES mdm.process(process_id),
    value_text             varchar(500),
    value_numeric          numeric(20, 6),
    value_boolean          boolean,
    effective_from         date NOT NULL,
    effective_to           date,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    updated_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by             bigint,
    version_no             integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT ck_operation_policy_dates
        CHECK (effective_to IS NULL OR effective_to >= effective_from),
    CONSTRAINT ck_operation_policy_value CHECK (
        num_nonnulls(value_text, value_numeric, value_boolean) >= 1
    )
);

CREATE UNIQUE INDEX uq_operation_policy
ON app.operation_policy (
    policy_code,
    COALESCE(business_unit_id, 0),
    COALESCE(plant_id, 0),
    COALESCE(item_id, 0),
    COALESCE(process_id, 0),
    effective_from
);

-- [M] 채번규칙: LOT 번호(2-5 FR-LT-005) 및 업무번호(*_no) 생성규칙과 시퀀스 상태
CREATE TABLE app.numbering_rule (
    numbering_rule_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    document_type_code     app.code_t NOT NULL,
    plant_id               bigint REFERENCES mdm.plant(plant_id),
    lot_type_code          app.code_t,          -- LOT 채번 시 유형별 규칙 (FR-LT-005)
    pattern                varchar(200) NOT NULL, -- 예: 'WO-{PLANT}-{YYMMDD}-{SEQ4}'
    reset_cycle_code       app.code_t NOT NULL DEFAULT 'DAILY',
    is_active              boolean NOT NULL DEFAULT true,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    updated_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by             bigint,
    version_no             integer NOT NULL DEFAULT 1 CHECK (version_no > 0)
);

CREATE UNIQUE INDEX uq_numbering_rule
ON app.numbering_rule (
    document_type_code,
    COALESCE(plant_id, 0),
    COALESCE(lot_type_code, '')
);

CREATE TABLE app.numbering_counter (
    numbering_counter_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    numbering_rule_id      bigint NOT NULL REFERENCES app.numbering_rule(numbering_rule_id),
    period_key             varchar(20) NOT NULL,   -- 리셋 주기 키 (예: '20260716')
    last_value             bigint NOT NULL DEFAULT 0 CHECK (last_value >= 0),
    updated_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_numbering_counter UNIQUE (numbering_rule_id, period_key)
);

CREATE TABLE app.exception_case (
    exception_case_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    exception_case_no      app.business_no_t NOT NULL UNIQUE,
    exception_type_code    app.code_t NOT NULL,
    severity_code          app.code_t NOT NULL,
    target_type_code       app.code_t NOT NULL,
    target_id              bigint NOT NULL,
    assigned_department_id bigint REFERENCES mdm.department(department_id),   -- [H-1]
    assigned_user_id       bigint REFERENCES app.app_user(app_user_id),       -- [H-1]
    due_at                 timestamptz,
    status_code            app.code_t NOT NULL,
    resolution             text,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    updated_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by             bigint,
    version_no             integer NOT NULL DEFAULT 1 CHECK (version_no > 0)
);

CREATE TABLE app.attachment (
    attachment_id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    target_type_code       app.code_t NOT NULL,
    target_id              bigint NOT NULL,
    file_name              varchar(255) NOT NULL,
    storage_key            varchar(500) NOT NULL,
    mime_type              varchar(150) NOT NULL,
    file_size              bigint NOT NULL CHECK (file_size >= 0),
    checksum_sha256        varchar(64),
    uploaded_by            bigint NOT NULL REFERENCES app.app_user(app_user_id),  -- [H-1]
    uploaded_at            timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- [M] 발행 이력: 라벨·검사성적서(COA)·추적성 증빙의 발행/재발행 기록
--     (2-5 FR-LT-038/039/051/072, 2-4 FR-QM-039, 2-7 FR-IM-084, 1-2 바코드·라벨 관리)
--     재발행은 같은 target에 issue_seq를 증가시켜 기록하며 새 LOT를 생성하지 않는다.
CREATE TABLE app.document_issue_log (
    document_issue_log_id  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    document_type_code     app.code_t NOT NULL,   -- LABEL | COA | TRACE_REPORT 등
    target_type_code       app.code_t NOT NULL,
    target_id              bigint NOT NULL,
    lot_id                 bigint REFERENCES trace.lot(lot_id),
    issue_seq              integer NOT NULL DEFAULT 1 CHECK (issue_seq > 0),  -- 1=최초, 2+=재발행
    reissue_reason_code    app.code_t,            -- 재발행 사유 (issue_seq > 1일 때)
    issued_by              bigint NOT NULL REFERENCES app.app_user(app_user_id),
    issued_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
    terminal_id            bigint REFERENCES mdm.terminal(terminal_id),
    printer_name           varchar(100),
    remarks                text,
    CONSTRAINT uq_document_issue_log
        UNIQUE (document_type_code, target_type_code, target_id, issue_seq),
    CONSTRAINT ck_document_reissue_reason
        CHECK (issue_seq = 1 OR reissue_reason_code IS NOT NULL)
);

CREATE TABLE audit.audit_event (
    audit_event_id         bigint GENERATED ALWAYS AS IDENTITY,
    occurred_at            timestamptz NOT NULL,
    target_type_code       app.code_t NOT NULL,
    target_id              bigint NOT NULL,
    event_type_code        app.code_t NOT NULL,
    before_value           jsonb,
    after_value            jsonb,
    reason                 text,
    performed_by           bigint,
    terminal_id            bigint REFERENCES mdm.terminal(terminal_id),
    correlation_id         varchar(150),
    PRIMARY KEY (audit_event_id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE TABLE audit.audit_event_default
PARTITION OF audit.audit_event DEFAULT;

-- --------------------------------------------------------------------------
-- 19. Integration outbox / message
-- --------------------------------------------------------------------------
CREATE TABLE integration.integration_message (
    integration_message_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    message_key            varchar(150) NOT NULL UNIQUE,
    interface_code         app.code_t NOT NULL,
    direction_code         app.code_t NOT NULL,
    target_type_code       app.code_t NOT NULL,
    target_id              bigint NOT NULL,
    payload                jsonb NOT NULL,
    status_code            app.code_t NOT NULL,
    retry_count            integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
    last_error_message     text,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    available_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
    sent_at                timestamptz,
    completed_at           timestamptz,
    locked_at              timestamptz,
    locked_by              varchar(100)
);

CREATE TABLE integration.external_document_reference (
    external_document_reference_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    target_type_code       app.code_t NOT NULL,
    target_id              bigint NOT NULL,
    external_system_code   app.code_t NOT NULL,
    external_document_type_code app.code_t NOT NULL,
    external_document_no   varchar(150) NOT NULL,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint
);

CREATE UNIQUE INDEX uq_external_document_reference
ON integration.external_document_reference (
    target_type_code,
    target_id,
    external_system_code,
    external_document_type_code,
    external_document_no
);

-- --------------------------------------------------------------------------
-- 19.1. Late foreign keys to common approval entity
-- --------------------------------------------------------------------------
ALTER TABLE logistics.inbound_variance
    ADD CONSTRAINT fk_inbound_variance_approval
    FOREIGN KEY (approval_request_id)
    REFERENCES app.approval_request(approval_request_id);

ALTER TABLE quality.disposition_decision
    ADD CONSTRAINT fk_disposition_approval
    FOREIGN KEY (approval_request_id)
    REFERENCES app.approval_request(approval_request_id);

ALTER TABLE inventory.inventory_adjustment
    ADD CONSTRAINT fk_inventory_adjustment_approval
    FOREIGN KEY (approval_request_id)
    REFERENCES app.approval_request(approval_request_id);

ALTER TABLE logistics.inbound_receipt
    ADD CONSTRAINT fk_inbound_receipt_approval
    FOREIGN KEY (approval_request_id)
    REFERENCES app.approval_request(approval_request_id);

ALTER TABLE quality.concession
    ADD CONSTRAINT fk_concession_approval
    FOREIGN KEY (approval_request_id)
    REFERENCES app.approval_request(approval_request_id);

-- [H-5] 재작업 원본 참조 (생성 순서상 late FK)
ALTER TABLE production.work_order
    ADD CONSTRAINT fk_work_order_rework_lot
    FOREIGN KEY (rework_source_lot_id)
    REFERENCES trace.lot(lot_id);

ALTER TABLE production.work_order
    ADD CONSTRAINT fk_work_order_rework_nc
    FOREIGN KEY (rework_source_nonconformance_id)
    REFERENCES quality.nonconformance(nonconformance_id);

-- [M] 고객반품 원 출하 LOT 연결 (생성 순서상 late FK)
ALTER TABLE logistics.goods_receipt_line
    ADD CONSTRAINT fk_goods_receipt_line_orig_shipment
    FOREIGN KEY (original_shipment_lot_allocation_id)
    REFERENCES logistics.shipment_lot_allocation(shipment_lot_allocation_id);

-- --------------------------------------------------------------------------
-- 19.2. [H-1] 사용자 참조 FK 일괄 정비
--       created_by/updated_by는 의도적으로 FK 제외(대량 적재 성능, 앱 계층 검증).
--       audit.audit_event.performed_by는 파티션·적재량 특성상 FK 제외.
-- --------------------------------------------------------------------------
ALTER TABLE planning.production_plan
    ADD CONSTRAINT fk_production_plan_confirmed_by
    FOREIGN KEY (confirmed_by) REFERENCES app.app_user(app_user_id);

ALTER TABLE production.work_session_event
    ADD CONSTRAINT fk_work_session_event_performed_by
    FOREIGN KEY (performed_by) REFERENCES app.app_user(app_user_id);

ALTER TABLE logistics.inbound_receipt
    ADD CONSTRAINT fk_inbound_receipt_received_by
    FOREIGN KEY (received_by) REFERENCES app.app_user(app_user_id);

ALTER TABLE logistics.shopfloor_receipt
    ADD CONSTRAINT fk_shopfloor_receipt_received_by
    FOREIGN KEY (received_by) REFERENCES app.app_user(app_user_id);

ALTER TABLE inventory.inventory_count_line
    ADD CONSTRAINT fk_inventory_count_line_counted_by
    FOREIGN KEY (counted_by) REFERENCES app.app_user(app_user_id);

-- --------------------------------------------------------------------------
-- 20. Updated-at triggers
-- --------------------------------------------------------------------------
DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT n.nspname AS schema_name, c.relname AS table_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid
        WHERE c.relkind = 'r'
          AND a.attname = 'updated_at'
          AND n.nspname IN (
              'mdm','planning','production','inventory','quality',
              'trace','logistics','integration','app'
          )
        GROUP BY n.nspname, c.relname
    LOOP
        EXECUTE format(
            'CREATE TRIGGER trg_%I_set_updated_at
             BEFORE UPDATE ON %I.%I
             FOR EACH ROW EXECUTE FUNCTION app.set_updated_at()',
            r.table_name, r.schema_name, r.table_name
        );
    END LOOP;
END $$;

-- --------------------------------------------------------------------------
-- 20.5. [M] Integrity triggers
--       3-3 물리 설계가 DB 계층 책임으로 명시한 무결성 장치의 구현
--       (DB-C17~C19, TRG-05/06) + [H-2] 음수재고 조건부 검증
-- --------------------------------------------------------------------------

-- [H-2] 재고잔액 수량 검증: 음수재고는 품목 정책 허용 시에만 (2-2 FR-MI-025)
CREATE OR REPLACE FUNCTION inventory.check_balance_qty()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_negative_allowed boolean;
BEGIN
    IF NEW.on_hand_qty >= 0 THEN
        IF NEW.on_hand_qty < NEW.reserved_qty + NEW.picked_qty + NEW.blocked_qty THEN
            RAISE EXCEPTION 'on_hand_qty(%) < reserved+picked+blocked', NEW.on_hand_qty
                USING ERRCODE = 'check_violation';
        END IF;
    ELSE
        SELECT i.negative_stock_allowed INTO v_negative_allowed
          FROM mdm.item i WHERE i.item_id = NEW.item_id;
        IF NOT COALESCE(v_negative_allowed, false) THEN
            RAISE EXCEPTION '음수재고 미허용 품목: item_id=%', NEW.item_id
                USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.reserved_qty + NEW.picked_qty + NEW.blocked_qty > 0 THEN
            RAISE EXCEPTION '음수재고 상태에서는 예약·피킹·차단 수량을 가질 수 없습니다'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_inventory_balance_qty
BEFORE INSERT OR UPDATE ON inventory.inventory_balance
FOR EACH ROW EXECUTE FUNCTION inventory.check_balance_qty();

-- [DB-C17] LOT 계보 순환 방지 (2-5 NFR-LT-023)
CREATE OR REPLACE FUNCTION trace.check_lot_relation_cycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF EXISTS (
        WITH RECURSIVE ancestors AS (
            SELECT lr.source_lot_id
              FROM trace.lot_relation lr
             WHERE lr.target_lot_id = NEW.source_lot_id
            UNION
            SELECT lr.source_lot_id
              FROM trace.lot_relation lr
              JOIN ancestors a ON lr.target_lot_id = a.source_lot_id
        )
        SELECT 1 FROM ancestors WHERE source_lot_id = NEW.target_lot_id
    ) THEN
        RAISE EXCEPTION 'LOT 계보 순환: %(source) -> %(target)',
            NEW.source_lot_id, NEW.target_lot_id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_lot_relation_cycle
BEFORE INSERT OR UPDATE OF source_lot_id, target_lot_id ON trace.lot_relation
FOR EACH ROW EXECUTE FUNCTION trace.check_lot_relation_cycle();

-- [DB-C18] 생산 LOT 배분합계 <= 생산실적 양품수량 (3-2 §15.2)
CREATE OR REPLACE FUNCTION production.check_result_lot_allocation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_good_qty numeric;
    v_allocated numeric;
BEGIN
    SELECT pr.good_qty INTO v_good_qty
      FROM production.production_result pr
     WHERE pr.production_result_id = NEW.production_result_id;

    SELECT COALESCE(SUM(a.allocated_qty), 0) INTO v_allocated
      FROM production.production_result_lot_allocation a
     WHERE a.production_result_id = NEW.production_result_id;

    IF v_allocated > v_good_qty THEN
        RAISE EXCEPTION '생산 LOT 배분합계(%)가 양품수량(%)을 초과합니다',
            v_allocated, v_good_qty
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_result_lot_allocation_sum
AFTER INSERT OR UPDATE ON production.production_result_lot_allocation
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION production.check_result_lot_allocation();

-- [DB-C19] 자재사용 배분합계 <= 소비수량
CREATE OR REPLACE FUNCTION production.check_material_usage_allocation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_cap numeric;
    v_allocated numeric;
BEGIN
    SELECT CASE WHEN mc.actual_consumed_qty > 0
                THEN mc.actual_consumed_qty ELSE mc.input_qty END
      INTO v_cap
      FROM production.material_consumption mc
     WHERE mc.material_consumption_id = NEW.material_consumption_id;

    SELECT COALESCE(SUM(a.allocated_qty), 0) INTO v_allocated
      FROM production.material_usage_allocation a
     WHERE a.material_consumption_id = NEW.material_consumption_id;

    IF v_allocated > v_cap THEN
        RAISE EXCEPTION '자재사용 배분합계(%)가 소비수량(%)을 초과합니다', v_allocated, v_cap
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_material_usage_allocation_sum
AFTER INSERT OR UPDATE ON production.material_usage_allocation
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION production.check_material_usage_allocation();

-- [TRG-05] 재고원장 불변성: Line은 수정·삭제 금지, Header는 status_code 변경만 허용.
--          정정은 반드시 역트랜잭션(reversal_of_*)으로 처리 (2-7 FR-IM-080)
--          주의: 파티션에서 실행되면 TG_TABLE_NAME이 파티션명이 되므로
--          header/line 함수를 분리한다.
CREATE OR REPLACE FUNCTION inventory.block_ledger_header_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION '재고원장 header는 삭제할 수 없습니다. 역트랜잭션을 사용하세요'
            USING ERRCODE = 'raise_exception';
    END IF;
    IF to_jsonb(OLD) - 'status_code' = to_jsonb(NEW) - 'status_code' THEN
        RETURN NEW;   -- 상태 전이만 허용
    END IF;
    RAISE EXCEPTION '재고원장 header는 상태 외 수정이 불가합니다. 역트랜잭션을 사용하세요'
        USING ERRCODE = 'raise_exception';
END;
$$;

CREATE OR REPLACE FUNCTION inventory.block_ledger_line_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION '재고원장 line은 수정·삭제할 수 없습니다. 역트랜잭션을 사용하세요'
        USING ERRCODE = 'raise_exception';
END;
$$;

CREATE TRIGGER trg_inventory_transaction_immutable
BEFORE UPDATE OR DELETE ON inventory.inventory_transaction
FOR EACH ROW EXECUTE FUNCTION inventory.block_ledger_header_mutation();

CREATE TRIGGER trg_inventory_transaction_line_immutable
BEFORE UPDATE OR DELETE ON inventory.inventory_transaction_line
FOR EACH ROW EXECUTE FUNCTION inventory.block_ledger_line_mutation();

-- [TRG-06] 마감문서 수정 차단: 마감된 작업지시는 변경 불가
CREATE OR REPLACE FUNCTION production.block_closed_work_order_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.closed_at IS NOT NULL THEN
        RAISE EXCEPTION '마감된 작업지시(%)는 수정할 수 없습니다', OLD.work_order_no
            USING ERRCODE = 'raise_exception';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_work_order_closed_immutable
BEFORE UPDATE ON production.work_order
FOR EACH ROW EXECUTE FUNCTION production.block_closed_work_order_update();

-- [H-5] 작업지시 분할 합계 검증: 자식 지시수량 합 <= 원본 지시수량
--       (미작업 잔여수량 기준의 정밀 검증은 실적 집계가 필요하므로 앱 계층 책임,
--        DB는 지시수량 상한으로 보수적 통제. 2-1 FR-WO-013, BR-WO-005)
CREATE OR REPLACE FUNCTION production.check_work_order_split()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_parent_qty numeric;
    v_children_qty numeric;
BEGIN
    IF NEW.parent_work_order_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT wo.order_qty INTO v_parent_qty
      FROM production.work_order wo
     WHERE wo.work_order_id = NEW.parent_work_order_id;

    SELECT COALESCE(SUM(wo.order_qty), 0) INTO v_children_qty
      FROM production.work_order wo
     WHERE wo.parent_work_order_id = NEW.parent_work_order_id;

    IF v_children_qty > v_parent_qty THEN
        RAISE EXCEPTION '분할 지시수량 합계(%)가 원본 지시수량(%)을 초과합니다',
            v_children_qty, v_parent_qty
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_work_order_split_sum
AFTER INSERT OR UPDATE OF order_qty, parent_work_order_id ON production.work_order
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION production.check_work_order_split();

-- --------------------------------------------------------------------------
-- 21. Core indexes
-- --------------------------------------------------------------------------
CREATE INDEX ix_location_parent
    ON mdm.location(parent_location_id);

CREATE INDEX ix_item_type
    ON mdm.item(item_type_code, is_active);

CREATE INDEX ix_routing_item_status
    ON planning.routing(item_id, status_code, effective_from DESC);

CREATE INDEX ix_bom_parent_status
    ON planning.bom(parent_item_id, status_code, effective_from DESC);

CREATE INDEX ix_work_order_plan
    ON production.work_order(production_plan_id, routing_operation_id);

CREATE INDEX ix_work_order_dispatch
    ON production.work_order(status_code, planned_start_at, priority_no)
    WHERE status_code IN ('RELEASED', 'WAITING', 'IN_PROGRESS', 'PAUSED', 'ON_HOLD');

CREATE INDEX ix_work_session_open
    ON production.work_session(work_order_id, started_at DESC)
    WHERE ended_at IS NULL;

CREATE INDEX ix_inbound_receipt_supplier_date
    ON logistics.inbound_receipt(supplier_id, receipt_datetime DESC);

CREATE INDEX ix_inbound_line_po
    ON logistics.inbound_receipt_line(purchase_order_line_id);

CREATE INDEX ix_lot_item
    ON trace.lot(item_id, created_at DESC);

CREATE INDEX ix_lot_expiry
    ON trace.lot(expiry_date)
    WHERE expiry_date IS NOT NULL AND status_code = 'ACTIVE';

CREATE INDEX ix_inventory_balance_lookup
    ON inventory.inventory_balance(
        plant_id, warehouse_id, item_id, lot_id, quality_status_code, inventory_status_code
    );

CREATE INDEX ix_inventory_available
    ON inventory.inventory_balance(warehouse_id, item_id, available_qty DESC)
    WHERE available_qty > 0
      AND inventory_status_code = 'AVAILABLE';

CREATE INDEX ix_inventory_transaction_source
    ON inventory.inventory_transaction(source_document_type_code, source_document_id, business_date DESC);

CREATE INDEX ix_inventory_transaction_occurred_brin
    ON inventory.inventory_transaction USING BRIN(occurred_at);

CREATE INDEX ix_inventory_line_lot
    ON inventory.inventory_transaction_line(lot_id, business_date DESC);

CREATE INDEX ix_reservation_source
    ON inventory.inventory_reservation(source_document_type_code, source_document_id, status_code);

CREATE INDEX ix_picking_open
    ON logistics.picking_order(warehouse_id, status_code, created_at)
    WHERE status_code IN ('CREATED', 'ASSIGNED', 'PICKING');

CREATE INDEX ix_goods_issue_source
    ON logistics.goods_issue(source_document_type_code, source_document_id, issued_at DESC);

CREATE INDEX ix_material_consumption_work_order
    ON production.material_consumption(work_order_id, occurred_at DESC);

CREATE INDEX ix_material_consumption_lot
    ON production.material_consumption(lot_id, occurred_at DESC);

CREATE INDEX ix_production_result_work_order
    ON production.production_result(work_order_id, occurred_at DESC);

CREATE INDEX ix_production_result_lot
    ON production.production_result_lot_allocation(lot_id, production_result_id);

CREATE INDEX ix_material_usage_output_lot
    ON production.material_usage_allocation(output_lot_id)
    WHERE output_lot_id IS NOT NULL;

CREATE INDEX ix_inspection_request_open
    ON quality.inspection_request(status_code, requested_at)
    WHERE status_code IN ('REQUESTED', 'IN_PROGRESS', 'PENDING_CONFIRMATION');

CREATE INDEX ix_inspection_request_lot
    ON quality.inspection_request(lot_id, requested_at DESC)
    WHERE lot_id IS NOT NULL;

CREATE INDEX ix_nonconformance_open
    ON quality.nonconformance(status_code, severity_code, opened_at)
    WHERE closed_at IS NULL;

CREATE INDEX ix_lot_relation_source
    ON trace.lot_relation(source_lot_id, occurred_at);

CREATE INDEX ix_lot_relation_target
    ON trace.lot_relation(target_lot_id, occurred_at);

CREATE INDEX ix_shipment_customer_date
    ON logistics.shipment_request(customer_id, requested_ship_date, status_code);

CREATE INDEX ix_shipment_lot
    ON logistics.shipment_lot_allocation(lot_id, shipment_line_id);

CREATE INDEX ix_exception_open
    ON app.exception_case(severity_code, due_at, created_at)
    WHERE status_code NOT IN ('RESOLVED', 'CLOSED', 'CANCELLED');

CREATE INDEX ix_integration_pending
    ON integration.integration_message(available_at, created_at)
    WHERE status_code IN ('PENDING', 'RETRY');

CREATE INDEX ix_integration_target
    ON integration.integration_message(target_type_code, target_id, created_at DESC);

CREATE INDEX ix_audit_target
    ON audit.audit_event(target_type_code, target_id, occurred_at DESC);

-- v2 신규 테이블 인덱스
CREATE INDEX ix_putaway_open
    ON logistics.putaway_task(status_code, priority_no)
    WHERE completed_at IS NULL;

CREATE INDEX ix_putaway_receipt_line
    ON logistics.putaway_task(goods_receipt_line_id);

CREATE INDEX ix_asn_expected
    ON logistics.asn(plant_id, expected_arrival_date, status_code);

CREATE INDEX ix_lot_hold_active
    ON trace.lot_hold(lot_id)
    WHERE released_at IS NULL;

CREATE INDEX ix_impact_analysis_lot
    ON trace.impact_analysis(source_lot_id, analyzed_at DESC);

CREATE INDEX ix_document_issue_target
    ON app.document_issue_log(target_type_code, target_id, issued_at DESC);

CREATE INDEX ix_document_issue_lot
    ON app.document_issue_log(lot_id)
    WHERE lot_id IS NOT NULL;

CREATE INDEX ix_concession_lot
    ON quality.concession(lot_id, status_code);

CREATE INDEX ix_equipment_calibration_history
    ON quality.equipment_calibration(equipment_id, calibration_date DESC);

CREATE INDEX ix_worker_qualification_worker
    ON mdm.worker_qualification(worker_id, qualification_type_code);

CREATE INDEX ix_work_order_parent
    ON production.work_order(parent_work_order_id)
    WHERE parent_work_order_id IS NOT NULL;

CREATE INDEX ix_work_order_rework_source
    ON production.work_order(rework_source_work_order_id)
    WHERE rework_source_work_order_id IS NOT NULL;

CREATE INDEX ix_work_order_line
    ON production.work_order(production_line_id)
    WHERE production_line_id IS NOT NULL;

CREATE INDEX ix_subcontract_reconciliation_order
    ON logistics.subcontract_reconciliation(subcontract_order_id, settlement_seq DESC);

-- --------------------------------------------------------------------------
-- 22. Inventory posting skeleton
--     Application/service should call this pattern inside one transaction.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION inventory.lock_balance(
    p_legal_entity_id bigint,
    p_business_unit_id bigint,
    p_plant_id bigint,
    p_warehouse_id bigint,
    p_location_id bigint,
    p_item_id bigint,
    p_lot_id bigint,
    p_quality_status_code app.code_t,
    p_inventory_status_code app.code_t,
    p_ownership_type_code app.code_t,
    p_owner_partner_id bigint
)
RETURNS inventory.inventory_balance
LANGUAGE plpgsql
AS $$
DECLARE
    v_balance inventory.inventory_balance;
BEGIN
    SELECT *
      INTO v_balance
      FROM inventory.inventory_balance
     WHERE legal_entity_id = p_legal_entity_id
       AND business_unit_id = p_business_unit_id
       AND plant_id = p_plant_id
       AND warehouse_id = p_warehouse_id
       AND location_id = p_location_id
       AND item_id = p_item_id
       AND lot_id IS NOT DISTINCT FROM p_lot_id
       AND quality_status_code = p_quality_status_code
       AND inventory_status_code = p_inventory_status_code
       AND ownership_type_code = p_ownership_type_code
       AND owner_partner_id IS NOT DISTINCT FROM p_owner_partner_id
     FOR UPDATE;

    RETURN v_balance;
END;
$$;

-- --------------------------------------------------------------------------
-- 23. Views
-- --------------------------------------------------------------------------
CREATE VIEW inventory.v_inventory_available AS
SELECT
    b.inventory_balance_id,
    b.business_unit_id,
    b.plant_id,
    b.warehouse_id,
    b.location_id,
    b.item_id,
    i.item_code,
    i.item_name,
    b.lot_id,
    l.lot_no,
    b.quality_status_code,
    b.inventory_status_code,
    b.ownership_type_code,
    b.on_hand_qty,
    b.reserved_qty,
    b.picked_qty,
    b.blocked_qty,
    b.available_qty,
    b.uom_id,
    l.expiry_date
FROM inventory.inventory_balance b
JOIN mdm.item i ON i.item_id = b.item_id
LEFT JOIN trace.lot l ON l.lot_id = b.lot_id
WHERE b.available_qty > 0;

CREATE VIEW production.v_work_order_progress AS
SELECT
    wo.work_order_id,
    wo.work_order_no,
    wo.production_plan_id,
    wo.routing_operation_id,
    wo.item_id,
    wo.order_qty,
    wo.uom_id,
    wo.status_code,
    COALESCE(SUM(pr.good_qty), 0) AS good_qty,
    COALESCE(SUM(pr.defect_qty), 0) AS defect_qty,
    COALESCE(SUM(pr.hold_qty), 0) AS hold_qty,
    GREATEST(wo.order_qty - COALESCE(SUM(pr.good_qty), 0), 0) AS remaining_good_qty
FROM production.work_order wo
LEFT JOIN production.production_result pr
       ON pr.work_order_id = wo.work_order_id
      AND pr.status_code NOT IN ('CANCELLED', 'REVERSED')
GROUP BY
    wo.work_order_id,
    wo.work_order_no,
    wo.production_plan_id,
    wo.routing_operation_id,
    wo.item_id,
    wo.order_qty,
    wo.uom_id,
    wo.status_code;

-- --------------------------------------------------------------------------
-- 24. Optional RLS template
-- --------------------------------------------------------------------------
-- The application may set:
--   SET LOCAL app.business_unit_id = '10';
--
-- Example:
-- ALTER TABLE inventory.inventory_balance ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY inventory_balance_bu_policy
-- ON inventory.inventory_balance
-- USING (
--   business_unit_id = current_setting('app.business_unit_id', true)::bigint
-- )
-- WITH CHECK (
--   business_unit_id = current_setting('app.business_unit_id', true)::bigint
-- );

-- --------------------------------------------------------------------------
-- 25. [E-4][E-7] Reference seed data
--     운영정책 코드: ERPNext manufacturing_settings 20개 설정 항목을
--     우리 요구사항(FR)과 대응시켜 선별한 시드. app.operation_policy.policy_code가
--     이 코드를 사용한다 (범위·값은 operation_policy 행으로 관리).
-- --------------------------------------------------------------------------
INSERT INTO mdm.code_group (group_code, group_name, description) VALUES
('OPERATION_POLICY', '운영정책 코드',
 'app.operation_policy.policy_code 목록. ERPNext manufacturing_settings 벤치마킹 + 자체 요구');

INSERT INTO mdm.code_value (code_group_id, code, code_name, display_order)
SELECT cg.code_group_id, v.code, v.code_name, v.ord
FROM mdm.code_group cg,
     (VALUES
        -- ERPNext manufacturing_settings 대응
        ('OVERPRODUCTION_ALLOWANCE_PCT',  '작업지시 초과생산 허용율(%)',            10),  -- FR-WO-033 / overproduction_percentage_for_work_order
        ('EXCESS_ISSUE_ALLOWED',          '요청량 초과 불출 허용 여부',              20),  -- FR-MI-023 / job_card_excess_transfer
        ('EXTRA_MATERIAL_TRANSFER_PCT',   '여유자재 추가 이송율(%)',                30),  -- transfer_extra_materials_percentage
        ('BACKFLUSH_BASIS',               '자동소비 기준(BOM|TRANSFERRED)',         40),  -- backflush_raw_materials_based_on
        ('ALLOW_ACTUAL_CONSUMPTION_ENTRY','실소비 수량 직접 입력 허용',              50),  -- material_consumption
        ('VALIDATE_COMPONENT_QTY_PER_BOM','BOM 기준 투입수량 검증 강제',             60),  -- validate_components_quantities_per_bom
        ('MIN_GAP_BETWEEN_OPERATIONS_MIN','공정 간 최소 간격(분)',                  70),  -- mins_between_operations
        ('ENFORCE_SESSION_TIME_LOG',      '작업 세션 시간기록 강제',                 80),  -- enforce_time_logs
        ('ALLOW_WO_ITEM_EDIT',            '작업지시 품목·수량 수정 허용',            90),  -- allow_editing_of_items_and_quantities_in_work_order
        ('ALLOW_PRODUCTION_ON_HOLIDAYS',  '휴일 생산 허용',                        100),  -- allow_production_on_holidays
        -- 자체 요구 기반
        ('LATE_ENTRY_ALLOWED_HOURS',      '사후입력 허용시간(시간)',                110),  -- FR-PR-029, FR-MI-016
        ('LOT_CREATE_TIMING',             '생산 LOT 생성시점(SESSION_START|FIRST_RESULT|RECEIPT)', 120),  -- NFR-PR-015
        ('FIFO_VIOLATION_POLICY',         'FIFO 위반 처리(BLOCK|WARN|ALLOW)',      130),  -- FR-MI-019
        ('RESULT_CONFIRM_MODE',           '실적 확정 방식(AUTO|MANUAL)',           140)   -- NFR-PR-015
     ) AS v(code, code_name, ord)
WHERE cg.group_code = 'OPERATION_POLICY';

-- [E-7] 재고상태 코드 시드: 창고 간 이동의 shipped~received 구간을
--       IN_TRANSIT으로 표현 (ERPNext add_to_transit 벤치마킹, 구조 변경 없음)
INSERT INTO mdm.code_group (group_code, group_name, description) VALUES
('INVENTORY_STATUS', '재고상태 코드', 'inventory_balance.inventory_status_code 등에서 사용');

INSERT INTO mdm.code_value (code_group_id, code, code_name, display_order)
SELECT cg.code_group_id, v.code, v.code_name, v.ord
FROM mdm.code_group cg,
     (VALUES
        ('AVAILABLE',  '가용',   10),
        ('IN_TRANSIT', '운송중', 20),
        ('ON_HOLD',    '보류',   30),
        ('BLOCKED',    '차단',   40)
     ) AS v(code, code_name, ord)
WHERE cg.group_code = 'INVENTORY_STATUS';

