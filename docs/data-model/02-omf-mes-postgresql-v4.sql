-- OMF-MES PostgreSQL full physical model v4.0
-- Design reference: CREFLEINC/omf-mes @ a8f46f2 (2026-08-25)
-- Target: PostgreSQL 16
-- Generated from a database with every migration through
-- prisma/migrations/20260828000000_add_warehouse_is_defect applied.
-- This file creates the complete schema on an empty database; use the Prisma
-- migrations above for an existing installation.
--
-- Reproduce:
--   createdb omf_mes
--   DATABASE_URL=postgresql://omf:omf@localhost:5432/omf_mes pnpm exec prisma migrate deploy
--   pg_dump -d omf_mes --schema-only --no-owner --no-privileges \
--     -n app -n audit -n integration -n inventory -n logistics -n maintenance \
--     -n mdm -n planning -n production -n quality -n trace
--   (public._prisma_migrations 는 -n 목록에서 자연히 빠진다. \restrict 토큰은
--    pg_dump 가 실행마다 새로 만들므로 그 두 줄만 매번 달라진다.)
--
--
-- PostgreSQL database dump
--

\restrict S18Cp2LuhfUrg19m1fWC6aO47R0wFK81GLCjxnN80NfDX29bWzNKFbUwIqghSt4

-- Dumped from database version 16.15 (Homebrew)
-- Dumped by pg_dump version 16.15 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: app; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA app;


--
-- Name: audit; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA audit;


--
-- Name: integration; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA integration;


--
-- Name: inventory; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA inventory;


--
-- Name: logistics; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA logistics;


--
-- Name: maintenance; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA maintenance;


--
-- Name: mdm; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA mdm;


--
-- Name: planning; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA planning;


--
-- Name: production; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA production;


--
-- Name: quality; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA quality;


--
-- Name: trace; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA trace;


--
-- Name: business_no_t; Type: DOMAIN; Schema: app; Owner: -
--

CREATE DOMAIN app.business_no_t AS character varying(100)
	CONSTRAINT business_no_t_check CHECK (((VALUE)::text <> ''::text));


--
-- Name: code_t; Type: DOMAIN; Schema: app; Owner: -
--

CREATE DOMAIN app.code_t AS character varying(50)
	CONSTRAINT code_t_check CHECK (((VALUE)::text <> ''::text));


--
-- Name: name_t; Type: DOMAIN; Schema: app; Owner: -
--

CREATE DOMAIN app.name_t AS character varying(200)
	CONSTRAINT name_t_check CHECK (((VALUE)::text <> ''::text));


--
-- Name: qty_t; Type: DOMAIN; Schema: app; Owner: -
--

CREATE DOMAIN app.qty_t AS numeric(20,6)
	CONSTRAINT qty_t_check CHECK ((VALUE >= (0)::numeric));


--
-- Name: rate_t; Type: DOMAIN; Schema: app; Owner: -
--

CREATE DOMAIN app.rate_t AS numeric(18,8)
	CONSTRAINT rate_t_check CHECK ((VALUE >= (0)::numeric));


--
-- Name: signed_qty_t; Type: DOMAIN; Schema: app; Owner: -
--

CREATE DOMAIN app.signed_qty_t AS numeric(20,6);


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
END;
$$;


--
-- Name: block_ledger_header_mutation(); Type: FUNCTION; Schema: inventory; Owner: -
--

CREATE FUNCTION inventory.block_ledger_header_mutation() RETURNS trigger
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


--
-- Name: block_ledger_line_mutation(); Type: FUNCTION; Schema: inventory; Owner: -
--

CREATE FUNCTION inventory.block_ledger_line_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION '재고원장 line은 수정·삭제할 수 없습니다. 역트랜잭션을 사용하세요'
        USING ERRCODE = 'raise_exception';
END;
$$;


--
-- Name: check_balance_qty(); Type: FUNCTION; Schema: inventory; Owner: -
--

CREATE FUNCTION inventory.check_balance_qty() RETURNS trigger
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


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: inventory_balance; Type: TABLE; Schema: inventory; Owner: -
--

CREATE TABLE inventory.inventory_balance (
    inventory_balance_id bigint NOT NULL,
    legal_entity_id bigint NOT NULL,
    business_unit_id bigint NOT NULL,
    plant_id bigint NOT NULL,
    warehouse_id bigint NOT NULL,
    location_id bigint NOT NULL,
    item_id bigint NOT NULL,
    lot_id bigint,
    quality_status_code app.code_t NOT NULL,
    inventory_status_code app.code_t NOT NULL,
    ownership_type_code app.code_t NOT NULL,
    owner_partner_id bigint,
    on_hand_qty app.signed_qty_t DEFAULT 0 NOT NULL,
    reserved_qty app.qty_t DEFAULT 0 NOT NULL,
    picked_qty app.qty_t DEFAULT 0 NOT NULL,
    blocked_qty app.qty_t DEFAULT 0 NOT NULL,
    available_qty numeric(20,6) GENERATED ALWAYS AS (((((on_hand_qty)::numeric - (reserved_qty)::numeric) - (picked_qty)::numeric) - (blocked_qty)::numeric)) STORED,
    uom_id bigint NOT NULL,
    last_transaction_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT ck_inventory_balance_lot_item CHECK (((lot_id IS NULL) OR (item_id IS NOT NULL))),
    CONSTRAINT inventory_balance_version_no_check CHECK ((version_no > 0))
);


--
-- Name: lock_balance(bigint, bigint, bigint, bigint, bigint, bigint, bigint, app.code_t, app.code_t, app.code_t, bigint); Type: FUNCTION; Schema: inventory; Owner: -
--

CREATE FUNCTION inventory.lock_balance(p_legal_entity_id bigint, p_business_unit_id bigint, p_plant_id bigint, p_warehouse_id bigint, p_location_id bigint, p_item_id bigint, p_lot_id bigint, p_quality_status_code app.code_t, p_inventory_status_code app.code_t, p_ownership_type_code app.code_t, p_owner_partner_id bigint) RETURNS inventory.inventory_balance
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


--
-- Name: block_closed_work_order_update(); Type: FUNCTION; Schema: production; Owner: -
--

CREATE FUNCTION production.block_closed_work_order_update() RETURNS trigger
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


--
-- Name: check_material_usage_allocation(); Type: FUNCTION; Schema: production; Owner: -
--

CREATE FUNCTION production.check_material_usage_allocation() RETURNS trigger
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


--
-- Name: check_result_lot_allocation(); Type: FUNCTION; Schema: production; Owner: -
--

CREATE FUNCTION production.check_result_lot_allocation() RETURNS trigger
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


--
-- Name: check_work_order_split(); Type: FUNCTION; Schema: production; Owner: -
--

CREATE FUNCTION production.check_work_order_split() RETURNS trigger
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


--
-- Name: check_lot_relation_cycle(); Type: FUNCTION; Schema: trace; Owner: -
--

CREATE FUNCTION trace.check_lot_relation_cycle() RETURNS trigger
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


--
-- Name: app_user; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.app_user (
    app_user_id bigint NOT NULL,
    login_id character varying(100) NOT NULL,
    user_name app.name_t NOT NULL,
    department_id bigint,
    email character varying(200),
    status_code app.code_t DEFAULT 'ACTIVE'::character varying NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT app_user_version_no_check CHECK ((version_no > 0))
);


--
-- Name: app_user_app_user_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.app_user ALTER COLUMN app_user_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.app_user_app_user_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: approval_request; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.approval_request (
    approval_request_id bigint NOT NULL,
    approval_request_no app.business_no_t NOT NULL,
    approval_type_code app.code_t NOT NULL,
    target_type_code app.code_t NOT NULL,
    target_id bigint NOT NULL,
    requested_by bigint NOT NULL,
    requested_at timestamp with time zone NOT NULL,
    status_code app.code_t NOT NULL,
    reason text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    version_no integer DEFAULT 1 NOT NULL,
    target_summary jsonb,
    decided_at timestamp with time zone,
    decided_by bigint,
    CONSTRAINT approval_request_version_no_check CHECK ((version_no > 0))
);


--
-- Name: approval_request_approval_request_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.approval_request ALTER COLUMN approval_request_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.approval_request_approval_request_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: approval_route; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.approval_route (
    approval_route_id bigint NOT NULL,
    approval_type_code app.code_t NOT NULL,
    business_unit_id bigint,
    min_value numeric(20,6),
    max_value numeric(20,6),
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT approval_route_version_no_check CHECK ((version_no > 0)),
    CONSTRAINT ck_approval_route_range CHECK (((max_value IS NULL) OR (min_value IS NULL) OR (max_value >= min_value)))
);


--
-- Name: approval_route_approval_route_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.approval_route ALTER COLUMN approval_route_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.approval_route_approval_route_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: approval_route_step; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.approval_route_step (
    approval_route_step_id bigint NOT NULL,
    approval_route_id bigint NOT NULL,
    step_no integer NOT NULL,
    approver_type_code app.code_t NOT NULL,
    approver_user_id bigint,
    approver_role_id bigint,
    approver_department_id bigint,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    CONSTRAINT approval_route_step_step_no_check CHECK ((step_no > 0)),
    CONSTRAINT ck_approval_route_step_target CHECK ((num_nonnulls(approver_user_id, approver_role_id, approver_department_id) = 1))
);


--
-- Name: approval_route_step_approval_route_step_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.approval_route_step ALTER COLUMN approval_route_step_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.approval_route_step_approval_route_step_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: approval_step; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.approval_step (
    approval_step_id bigint NOT NULL,
    approval_request_id bigint NOT NULL,
    step_no integer NOT NULL,
    approver_id bigint NOT NULL,
    decision_code app.code_t,
    decision_at timestamp with time zone,
    decision_comment text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT approval_step_step_no_check CHECK ((step_no > 0))
);


--
-- Name: approval_step_approval_step_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.approval_step ALTER COLUMN approval_step_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.approval_step_approval_step_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: attachment; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.attachment (
    attachment_id bigint NOT NULL,
    target_type_code app.code_t NOT NULL,
    target_id bigint NOT NULL,
    file_name character varying(255) NOT NULL,
    storage_key character varying(500) NOT NULL,
    mime_type character varying(150) NOT NULL,
    file_size bigint NOT NULL,
    checksum_sha256 character varying(64),
    uploaded_by bigint NOT NULL,
    uploaded_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT attachment_file_size_check CHECK ((file_size >= 0))
);


--
-- Name: attachment_attachment_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.attachment ALTER COLUMN attachment_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.attachment_attachment_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: document_cancellation; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.document_cancellation (
    document_cancellation_id bigint NOT NULL,
    document_type_code app.code_t NOT NULL,
    document_id bigint NOT NULL,
    previous_status_code app.code_t,
    reason_code app.code_t NOT NULL,
    reason_detail text,
    cancelled_at timestamp with time zone NOT NULL,
    cancelled_by bigint NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);


--
-- Name: document_cancellation_document_cancellation_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.document_cancellation ALTER COLUMN document_cancellation_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.document_cancellation_document_cancellation_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: document_issue_log; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.document_issue_log (
    document_issue_log_id bigint NOT NULL,
    document_type_code app.code_t NOT NULL,
    target_type_code app.code_t NOT NULL,
    target_id bigint NOT NULL,
    lot_id bigint,
    issue_seq integer DEFAULT 1 NOT NULL,
    reissue_reason_code app.code_t,
    issued_by bigint NOT NULL,
    issued_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    terminal_id bigint,
    printer_name character varying(100),
    remarks text,
    CONSTRAINT ck_document_reissue_reason CHECK (((issue_seq = 1) OR (reissue_reason_code IS NOT NULL))),
    CONSTRAINT document_issue_log_issue_seq_check CHECK ((issue_seq > 0))
);


--
-- Name: document_issue_log_document_issue_log_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.document_issue_log ALTER COLUMN document_issue_log_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.document_issue_log_document_issue_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: entity_type_registry; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.entity_type_registry (
    entity_type_code app.code_t NOT NULL,
    schema_name character varying(63) NOT NULL,
    table_name character varying(63) NOT NULL,
    id_column_name character varying(63) NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint
);


--
-- Name: exception_case; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.exception_case (
    exception_case_id bigint NOT NULL,
    exception_case_no app.business_no_t NOT NULL,
    exception_type_code app.code_t NOT NULL,
    severity_code app.code_t NOT NULL,
    target_type_code app.code_t NOT NULL,
    target_id bigint NOT NULL,
    assigned_department_id bigint,
    assigned_user_id bigint,
    due_at timestamp with time zone,
    status_code app.code_t NOT NULL,
    resolution text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT exception_case_version_no_check CHECK ((version_no > 0))
);


--
-- Name: exception_case_exception_case_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.exception_case ALTER COLUMN exception_case_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.exception_case_exception_case_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: idempotency_record; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.idempotency_record (
    idempotency_key uuid NOT NULL,
    request_fingerprint text NOT NULL,
    status text NOT NULL,
    response_status integer,
    response_body jsonb,
    app_user_id bigint,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    completed_at timestamp with time zone,
    expires_at timestamp with time zone NOT NULL,
    response_headers jsonb,
    CONSTRAINT ck_idempotency_completed CHECK (((status <> 'COMPLETED'::text) OR ((response_status IS NOT NULL) AND (completed_at IS NOT NULL)))),
    CONSTRAINT ck_idempotency_status CHECK ((status = ANY (ARRAY['IN_PROGRESS'::text, 'COMPLETED'::text])))
);


--
-- Name: TABLE idempotency_record; Type: COMMENT; Schema: app; Owner: -
--

COMMENT ON TABLE app.idempotency_record IS '범용 멱등 저장소. 정본 모델 미포함 — OMF-MES 구현 측 추가분(2026-08-05).';


--
-- Name: COLUMN idempotency_record.response_headers; Type: COMMENT; Schema: app; Owner: -
--

COMMENT ON COLUMN app.idempotency_record.response_headers IS '재생 시 되돌려줄 응답 헤더. PUT 의 ETag 가 여기 담긴다.';


--
-- Name: localized_text; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.localized_text (
    localized_text_id bigint NOT NULL,
    entity_type_code app.code_t NOT NULL,
    entity_id bigint NOT NULL,
    field_code app.code_t NOT NULL,
    language_code character varying(10) NOT NULL,
    localized_value text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT localized_text_version_no_check CHECK ((version_no > 0))
);


--
-- Name: localized_text_localized_text_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.localized_text ALTER COLUMN localized_text_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.localized_text_localized_text_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: notice; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.notice (
    notice_id bigint NOT NULL,
    notice_no app.business_no_t NOT NULL,
    title character varying(300) NOT NULL,
    content text NOT NULL,
    audience_scope jsonb DEFAULT '{}'::jsonb NOT NULL,
    status_code app.code_t DEFAULT 'DRAFT'::character varying NOT NULL,
    published_at timestamp with time zone,
    published_by bigint,
    closed_at timestamp with time zone,
    closed_by bigint,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT notice_version_no_check CHECK ((version_no > 0))
);


--
-- Name: notice_acknowledgement; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.notice_acknowledgement (
    notice_acknowledgement_id bigint NOT NULL,
    notice_id bigint NOT NULL,
    app_user_id bigint NOT NULL,
    acknowledged_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);


--
-- Name: notice_acknowledgement_notice_acknowledgement_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.notice_acknowledgement ALTER COLUMN notice_acknowledgement_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.notice_acknowledgement_notice_acknowledgement_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: notice_notice_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.notice ALTER COLUMN notice_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.notice_notice_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: notification; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.notification (
    notification_id bigint NOT NULL,
    notification_event_id bigint NOT NULL,
    recipient_user_id bigint NOT NULL,
    title character varying(300) NOT NULL,
    message text NOT NULL,
    read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);


--
-- Name: notification_event; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.notification_event (
    notification_event_id bigint NOT NULL,
    event_type_code app.code_t NOT NULL,
    aggregate_type_code app.code_t NOT NULL,
    aggregate_id bigint NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);


--
-- Name: notification_event_notification_event_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.notification_event ALTER COLUMN notification_event_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.notification_event_notification_event_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: notification_notification_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.notification ALTER COLUMN notification_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.notification_notification_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: notification_subscription; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.notification_subscription (
    notification_subscription_id bigint NOT NULL,
    app_user_id bigint NOT NULL,
    event_type_code app.code_t NOT NULL,
    channel_code app.code_t NOT NULL,
    is_enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT notification_subscription_version_no_check CHECK ((version_no > 0))
);


--
-- Name: notification_subscription_notification_subscription_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.notification_subscription ALTER COLUMN notification_subscription_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.notification_subscription_notification_subscription_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: numbering_counter; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.numbering_counter (
    numbering_counter_id bigint NOT NULL,
    numbering_rule_id bigint NOT NULL,
    period_key character varying(20) NOT NULL,
    last_value bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT numbering_counter_last_value_check CHECK ((last_value >= 0))
);


--
-- Name: numbering_counter_numbering_counter_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.numbering_counter ALTER COLUMN numbering_counter_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.numbering_counter_numbering_counter_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: numbering_rule; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.numbering_rule (
    numbering_rule_id bigint NOT NULL,
    document_type_code app.code_t NOT NULL,
    plant_id bigint,
    lot_type_code app.code_t,
    pattern character varying(200) NOT NULL,
    reset_cycle_code app.code_t DEFAULT 'DAILY'::character varying NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT numbering_rule_version_no_check CHECK ((version_no > 0))
);


--
-- Name: numbering_rule_numbering_rule_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.numbering_rule ALTER COLUMN numbering_rule_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.numbering_rule_numbering_rule_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: operation_policy; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.operation_policy (
    operation_policy_id bigint NOT NULL,
    policy_code app.code_t NOT NULL,
    business_unit_id bigint,
    plant_id bigint,
    item_id bigint,
    process_id bigint,
    value_text character varying(500),
    value_numeric numeric(20,6),
    value_boolean boolean,
    effective_from date NOT NULL,
    effective_to date,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT ck_operation_policy_dates CHECK (((effective_to IS NULL) OR (effective_to >= effective_from))),
    CONSTRAINT ck_operation_policy_value CHECK ((num_nonnulls(value_text, value_numeric, value_boolean) >= 1)),
    CONSTRAINT operation_policy_version_no_check CHECK ((version_no > 0))
);


--
-- Name: operation_policy_operation_policy_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.operation_policy ALTER COLUMN operation_policy_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.operation_policy_operation_policy_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: printer; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.printer (
    printer_id bigint NOT NULL,
    plant_id bigint NOT NULL,
    printer_code app.code_t NOT NULL,
    printer_name app.name_t NOT NULL,
    printer_type_code app.code_t NOT NULL,
    connection_uri text NOT NULL,
    dpi integer,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT printer_dpi_check CHECK (((dpi IS NULL) OR (dpi > 0))),
    CONSTRAINT printer_version_no_check CHECK ((version_no > 0))
);


--
-- Name: printer_printer_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.printer ALTER COLUMN printer_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.printer_printer_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: role; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.role (
    role_id bigint NOT NULL,
    role_code app.code_t NOT NULL,
    role_name app.name_t NOT NULL,
    description text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT role_version_no_check CHECK ((version_no > 0))
);


--
-- Name: role_permission; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.role_permission (
    role_permission_id bigint NOT NULL,
    role_id bigint NOT NULL,
    permission_code app.code_t NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint
);


--
-- Name: role_permission_role_permission_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.role_permission ALTER COLUMN role_permission_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.role_permission_role_permission_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: role_role_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.role ALTER COLUMN role_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.role_role_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: user_credential; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.user_credential (
    app_user_id bigint NOT NULL,
    password_hash text NOT NULL,
    password_algo app.code_t DEFAULT 'SCRYPT'::character varying NOT NULL,
    password_changed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    must_change_password boolean DEFAULT false NOT NULL,
    failed_attempt_count integer DEFAULT 0 NOT NULL,
    locked_until timestamp with time zone,
    last_login_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT user_credential_failed_attempt_count_check CHECK ((failed_attempt_count >= 0)),
    CONSTRAINT user_credential_version_no_check CHECK ((version_no > 0))
);


--
-- Name: TABLE user_credential; Type: COMMENT; Schema: app; Owner: -
--

COMMENT ON TABLE app.user_credential IS '관리 화면 로그인 자격증명. 정본 모델 미포함 — OMF-MES 구현 측 추가분(2026-07-28).';


--
-- Name: user_data_scope; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.user_data_scope (
    user_data_scope_id bigint NOT NULL,
    app_user_id bigint NOT NULL,
    business_unit_id bigint,
    plant_id bigint,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    legal_entity_id bigint,
    CONSTRAINT ck_user_data_scope_target CHECK (((legal_entity_id IS NOT NULL) OR (business_unit_id IS NOT NULL) OR (plant_id IS NOT NULL)))
);


--
-- Name: user_data_scope_user_data_scope_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.user_data_scope ALTER COLUMN user_data_scope_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.user_data_scope_user_data_scope_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: user_role; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.user_role (
    user_role_id bigint NOT NULL,
    app_user_id bigint NOT NULL,
    role_id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint
);


--
-- Name: user_role_user_role_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.user_role ALTER COLUMN user_role_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.user_role_user_role_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: worker_lease; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.worker_lease (
    worker_lease_id bigint NOT NULL,
    resource_type_code app.code_t NOT NULL,
    resource_id bigint NOT NULL,
    owner_user_id bigint NOT NULL,
    lease_token uuid NOT NULL,
    acquired_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    released_at timestamp with time zone,
    CONSTRAINT ck_worker_lease_window CHECK ((expires_at > acquired_at))
);


--
-- Name: worker_lease_worker_lease_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.worker_lease ALTER COLUMN worker_lease_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.worker_lease_worker_lease_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: audit_event; Type: TABLE; Schema: audit; Owner: -
--

CREATE TABLE audit.audit_event (
    audit_event_id bigint NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    target_type_code app.code_t NOT NULL,
    target_id bigint NOT NULL,
    event_type_code app.code_t NOT NULL,
    before_value jsonb,
    after_value jsonb,
    reason text,
    performed_by bigint,
    terminal_id bigint,
    correlation_id character varying(150)
)
PARTITION BY RANGE (occurred_at);


--
-- Name: audit_event_audit_event_id_seq; Type: SEQUENCE; Schema: audit; Owner: -
--

ALTER TABLE audit.audit_event ALTER COLUMN audit_event_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME audit.audit_event_audit_event_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: audit_event_default; Type: TABLE; Schema: audit; Owner: -
--

CREATE TABLE audit.audit_event_default (
    audit_event_id bigint NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    target_type_code app.code_t NOT NULL,
    target_id bigint NOT NULL,
    event_type_code app.code_t NOT NULL,
    before_value jsonb,
    after_value jsonb,
    reason text,
    performed_by bigint,
    terminal_id bigint,
    correlation_id character varying(150)
);


--
-- Name: external_document_reference; Type: TABLE; Schema: integration; Owner: -
--

CREATE TABLE integration.external_document_reference (
    external_document_reference_id bigint NOT NULL,
    target_type_code app.code_t NOT NULL,
    target_id bigint NOT NULL,
    external_system_code app.code_t NOT NULL,
    external_document_type_code app.code_t NOT NULL,
    external_document_no character varying(150) NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint
);


--
-- Name: external_document_reference_external_document_reference_id_seq; Type: SEQUENCE; Schema: integration; Owner: -
--

ALTER TABLE integration.external_document_reference ALTER COLUMN external_document_reference_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME integration.external_document_reference_external_document_reference_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: integration_message; Type: TABLE; Schema: integration; Owner: -
--

CREATE TABLE integration.integration_message (
    integration_message_id bigint NOT NULL,
    message_key character varying(150) NOT NULL,
    interface_code app.code_t NOT NULL,
    direction_code app.code_t NOT NULL,
    target_type_code app.code_t NOT NULL,
    target_id bigint NOT NULL,
    payload jsonb NOT NULL,
    status_code app.code_t NOT NULL,
    retry_count integer DEFAULT 0 NOT NULL,
    last_error_message text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    available_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    sent_at timestamp with time zone,
    completed_at timestamp with time zone,
    locked_at timestamp with time zone,
    locked_by character varying(100),
    CONSTRAINT integration_message_retry_count_check CHECK ((retry_count >= 0))
);


--
-- Name: integration_message_integration_message_id_seq; Type: SEQUENCE; Schema: integration; Owner: -
--

ALTER TABLE integration.integration_message ALTER COLUMN integration_message_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME integration.integration_message_integration_message_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: interface_definition; Type: TABLE; Schema: integration; Owner: -
--

CREATE TABLE integration.interface_definition (
    interface_definition_id bigint NOT NULL,
    interface_code app.code_t NOT NULL,
    interface_name app.name_t NOT NULL,
    direction_code app.code_t NOT NULL,
    transport_code app.code_t NOT NULL,
    endpoint_uri text,
    message_schema jsonb,
    retry_policy jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT interface_definition_version_no_check CHECK ((version_no > 0))
);


--
-- Name: interface_definition_interface_definition_id_seq; Type: SEQUENCE; Schema: integration; Owner: -
--

ALTER TABLE integration.interface_definition ALTER COLUMN interface_definition_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME integration.interface_definition_interface_definition_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: outbound_item_setting; Type: TABLE; Schema: integration; Owner: -
--

CREATE TABLE integration.outbound_item_setting (
    outbound_item_setting_id bigint NOT NULL,
    interface_definition_id bigint NOT NULL,
    item_id bigint NOT NULL,
    is_enabled boolean DEFAULT true NOT NULL,
    effective_from timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    effective_to timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    CONSTRAINT ck_outbound_item_setting_dates CHECK (((effective_to IS NULL) OR (effective_to >= effective_from)))
);


--
-- Name: outbound_item_setting_outbound_item_setting_id_seq; Type: SEQUENCE; Schema: integration; Owner: -
--

ALTER TABLE integration.outbound_item_setting ALTER COLUMN outbound_item_setting_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME integration.outbound_item_setting_outbound_item_setting_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: record_provenance; Type: TABLE; Schema: integration; Owner: -
--

CREATE TABLE integration.record_provenance (
    record_provenance_id bigint NOT NULL,
    entity_type_code app.code_t NOT NULL,
    entity_id bigint NOT NULL,
    source_system_code app.code_t NOT NULL,
    source_record_key character varying(300),
    received_at timestamp with time zone NOT NULL,
    integration_message_id bigint,
    attributes jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: record_provenance_record_provenance_id_seq; Type: SEQUENCE; Schema: integration; Owner: -
--

ALTER TABLE integration.record_provenance ALTER COLUMN record_provenance_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME integration.record_provenance_record_provenance_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: handling_unit; Type: TABLE; Schema: inventory; Owner: -
--

CREATE TABLE inventory.handling_unit (
    handling_unit_id bigint NOT NULL,
    handling_unit_no app.business_no_t NOT NULL,
    handling_unit_type_code app.code_t NOT NULL,
    parent_handling_unit_id bigint,
    warehouse_id bigint,
    location_id bigint,
    status_code app.code_t NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT ck_handling_unit_parent CHECK (((parent_handling_unit_id IS NULL) OR (parent_handling_unit_id <> handling_unit_id))),
    CONSTRAINT handling_unit_version_no_check CHECK ((version_no > 0))
);


--
-- Name: handling_unit_content; Type: TABLE; Schema: inventory; Owner: -
--

CREATE TABLE inventory.handling_unit_content (
    handling_unit_content_id bigint NOT NULL,
    handling_unit_id bigint NOT NULL,
    item_id bigint NOT NULL,
    lot_id bigint NOT NULL,
    qty app.qty_t NOT NULL,
    uom_id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    CONSTRAINT handling_unit_content_qty_check CHECK (((qty)::numeric > (0)::numeric))
);


--
-- Name: handling_unit_content_handling_unit_content_id_seq; Type: SEQUENCE; Schema: inventory; Owner: -
--

ALTER TABLE inventory.handling_unit_content ALTER COLUMN handling_unit_content_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME inventory.handling_unit_content_handling_unit_content_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: handling_unit_handling_unit_id_seq; Type: SEQUENCE; Schema: inventory; Owner: -
--

ALTER TABLE inventory.handling_unit ALTER COLUMN handling_unit_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME inventory.handling_unit_handling_unit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: handling_unit_reconfiguration; Type: TABLE; Schema: inventory; Owner: -
--

CREATE TABLE inventory.handling_unit_reconfiguration (
    handling_unit_reconfiguration_id bigint NOT NULL,
    reconfiguration_no app.business_no_t NOT NULL,
    reconfiguration_type_code app.code_t NOT NULL,
    source_handling_unit_id bigint NOT NULL,
    target_handling_unit_id bigint NOT NULL,
    reason_code app.code_t NOT NULL,
    performed_at timestamp with time zone NOT NULL,
    performed_by bigint,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT ck_handling_unit_reconfiguration_distinct CHECK ((source_handling_unit_id <> target_handling_unit_id))
);


--
-- Name: handling_unit_reconfiguration_line; Type: TABLE; Schema: inventory; Owner: -
--

CREATE TABLE inventory.handling_unit_reconfiguration_line (
    handling_unit_reconfiguration_line_id bigint NOT NULL,
    handling_unit_reconfiguration_id bigint NOT NULL,
    line_no integer NOT NULL,
    item_id bigint NOT NULL,
    lot_id bigint NOT NULL,
    moved_qty app.qty_t NOT NULL,
    uom_id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT handling_unit_reconfiguration_line_line_no_check CHECK ((line_no > 0)),
    CONSTRAINT handling_unit_reconfiguration_line_moved_qty_check CHECK (((moved_qty)::numeric > (0)::numeric))
);


--
-- Name: handling_unit_reconfiguration_handling_unit_reconfiguratio_seq1; Type: SEQUENCE; Schema: inventory; Owner: -
--

ALTER TABLE inventory.handling_unit_reconfiguration_line ALTER COLUMN handling_unit_reconfiguration_line_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME inventory.handling_unit_reconfiguration_handling_unit_reconfiguratio_seq1
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: handling_unit_reconfiguration_handling_unit_reconfiguration_seq; Type: SEQUENCE; Schema: inventory; Owner: -
--

ALTER TABLE inventory.handling_unit_reconfiguration ALTER COLUMN handling_unit_reconfiguration_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME inventory.handling_unit_reconfiguration_handling_unit_reconfiguration_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: inventory_adjustment; Type: TABLE; Schema: inventory; Owner: -
--

CREATE TABLE inventory.inventory_adjustment (
    inventory_adjustment_id bigint NOT NULL,
    inventory_adjustment_no app.business_no_t NOT NULL,
    inventory_count_id bigint,
    reason_code app.code_t NOT NULL,
    approval_request_id bigint,
    status_code app.code_t NOT NULL,
    adjusted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT inventory_adjustment_version_no_check CHECK ((version_no > 0))
);


--
-- Name: inventory_adjustment_inventory_adjustment_id_seq; Type: SEQUENCE; Schema: inventory; Owner: -
--

ALTER TABLE inventory.inventory_adjustment ALTER COLUMN inventory_adjustment_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME inventory.inventory_adjustment_inventory_adjustment_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: inventory_adjustment_line; Type: TABLE; Schema: inventory; Owner: -
--

CREATE TABLE inventory.inventory_adjustment_line (
    inventory_adjustment_line_id bigint NOT NULL,
    inventory_adjustment_id bigint NOT NULL,
    line_no integer NOT NULL,
    location_id bigint NOT NULL,
    item_id bigint NOT NULL,
    lot_id bigint,
    quality_status_code app.code_t NOT NULL,
    inventory_status_code app.code_t NOT NULL,
    adjustment_qty app.signed_qty_t NOT NULL,
    uom_id bigint NOT NULL,
    reason_code app.code_t NOT NULL,
    inventory_transaction_line_id bigint,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    CONSTRAINT inventory_adjustment_line_adjustment_qty_check CHECK (((adjustment_qty)::numeric <> (0)::numeric)),
    CONSTRAINT inventory_adjustment_line_line_no_check CHECK ((line_no > 0))
);


--
-- Name: inventory_adjustment_line_inventory_adjustment_line_id_seq; Type: SEQUENCE; Schema: inventory; Owner: -
--

ALTER TABLE inventory.inventory_adjustment_line ALTER COLUMN inventory_adjustment_line_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME inventory.inventory_adjustment_line_inventory_adjustment_line_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: inventory_balance_inventory_balance_id_seq; Type: SEQUENCE; Schema: inventory; Owner: -
--

ALTER TABLE inventory.inventory_balance ALTER COLUMN inventory_balance_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME inventory.inventory_balance_inventory_balance_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: inventory_count; Type: TABLE; Schema: inventory; Owner: -
--

CREATE TABLE inventory.inventory_count (
    inventory_count_id bigint NOT NULL,
    inventory_count_no app.business_no_t NOT NULL,
    count_type_code app.code_t NOT NULL,
    warehouse_id bigint NOT NULL,
    planned_date date NOT NULL,
    blind_count boolean DEFAULT false NOT NULL,
    status_code app.code_t NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT inventory_count_version_no_check CHECK ((version_no > 0))
);


--
-- Name: inventory_count_inventory_count_id_seq; Type: SEQUENCE; Schema: inventory; Owner: -
--

ALTER TABLE inventory.inventory_count ALTER COLUMN inventory_count_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME inventory.inventory_count_inventory_count_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: inventory_count_line; Type: TABLE; Schema: inventory; Owner: -
--

CREATE TABLE inventory.inventory_count_line (
    inventory_count_line_id bigint NOT NULL,
    inventory_count_id bigint NOT NULL,
    line_no integer NOT NULL,
    location_id bigint NOT NULL,
    item_id bigint NOT NULL,
    lot_id bigint,
    system_qty app.qty_t NOT NULL,
    counted_qty app.qty_t NOT NULL,
    variance_qty numeric(20,6) GENERATED ALWAYS AS (((counted_qty)::numeric - (system_qty)::numeric)) STORED,
    uom_id bigint NOT NULL,
    variance_reason_code app.code_t,
    counted_by bigint,
    counted_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    CONSTRAINT inventory_count_line_line_no_check CHECK ((line_no > 0))
);


--
-- Name: inventory_count_line_inventory_count_line_id_seq; Type: SEQUENCE; Schema: inventory; Owner: -
--

ALTER TABLE inventory.inventory_count_line ALTER COLUMN inventory_count_line_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME inventory.inventory_count_line_inventory_count_line_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: inventory_reservation; Type: TABLE; Schema: inventory; Owner: -
--

CREATE TABLE inventory.inventory_reservation (
    inventory_reservation_id bigint NOT NULL,
    reservation_no app.business_no_t NOT NULL,
    reservation_type_code app.code_t NOT NULL,
    source_document_type_code app.code_t NOT NULL,
    source_document_id bigint NOT NULL,
    item_id bigint NOT NULL,
    lot_id bigint,
    warehouse_id bigint NOT NULL,
    location_id bigint,
    reserved_qty app.qty_t NOT NULL,
    released_qty app.qty_t DEFAULT 0 NOT NULL,
    consumed_qty app.qty_t DEFAULT 0 NOT NULL,
    uom_id bigint NOT NULL,
    status_code app.code_t NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT ck_reservation_qty CHECK ((((released_qty)::numeric + (consumed_qty)::numeric) <= (reserved_qty)::numeric)),
    CONSTRAINT inventory_reservation_reserved_qty_check CHECK (((reserved_qty)::numeric > (0)::numeric)),
    CONSTRAINT inventory_reservation_version_no_check CHECK ((version_no > 0))
);


--
-- Name: inventory_reservation_inventory_reservation_id_seq; Type: SEQUENCE; Schema: inventory; Owner: -
--

ALTER TABLE inventory.inventory_reservation ALTER COLUMN inventory_reservation_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME inventory.inventory_reservation_inventory_reservation_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: inventory_transaction; Type: TABLE; Schema: inventory; Owner: -
--

CREATE TABLE inventory.inventory_transaction (
    inventory_transaction_id bigint NOT NULL,
    business_date date NOT NULL,
    transaction_no app.business_no_t NOT NULL,
    transaction_type_code app.code_t NOT NULL,
    plant_id bigint NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    recorded_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    source_document_type_code app.code_t NOT NULL,
    source_document_id bigint NOT NULL,
    status_code app.code_t NOT NULL,
    idempotency_key character varying(150) NOT NULL,
    reversal_of_transaction_id bigint,
    reversal_of_business_date date,
    created_by bigint,
    CONSTRAINT ck_inventory_reversal_pair CHECK (((reversal_of_transaction_id IS NULL) = (reversal_of_business_date IS NULL)))
)
PARTITION BY RANGE (business_date);


--
-- Name: inventory_transaction_default; Type: TABLE; Schema: inventory; Owner: -
--

CREATE TABLE inventory.inventory_transaction_default (
    inventory_transaction_id bigint NOT NULL,
    business_date date NOT NULL,
    transaction_no app.business_no_t NOT NULL,
    transaction_type_code app.code_t NOT NULL,
    plant_id bigint NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    recorded_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    source_document_type_code app.code_t NOT NULL,
    source_document_id bigint NOT NULL,
    status_code app.code_t NOT NULL,
    idempotency_key character varying(150) NOT NULL,
    reversal_of_transaction_id bigint,
    reversal_of_business_date date,
    created_by bigint,
    CONSTRAINT ck_inventory_reversal_pair CHECK (((reversal_of_transaction_id IS NULL) = (reversal_of_business_date IS NULL)))
);


--
-- Name: inventory_transaction_inventory_transaction_id_seq; Type: SEQUENCE; Schema: inventory; Owner: -
--

ALTER TABLE inventory.inventory_transaction ALTER COLUMN inventory_transaction_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME inventory.inventory_transaction_inventory_transaction_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: inventory_transaction_line; Type: TABLE; Schema: inventory; Owner: -
--

CREATE TABLE inventory.inventory_transaction_line (
    inventory_transaction_line_id bigint NOT NULL,
    inventory_transaction_id bigint NOT NULL,
    business_date date NOT NULL,
    line_no integer NOT NULL,
    item_id bigint NOT NULL,
    lot_id bigint,
    qty app.qty_t NOT NULL,
    uom_id bigint NOT NULL,
    from_warehouse_id bigint,
    from_location_id bigint,
    from_quality_status_code app.code_t,
    from_inventory_status_code app.code_t,
    to_warehouse_id bigint,
    to_location_id bigint,
    to_quality_status_code app.code_t,
    to_inventory_status_code app.code_t,
    ownership_type_code app.code_t NOT NULL,
    owner_partner_id bigint,
    handling_unit_id bigint,
    from_qty_after_transaction numeric(20,6),
    to_qty_after_transaction numeric(20,6),
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    CONSTRAINT ck_inventory_transaction_direction CHECK (((from_location_id IS NOT NULL) OR (to_location_id IS NOT NULL))),
    CONSTRAINT inventory_transaction_line_line_no_check CHECK ((line_no > 0)),
    CONSTRAINT inventory_transaction_line_qty_check CHECK (((qty)::numeric > (0)::numeric))
);


--
-- Name: inventory_transaction_line_inventory_transaction_line_id_seq; Type: SEQUENCE; Schema: inventory; Owner: -
--

ALTER TABLE inventory.inventory_transaction_line ALTER COLUMN inventory_transaction_line_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME inventory.inventory_transaction_line_inventory_transaction_line_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: item; Type: TABLE; Schema: mdm; Owner: -
--

CREATE TABLE mdm.item (
    item_id bigint NOT NULL,
    item_code app.code_t NOT NULL,
    item_name app.name_t NOT NULL,
    item_type_code app.code_t NOT NULL,
    base_uom_id bigint NOT NULL,
    lot_control_type_code app.code_t NOT NULL,
    serial_control_type_code app.code_t DEFAULT 'NONE'::character varying NOT NULL,
    shelf_life_days integer,
    inspection_required boolean DEFAULT false NOT NULL,
    fifo_policy_code app.code_t DEFAULT 'FIFO'::character varying NOT NULL,
    negative_stock_allowed boolean DEFAULT false NOT NULL,
    storage_condition_code app.code_t,
    opened_shelf_life_hours integer,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    lot_storage_uom_id bigint,
    default_lot_size app.qty_t,
    is_development_item boolean DEFAULT false NOT NULL,
    recycle_type_code app.code_t,
    CONSTRAINT ck_item_default_lot_size CHECK (((default_lot_size IS NULL) OR ((default_lot_size)::numeric > (0)::numeric))),
    CONSTRAINT item_opened_shelf_life_hours_check CHECK (((opened_shelf_life_hours IS NULL) OR (opened_shelf_life_hours > 0))),
    CONSTRAINT item_shelf_life_days_check CHECK (((shelf_life_days IS NULL) OR (shelf_life_days >= 0))),
    CONSTRAINT item_version_no_check CHECK ((version_no > 0))
);


--
-- Name: lot; Type: TABLE; Schema: trace; Owner: -
--

CREATE TABLE trace.lot (
    lot_id bigint NOT NULL,
    lot_no app.business_no_t NOT NULL,
    item_id bigint NOT NULL,
    lot_type_code app.code_t NOT NULL,
    plant_id bigint NOT NULL,
    initial_qty app.qty_t NOT NULL,
    uom_id bigint NOT NULL,
    manufactured_at timestamp with time zone,
    expiry_date date,
    source_type_code app.code_t NOT NULL,
    source_id bigint NOT NULL,
    status_code app.code_t DEFAULT 'ACTIVE'::character varying NOT NULL,
    parent_lot_id bigint,
    remarks text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    bom_id bigint,
    bom_version integer,
    work_order_lot_seq integer,
    CONSTRAINT ck_lot_bom_snapshot CHECK (((bom_id IS NULL) = (bom_version IS NULL))),
    CONSTRAINT ck_lot_initial_qty CHECK ((((initial_qty)::numeric > (0)::numeric) OR (((initial_qty)::numeric = (0)::numeric) AND ((lot_type_code)::text = 'PREISSUED'::text)))),
    CONSTRAINT ck_lot_parent CHECK (((parent_lot_id IS NULL) OR (parent_lot_id <> lot_id))),
    CONSTRAINT ck_lot_work_order_seq CHECK (((work_order_lot_seq IS NULL) OR (work_order_lot_seq > 0))),
    CONSTRAINT lot_version_no_check CHECK ((version_no > 0))
);


--
-- Name: v_inventory_available; Type: VIEW; Schema: inventory; Owner: -
--

CREATE VIEW inventory.v_inventory_available AS
 SELECT b.inventory_balance_id,
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
   FROM ((inventory.inventory_balance b
     JOIN mdm.item i ON ((i.item_id = b.item_id)))
     LEFT JOIN trace.lot l ON ((l.lot_id = b.lot_id)))
  WHERE (b.available_qty > (0)::numeric);


--
-- Name: asn; Type: TABLE; Schema: logistics; Owner: -
--

CREATE TABLE logistics.asn (
    asn_id bigint NOT NULL,
    asn_no app.business_no_t NOT NULL,
    supplier_id bigint NOT NULL,
    plant_id bigint NOT NULL,
    expected_arrival_date date NOT NULL,
    delivery_note_no character varying(100),
    status_code app.code_t NOT NULL,
    remarks text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT asn_version_no_check CHECK ((version_no > 0))
);


--
-- Name: asn_asn_id_seq; Type: SEQUENCE; Schema: logistics; Owner: -
--

ALTER TABLE logistics.asn ALTER COLUMN asn_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME logistics.asn_asn_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: asn_line; Type: TABLE; Schema: logistics; Owner: -
--

CREATE TABLE logistics.asn_line (
    asn_line_id bigint NOT NULL,
    asn_id bigint NOT NULL,
    line_no integer NOT NULL,
    purchase_order_line_id bigint,
    item_id bigint NOT NULL,
    expected_qty app.qty_t NOT NULL,
    uom_id bigint NOT NULL,
    supplier_lot_no character varying(100),
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    CONSTRAINT asn_line_expected_qty_check CHECK (((expected_qty)::numeric > (0)::numeric)),
    CONSTRAINT asn_line_line_no_check CHECK ((line_no > 0))
);


--
-- Name: asn_line_asn_line_id_seq; Type: SEQUENCE; Schema: logistics; Owner: -
--

ALTER TABLE logistics.asn_line ALTER COLUMN asn_line_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME logistics.asn_line_asn_line_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: goods_issue; Type: TABLE; Schema: logistics; Owner: -
--

CREATE TABLE logistics.goods_issue (
    goods_issue_id bigint NOT NULL,
    goods_issue_no app.business_no_t NOT NULL,
    issue_type_code app.code_t NOT NULL,
    source_document_type_code app.code_t NOT NULL,
    source_document_id bigint NOT NULL,
    source_warehouse_id bigint NOT NULL,
    destination_type_code app.code_t NOT NULL,
    destination_id bigint NOT NULL,
    issued_at timestamp with time zone NOT NULL,
    status_code app.code_t NOT NULL,
    reason_code app.code_t,
    replacement_expected boolean,
    remarks text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    approval_request_id bigint,
    cancelled_at timestamp with time zone,
    cancelled_by bigint,
    cancellation_reason_code app.code_t,
    CONSTRAINT goods_issue_version_no_check CHECK ((version_no > 0))
);


--
-- Name: goods_issue_goods_issue_id_seq; Type: SEQUENCE; Schema: logistics; Owner: -
--

ALTER TABLE logistics.goods_issue ALTER COLUMN goods_issue_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME logistics.goods_issue_goods_issue_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: goods_issue_line; Type: TABLE; Schema: logistics; Owner: -
--

CREATE TABLE logistics.goods_issue_line (
    goods_issue_line_id bigint NOT NULL,
    goods_issue_id bigint NOT NULL,
    line_no integer NOT NULL,
    picking_line_id bigint,
    item_id bigint NOT NULL,
    lot_id bigint NOT NULL,
    issue_qty app.qty_t NOT NULL,
    uom_id bigint NOT NULL,
    source_location_id bigint NOT NULL,
    inventory_transaction_line_id bigint,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    CONSTRAINT goods_issue_line_issue_qty_check CHECK (((issue_qty)::numeric > (0)::numeric)),
    CONSTRAINT goods_issue_line_line_no_check CHECK ((line_no > 0))
);


--
-- Name: goods_issue_line_goods_issue_line_id_seq; Type: SEQUENCE; Schema: logistics; Owner: -
--

ALTER TABLE logistics.goods_issue_line ALTER COLUMN goods_issue_line_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME logistics.goods_issue_line_goods_issue_line_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: goods_receipt; Type: TABLE; Schema: logistics; Owner: -
--

CREATE TABLE logistics.goods_receipt (
    goods_receipt_id bigint NOT NULL,
    goods_receipt_no app.business_no_t NOT NULL,
    receipt_type_code app.code_t NOT NULL,
    plant_id bigint NOT NULL,
    warehouse_id bigint NOT NULL,
    receipt_datetime timestamp with time zone NOT NULL,
    status_code app.code_t NOT NULL,
    source_document_type_code app.code_t NOT NULL,
    source_document_id bigint NOT NULL,
    reason_code app.code_t,
    remarks text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT goods_receipt_version_no_check CHECK ((version_no > 0))
);


--
-- Name: goods_receipt_goods_receipt_id_seq; Type: SEQUENCE; Schema: logistics; Owner: -
--

ALTER TABLE logistics.goods_receipt ALTER COLUMN goods_receipt_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME logistics.goods_receipt_goods_receipt_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: goods_receipt_line; Type: TABLE; Schema: logistics; Owner: -
--

CREATE TABLE logistics.goods_receipt_line (
    goods_receipt_line_id bigint NOT NULL,
    goods_receipt_id bigint NOT NULL,
    line_no integer NOT NULL,
    inbound_receipt_line_id bigint,
    item_id bigint NOT NULL,
    lot_id bigint NOT NULL,
    receipt_qty app.qty_t NOT NULL,
    uom_id bigint NOT NULL,
    quality_status_code app.code_t NOT NULL,
    inventory_status_code app.code_t NOT NULL,
    destination_location_id bigint NOT NULL,
    original_shipment_lot_allocation_id bigint,
    inventory_transaction_line_id bigint,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    expected_qty app.qty_t,
    variance_reason_code app.code_t,
    variance_note text,
    CONSTRAINT goods_receipt_line_line_no_check CHECK ((line_no > 0)),
    CONSTRAINT goods_receipt_line_receipt_qty_check CHECK (((receipt_qty)::numeric > (0)::numeric))
);


--
-- Name: goods_receipt_line_goods_receipt_line_id_seq; Type: SEQUENCE; Schema: logistics; Owner: -
--

ALTER TABLE logistics.goods_receipt_line ALTER COLUMN goods_receipt_line_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME logistics.goods_receipt_line_goods_receipt_line_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: inbound_receipt; Type: TABLE; Schema: logistics; Owner: -
--

CREATE TABLE logistics.inbound_receipt (
    inbound_receipt_id bigint NOT NULL,
    inbound_receipt_no app.business_no_t NOT NULL,
    supplier_id bigint NOT NULL,
    plant_id bigint NOT NULL,
    receipt_datetime timestamp with time zone NOT NULL,
    delivery_note_no character varying(100),
    vehicle_no character varying(50),
    dock_location_id bigint,
    exception_type_code app.code_t,
    exception_reason text,
    approval_request_id bigint,
    status_code app.code_t NOT NULL,
    received_by bigint,
    remarks text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT inbound_receipt_version_no_check CHECK ((version_no > 0))
);


--
-- Name: inbound_receipt_inbound_receipt_id_seq; Type: SEQUENCE; Schema: logistics; Owner: -
--

ALTER TABLE logistics.inbound_receipt ALTER COLUMN inbound_receipt_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME logistics.inbound_receipt_inbound_receipt_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: inbound_receipt_line; Type: TABLE; Schema: logistics; Owner: -
--

CREATE TABLE logistics.inbound_receipt_line (
    inbound_receipt_line_id bigint NOT NULL,
    inbound_receipt_id bigint NOT NULL,
    line_no integer NOT NULL,
    purchase_order_line_id bigint,
    asn_line_id bigint,
    item_id bigint NOT NULL,
    received_qty app.qty_t NOT NULL,
    uom_id bigint NOT NULL,
    package_count integer,
    supplier_lot_no character varying(100),
    supplier_lot_missing boolean DEFAULT false NOT NULL,
    substitute_lot_reason_code app.code_t,
    manufactured_date date,
    expiry_date date,
    inspection_required boolean NOT NULL,
    status_code app.code_t NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT ck_inbound_expiry CHECK (((expiry_date IS NULL) OR (manufactured_date IS NULL) OR (expiry_date >= manufactured_date))),
    CONSTRAINT inbound_receipt_line_line_no_check CHECK ((line_no > 0)),
    CONSTRAINT inbound_receipt_line_package_count_check CHECK (((package_count IS NULL) OR (package_count > 0))),
    CONSTRAINT inbound_receipt_line_received_qty_check CHECK (((received_qty)::numeric > (0)::numeric)),
    CONSTRAINT inbound_receipt_line_version_no_check CHECK ((version_no > 0))
);


--
-- Name: inbound_receipt_line_inbound_receipt_line_id_seq; Type: SEQUENCE; Schema: logistics; Owner: -
--

ALTER TABLE logistics.inbound_receipt_line ALTER COLUMN inbound_receipt_line_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME logistics.inbound_receipt_line_inbound_receipt_line_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: inbound_variance; Type: TABLE; Schema: logistics; Owner: -
--

CREATE TABLE logistics.inbound_variance (
    inbound_variance_id bigint NOT NULL,
    inbound_receipt_line_id bigint NOT NULL,
    variance_type_code app.code_t NOT NULL,
    variance_qty app.qty_t NOT NULL,
    uom_id bigint NOT NULL,
    reason_code app.code_t NOT NULL,
    approval_request_id bigint,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    CONSTRAINT inbound_variance_variance_qty_check CHECK (((variance_qty)::numeric > (0)::numeric))
);


--
-- Name: inbound_variance_inbound_variance_id_seq; Type: SEQUENCE; Schema: logistics; Owner: -
--

ALTER TABLE logistics.inbound_variance ALTER COLUMN inbound_variance_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME logistics.inbound_variance_inbound_variance_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: material_issue_request; Type: TABLE; Schema: logistics; Owner: -
--

CREATE TABLE logistics.material_issue_request (
    material_issue_request_id bigint NOT NULL,
    issue_request_no app.business_no_t NOT NULL,
    work_order_id bigint NOT NULL,
    destination_location_id bigint NOT NULL,
    required_at timestamp with time zone,
    status_code app.code_t NOT NULL,
    requested_by bigint,
    remarks text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    reason_code app.code_t,
    CONSTRAINT material_issue_request_version_no_check CHECK ((version_no > 0))
);


--
-- Name: material_issue_request_line; Type: TABLE; Schema: logistics; Owner: -
--

CREATE TABLE logistics.material_issue_request_line (
    material_issue_request_line_id bigint NOT NULL,
    material_issue_request_id bigint NOT NULL,
    line_no integer NOT NULL,
    bom_component_id bigint,
    item_id bigint NOT NULL,
    requested_qty app.qty_t NOT NULL,
    issued_qty app.qty_t DEFAULT 0 NOT NULL,
    uom_id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    CONSTRAINT ck_material_issue_line_qty CHECK (((issued_qty)::numeric <= (requested_qty)::numeric)),
    CONSTRAINT material_issue_request_line_line_no_check CHECK ((line_no > 0)),
    CONSTRAINT material_issue_request_line_requested_qty_check CHECK (((requested_qty)::numeric > (0)::numeric))
);


--
-- Name: material_issue_request_line_material_issue_request_line_id_seq; Type: SEQUENCE; Schema: logistics; Owner: -
--

ALTER TABLE logistics.material_issue_request_line ALTER COLUMN material_issue_request_line_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME logistics.material_issue_request_line_material_issue_request_line_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: material_issue_request_material_issue_request_id_seq; Type: SEQUENCE; Schema: logistics; Owner: -
--

ALTER TABLE logistics.material_issue_request ALTER COLUMN material_issue_request_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME logistics.material_issue_request_material_issue_request_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: picking_line; Type: TABLE; Schema: logistics; Owner: -
--

CREATE TABLE logistics.picking_line (
    picking_line_id bigint NOT NULL,
    picking_order_id bigint NOT NULL,
    line_no integer NOT NULL,
    item_id bigint NOT NULL,
    lot_id bigint NOT NULL,
    location_id bigint NOT NULL,
    planned_qty app.qty_t NOT NULL,
    picked_qty app.qty_t DEFAULT 0 NOT NULL,
    uom_id bigint NOT NULL,
    inventory_reservation_id bigint,
    status_code app.code_t NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT ck_picking_qty CHECK (((picked_qty)::numeric <= (planned_qty)::numeric)),
    CONSTRAINT picking_line_line_no_check CHECK ((line_no > 0)),
    CONSTRAINT picking_line_planned_qty_check CHECK (((planned_qty)::numeric > (0)::numeric)),
    CONSTRAINT picking_line_version_no_check CHECK ((version_no > 0))
);


--
-- Name: picking_line_picking_line_id_seq; Type: SEQUENCE; Schema: logistics; Owner: -
--

ALTER TABLE logistics.picking_line ALTER COLUMN picking_line_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME logistics.picking_line_picking_line_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: picking_order; Type: TABLE; Schema: logistics; Owner: -
--

CREATE TABLE logistics.picking_order (
    picking_order_id bigint NOT NULL,
    picking_order_no app.business_no_t NOT NULL,
    picking_type_code app.code_t NOT NULL,
    source_document_type_code app.code_t NOT NULL,
    source_document_id bigint NOT NULL,
    warehouse_id bigint NOT NULL,
    status_code app.code_t NOT NULL,
    assigned_worker_id bigint,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT picking_order_version_no_check CHECK ((version_no > 0))
);


--
-- Name: picking_order_picking_order_id_seq; Type: SEQUENCE; Schema: logistics; Owner: -
--

ALTER TABLE logistics.picking_order ALTER COLUMN picking_order_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME logistics.picking_order_picking_order_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: purchase_order; Type: TABLE; Schema: logistics; Owner: -
--

CREATE TABLE logistics.purchase_order (
    purchase_order_id bigint NOT NULL,
    purchase_order_no app.business_no_t NOT NULL,
    erp_purchase_order_no character varying(100),
    supplier_id bigint NOT NULL,
    business_unit_id bigint NOT NULL,
    plant_id bigint NOT NULL,
    order_date date NOT NULL,
    expected_receipt_date date,
    status_code app.code_t NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT purchase_order_version_no_check CHECK ((version_no > 0))
);


--
-- Name: purchase_order_line; Type: TABLE; Schema: logistics; Owner: -
--

CREATE TABLE logistics.purchase_order_line (
    purchase_order_line_id bigint NOT NULL,
    purchase_order_id bigint NOT NULL,
    line_no integer NOT NULL,
    item_id bigint NOT NULL,
    ordered_qty app.qty_t NOT NULL,
    uom_id bigint NOT NULL,
    received_qty app.qty_t DEFAULT 0 NOT NULL,
    tolerance_over_qty app.qty_t DEFAULT 0 NOT NULL,
    tolerance_under_qty app.qty_t DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT ck_po_line_received CHECK (((received_qty)::numeric <= ((ordered_qty)::numeric + (tolerance_over_qty)::numeric))),
    CONSTRAINT purchase_order_line_line_no_check CHECK ((line_no > 0)),
    CONSTRAINT purchase_order_line_ordered_qty_check CHECK (((ordered_qty)::numeric > (0)::numeric)),
    CONSTRAINT purchase_order_line_version_no_check CHECK ((version_no > 0))
);


--
-- Name: purchase_order_line_purchase_order_line_id_seq; Type: SEQUENCE; Schema: logistics; Owner: -
--

ALTER TABLE logistics.purchase_order_line ALTER COLUMN purchase_order_line_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME logistics.purchase_order_line_purchase_order_line_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: purchase_order_purchase_order_id_seq; Type: SEQUENCE; Schema: logistics; Owner: -
--

ALTER TABLE logistics.purchase_order ALTER COLUMN purchase_order_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME logistics.purchase_order_purchase_order_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: putaway_rule; Type: TABLE; Schema: logistics; Owner: -
--

CREATE TABLE logistics.putaway_rule (
    putaway_rule_id bigint NOT NULL,
    item_id bigint NOT NULL,
    warehouse_id bigint NOT NULL,
    location_id bigint,
    capacity_qty app.qty_t NOT NULL,
    uom_id bigint NOT NULL,
    priority_no integer DEFAULT 100 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    remarks text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT putaway_rule_capacity_qty_check CHECK (((capacity_qty)::numeric > (0)::numeric)),
    CONSTRAINT putaway_rule_version_no_check CHECK ((version_no > 0))
);


--
-- Name: putaway_rule_putaway_rule_id_seq; Type: SEQUENCE; Schema: logistics; Owner: -
--

ALTER TABLE logistics.putaway_rule ALTER COLUMN putaway_rule_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME logistics.putaway_rule_putaway_rule_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: putaway_task; Type: TABLE; Schema: logistics; Owner: -
--

CREATE TABLE logistics.putaway_task (
    putaway_task_id bigint NOT NULL,
    putaway_task_no app.business_no_t NOT NULL,
    goods_receipt_line_id bigint NOT NULL,
    item_id bigint NOT NULL,
    lot_id bigint NOT NULL,
    task_qty app.qty_t NOT NULL,
    uom_id bigint NOT NULL,
    from_location_id bigint NOT NULL,
    recommended_location_id bigint,
    applied_putaway_rule_id bigint,
    actual_location_id bigint,
    priority_no integer DEFAULT 100 NOT NULL,
    assigned_worker_id bigint,
    status_code app.code_t NOT NULL,
    completed_at timestamp with time zone,
    inventory_transaction_line_id bigint,
    remarks text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    reason_code app.code_t,
    CONSTRAINT ck_putaway_completed CHECK (((completed_at IS NULL) OR (actual_location_id IS NOT NULL))),
    CONSTRAINT putaway_task_task_qty_check CHECK (((task_qty)::numeric > (0)::numeric)),
    CONSTRAINT putaway_task_version_no_check CHECK ((version_no > 0))
);


--
-- Name: putaway_task_putaway_task_id_seq; Type: SEQUENCE; Schema: logistics; Owner: -
--

ALTER TABLE logistics.putaway_task ALTER COLUMN putaway_task_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME logistics.putaway_task_putaway_task_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: recycle_entry; Type: TABLE; Schema: logistics; Owner: -
--

CREATE TABLE logistics.recycle_entry (
    recycle_entry_id bigint NOT NULL,
    recycle_entry_no app.business_no_t NOT NULL,
    plant_id bigint NOT NULL,
    item_id bigint NOT NULL,
    lot_id bigint,
    source_document_type_code app.code_t NOT NULL,
    source_document_id bigint NOT NULL,
    recycle_type_code app.code_t NOT NULL,
    recycle_qty app.qty_t NOT NULL,
    uom_id bigint NOT NULL,
    destination_location_id bigint,
    status_code app.code_t NOT NULL,
    processed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT recycle_entry_recycle_qty_check CHECK (((recycle_qty)::numeric > (0)::numeric)),
    CONSTRAINT recycle_entry_version_no_check CHECK ((version_no > 0))
);


--
-- Name: recycle_entry_recycle_entry_id_seq; Type: SEQUENCE; Schema: logistics; Owner: -
--

ALTER TABLE logistics.recycle_entry ALTER COLUMN recycle_entry_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME logistics.recycle_entry_recycle_entry_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: sales_order; Type: TABLE; Schema: logistics; Owner: -
--

CREATE TABLE logistics.sales_order (
    sales_order_id bigint NOT NULL,
    sales_order_no app.business_no_t NOT NULL,
    erp_sales_order_no character varying(100),
    customer_id bigint NOT NULL,
    ship_to_partner_id bigint NOT NULL,
    order_date date NOT NULL,
    status_code app.code_t NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT sales_order_version_no_check CHECK ((version_no > 0))
);


--
-- Name: sales_order_line; Type: TABLE; Schema: logistics; Owner: -
--

CREATE TABLE logistics.sales_order_line (
    sales_order_line_id bigint NOT NULL,
    sales_order_id bigint NOT NULL,
    line_no integer NOT NULL,
    item_id bigint NOT NULL,
    ordered_qty app.qty_t NOT NULL,
    uom_id bigint NOT NULL,
    requested_delivery_date date,
    shipped_qty app.qty_t DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT ck_sales_shipped_qty CHECK (((shipped_qty)::numeric <= (ordered_qty)::numeric)),
    CONSTRAINT sales_order_line_line_no_check CHECK ((line_no > 0)),
    CONSTRAINT sales_order_line_ordered_qty_check CHECK (((ordered_qty)::numeric > (0)::numeric)),
    CONSTRAINT sales_order_line_version_no_check CHECK ((version_no > 0))
);


--
-- Name: sales_order_line_sales_order_line_id_seq; Type: SEQUENCE; Schema: logistics; Owner: -
--

ALTER TABLE logistics.sales_order_line ALTER COLUMN sales_order_line_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME logistics.sales_order_line_sales_order_line_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: sales_order_sales_order_id_seq; Type: SEQUENCE; Schema: logistics; Owner: -
--

ALTER TABLE logistics.sales_order ALTER COLUMN sales_order_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME logistics.sales_order_sales_order_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: shipment; Type: TABLE; Schema: logistics; Owner: -
--

CREATE TABLE logistics.shipment (
    shipment_id bigint NOT NULL,
    shipment_no app.business_no_t NOT NULL,
    shipment_request_id bigint NOT NULL,
    warehouse_id bigint NOT NULL,
    vehicle_no character varying(50),
    driver_name character varying(100),
    seal_no character varying(50),
    transport_document_no character varying(100),
    loading_worker_id bigint,
    carrier_id bigint,
    loaded_at timestamp with time zone,
    shipped_at timestamp with time zone,
    status_code app.code_t NOT NULL,
    erp_delivery_no character varying(100),
    remarks text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    confirmed_at timestamp with time zone,
    confirmed_by bigint,
    cancelled_at timestamp with time zone,
    cancelled_by bigint,
    cancellation_reason_code app.code_t,
    CONSTRAINT shipment_version_no_check CHECK ((version_no > 0))
);


--
-- Name: shipment_line; Type: TABLE; Schema: logistics; Owner: -
--

CREATE TABLE logistics.shipment_line (
    shipment_line_id bigint NOT NULL,
    shipment_id bigint NOT NULL,
    line_no integer NOT NULL,
    shipment_request_line_id bigint NOT NULL,
    item_id bigint NOT NULL,
    shipped_qty app.qty_t NOT NULL,
    uom_id bigint NOT NULL,
    goods_issue_line_id bigint,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    CONSTRAINT shipment_line_line_no_check CHECK ((line_no > 0)),
    CONSTRAINT shipment_line_shipped_qty_check CHECK (((shipped_qty)::numeric > (0)::numeric))
);


--
-- Name: shipment_line_shipment_line_id_seq; Type: SEQUENCE; Schema: logistics; Owner: -
--

ALTER TABLE logistics.shipment_line ALTER COLUMN shipment_line_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME logistics.shipment_line_shipment_line_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: shipment_lot_allocation; Type: TABLE; Schema: logistics; Owner: -
--

CREATE TABLE logistics.shipment_lot_allocation (
    shipment_lot_allocation_id bigint NOT NULL,
    shipment_line_id bigint NOT NULL,
    lot_id bigint NOT NULL,
    handling_unit_id bigint,
    allocated_qty app.qty_t NOT NULL,
    uom_id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    CONSTRAINT shipment_lot_allocation_allocated_qty_check CHECK (((allocated_qty)::numeric > (0)::numeric))
);


--
-- Name: shipment_lot_allocation_shipment_lot_allocation_id_seq; Type: SEQUENCE; Schema: logistics; Owner: -
--

ALTER TABLE logistics.shipment_lot_allocation ALTER COLUMN shipment_lot_allocation_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME logistics.shipment_lot_allocation_shipment_lot_allocation_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: shipment_request; Type: TABLE; Schema: logistics; Owner: -
--

CREATE TABLE logistics.shipment_request (
    shipment_request_id bigint NOT NULL,
    shipment_request_no app.business_no_t NOT NULL,
    customer_id bigint NOT NULL,
    ship_to_partner_id bigint NOT NULL,
    requested_ship_date date NOT NULL,
    status_code app.code_t NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    ship_time_slot_start time without time zone,
    ship_time_slot_end time without time zone,
    CONSTRAINT ck_shipment_request_time_slot CHECK (((ship_time_slot_end IS NULL) OR (ship_time_slot_start IS NULL) OR (ship_time_slot_end > ship_time_slot_start))),
    CONSTRAINT shipment_request_version_no_check CHECK ((version_no > 0))
);


--
-- Name: shipment_request_line; Type: TABLE; Schema: logistics; Owner: -
--

CREATE TABLE logistics.shipment_request_line (
    shipment_request_line_id bigint NOT NULL,
    shipment_request_id bigint NOT NULL,
    line_no integer NOT NULL,
    sales_order_line_id bigint,
    item_id bigint NOT NULL,
    requested_qty app.qty_t NOT NULL,
    allocated_qty app.qty_t DEFAULT 0 NOT NULL,
    shipped_qty app.qty_t DEFAULT 0 NOT NULL,
    uom_id bigint NOT NULL,
    customer_lot_requirement character varying(200),
    shipping_inspection_required boolean DEFAULT false NOT NULL,
    minimum_remaining_shelf_life_days integer,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT ck_shipment_request_qty CHECK ((((shipped_qty)::numeric <= (allocated_qty)::numeric) AND ((allocated_qty)::numeric <= (requested_qty)::numeric))),
    CONSTRAINT shipment_request_line_line_no_check CHECK ((line_no > 0)),
    CONSTRAINT shipment_request_line_minimum_remaining_shelf_life_days_check CHECK (((minimum_remaining_shelf_life_days IS NULL) OR (minimum_remaining_shelf_life_days >= 0))),
    CONSTRAINT shipment_request_line_requested_qty_check CHECK (((requested_qty)::numeric > (0)::numeric)),
    CONSTRAINT shipment_request_line_version_no_check CHECK ((version_no > 0))
);


--
-- Name: shipment_request_line_shipment_request_line_id_seq; Type: SEQUENCE; Schema: logistics; Owner: -
--

ALTER TABLE logistics.shipment_request_line ALTER COLUMN shipment_request_line_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME logistics.shipment_request_line_shipment_request_line_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: shipment_request_shipment_request_id_seq; Type: SEQUENCE; Schema: logistics; Owner: -
--

ALTER TABLE logistics.shipment_request ALTER COLUMN shipment_request_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME logistics.shipment_request_shipment_request_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: shipment_shipment_id_seq; Type: SEQUENCE; Schema: logistics; Owner: -
--

ALTER TABLE logistics.shipment ALTER COLUMN shipment_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME logistics.shipment_shipment_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: shopfloor_receipt; Type: TABLE; Schema: logistics; Owner: -
--

CREATE TABLE logistics.shopfloor_receipt (
    shopfloor_receipt_id bigint NOT NULL,
    shopfloor_receipt_no app.business_no_t NOT NULL,
    goods_issue_id bigint NOT NULL,
    work_order_id bigint NOT NULL,
    destination_location_id bigint NOT NULL,
    received_at timestamp with time zone NOT NULL,
    received_by bigint,
    status_code app.code_t NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT shopfloor_receipt_version_no_check CHECK ((version_no > 0))
);


--
-- Name: shopfloor_receipt_line; Type: TABLE; Schema: logistics; Owner: -
--

CREATE TABLE logistics.shopfloor_receipt_line (
    shopfloor_receipt_line_id bigint NOT NULL,
    shopfloor_receipt_id bigint NOT NULL,
    goods_issue_line_id bigint NOT NULL,
    item_id bigint NOT NULL,
    lot_id bigint NOT NULL,
    issued_qty app.qty_t NOT NULL,
    received_qty app.qty_t NOT NULL,
    variance_qty numeric(20,6) GENERATED ALWAYS AS (((issued_qty)::numeric - (received_qty)::numeric)) STORED,
    uom_id bigint NOT NULL,
    variance_reason_code app.code_t,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    CONSTRAINT ck_shopfloor_receipt_qty CHECK ((((issued_qty)::numeric >= (0)::numeric) AND ((received_qty)::numeric >= (0)::numeric) AND ((received_qty)::numeric <= (issued_qty)::numeric)))
);


--
-- Name: shopfloor_receipt_line_shopfloor_receipt_line_id_seq; Type: SEQUENCE; Schema: logistics; Owner: -
--

ALTER TABLE logistics.shopfloor_receipt_line ALTER COLUMN shopfloor_receipt_line_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME logistics.shopfloor_receipt_line_shopfloor_receipt_line_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: shopfloor_receipt_shopfloor_receipt_id_seq; Type: SEQUENCE; Schema: logistics; Owner: -
--

ALTER TABLE logistics.shopfloor_receipt ALTER COLUMN shopfloor_receipt_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME logistics.shopfloor_receipt_shopfloor_receipt_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: stock_transfer; Type: TABLE; Schema: logistics; Owner: -
--

CREATE TABLE logistics.stock_transfer (
    stock_transfer_id bigint NOT NULL,
    stock_transfer_no app.business_no_t NOT NULL,
    transfer_type_code app.code_t NOT NULL,
    from_business_unit_id bigint NOT NULL,
    to_business_unit_id bigint NOT NULL,
    from_warehouse_id bigint NOT NULL,
    to_warehouse_id bigint NOT NULL,
    requested_at timestamp with time zone NOT NULL,
    shipped_at timestamp with time zone,
    received_at timestamp with time zone,
    status_code app.code_t NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT stock_transfer_version_no_check CHECK ((version_no > 0))
);


--
-- Name: stock_transfer_line; Type: TABLE; Schema: logistics; Owner: -
--

CREATE TABLE logistics.stock_transfer_line (
    stock_transfer_line_id bigint NOT NULL,
    stock_transfer_id bigint NOT NULL,
    line_no integer NOT NULL,
    item_id bigint NOT NULL,
    lot_id bigint NOT NULL,
    requested_qty app.qty_t NOT NULL,
    shipped_qty app.qty_t DEFAULT 0 NOT NULL,
    received_qty app.qty_t DEFAULT 0 NOT NULL,
    uom_id bigint NOT NULL,
    from_location_id bigint NOT NULL,
    to_location_id bigint NOT NULL,
    issue_transaction_line_id bigint,
    receipt_transaction_line_id bigint,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    CONSTRAINT ck_stock_transfer_locations CHECK ((from_location_id <> to_location_id)),
    CONSTRAINT ck_stock_transfer_qty CHECK ((((shipped_qty)::numeric <= (requested_qty)::numeric) AND ((received_qty)::numeric <= (shipped_qty)::numeric))),
    CONSTRAINT stock_transfer_line_line_no_check CHECK ((line_no > 0)),
    CONSTRAINT stock_transfer_line_requested_qty_check CHECK (((requested_qty)::numeric > (0)::numeric))
);


--
-- Name: stock_transfer_line_stock_transfer_line_id_seq; Type: SEQUENCE; Schema: logistics; Owner: -
--

ALTER TABLE logistics.stock_transfer_line ALTER COLUMN stock_transfer_line_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME logistics.stock_transfer_line_stock_transfer_line_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: stock_transfer_stock_transfer_id_seq; Type: SEQUENCE; Schema: logistics; Owner: -
--

ALTER TABLE logistics.stock_transfer ALTER COLUMN stock_transfer_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME logistics.stock_transfer_stock_transfer_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: subcontract_issue; Type: TABLE; Schema: logistics; Owner: -
--

CREATE TABLE logistics.subcontract_issue (
    subcontract_issue_id bigint NOT NULL,
    subcontract_order_id bigint NOT NULL,
    goods_issue_id bigint NOT NULL,
    issued_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    status_code app.code_t DEFAULT 'COMPLETED'::character varying NOT NULL,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT subcontract_issue_version_no_check CHECK ((version_no > 0))
);


--
-- Name: subcontract_issue_subcontract_issue_id_seq; Type: SEQUENCE; Schema: logistics; Owner: -
--

ALTER TABLE logistics.subcontract_issue ALTER COLUMN subcontract_issue_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME logistics.subcontract_issue_subcontract_issue_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: subcontract_order; Type: TABLE; Schema: logistics; Owner: -
--

CREATE TABLE logistics.subcontract_order (
    subcontract_order_id bigint NOT NULL,
    subcontract_order_no app.business_no_t NOT NULL,
    work_order_id bigint,
    partner_id bigint NOT NULL,
    process_id bigint NOT NULL,
    item_id bigint NOT NULL,
    order_qty app.qty_t NOT NULL,
    uom_id bigint NOT NULL,
    expected_return_date date,
    status_code app.code_t NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT subcontract_order_order_qty_check CHECK (((order_qty)::numeric > (0)::numeric)),
    CONSTRAINT subcontract_order_version_no_check CHECK ((version_no > 0))
);


--
-- Name: subcontract_order_subcontract_order_id_seq; Type: SEQUENCE; Schema: logistics; Owner: -
--

ALTER TABLE logistics.subcontract_order ALTER COLUMN subcontract_order_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME logistics.subcontract_order_subcontract_order_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: subcontract_receipt; Type: TABLE; Schema: logistics; Owner: -
--

CREATE TABLE logistics.subcontract_receipt (
    subcontract_receipt_id bigint NOT NULL,
    subcontract_order_id bigint NOT NULL,
    goods_receipt_id bigint NOT NULL,
    supplier_lot_no character varying(100),
    received_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    status_code app.code_t DEFAULT 'COMPLETED'::character varying NOT NULL,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT subcontract_receipt_version_no_check CHECK ((version_no > 0))
);


--
-- Name: subcontract_receipt_subcontract_receipt_id_seq; Type: SEQUENCE; Schema: logistics; Owner: -
--

ALTER TABLE logistics.subcontract_receipt ALTER COLUMN subcontract_receipt_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME logistics.subcontract_receipt_subcontract_receipt_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: subcontract_reconciliation; Type: TABLE; Schema: logistics; Owner: -
--

CREATE TABLE logistics.subcontract_reconciliation (
    subcontract_reconciliation_id bigint NOT NULL,
    subcontract_order_id bigint NOT NULL,
    settlement_seq integer NOT NULL,
    reconciled_at timestamp with time zone NOT NULL,
    issued_qty app.qty_t DEFAULT 0 NOT NULL,
    received_good_qty app.qty_t DEFAULT 0 NOT NULL,
    received_defect_qty app.qty_t DEFAULT 0 NOT NULL,
    scrap_qty app.qty_t DEFAULT 0 NOT NULL,
    lost_qty app.qty_t DEFAULT 0 NOT NULL,
    adjusted_qty app.qty_t DEFAULT 0 NOT NULL,
    remaining_qty app.qty_t DEFAULT 0 NOT NULL,
    uom_id bigint NOT NULL,
    status_code app.code_t NOT NULL,
    confirmed_by bigint,
    confirmed_at timestamp with time zone,
    remarks text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    CONSTRAINT subcontract_reconciliation_settlement_seq_check CHECK ((settlement_seq > 0))
);


--
-- Name: subcontract_reconciliation_subcontract_reconciliation_id_seq; Type: SEQUENCE; Schema: logistics; Owner: -
--

ALTER TABLE logistics.subcontract_reconciliation ALTER COLUMN subcontract_reconciliation_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME logistics.subcontract_reconciliation_subcontract_reconciliation_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: breakdown; Type: TABLE; Schema: maintenance; Owner: -
--

CREATE TABLE maintenance.breakdown (
    breakdown_id bigint NOT NULL,
    breakdown_no app.business_no_t NOT NULL,
    equipment_id bigint NOT NULL,
    reported_at timestamp with time zone NOT NULL,
    reported_by bigint,
    symptom_code app.code_t,
    description text NOT NULL,
    severity_code app.code_t NOT NULL,
    status_code app.code_t NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    root_cause text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT breakdown_version_no_check CHECK ((version_no > 0)),
    CONSTRAINT ck_breakdown_window CHECK (((completed_at IS NULL) OR (started_at IS NULL) OR (completed_at >= started_at)))
);


--
-- Name: breakdown_breakdown_id_seq; Type: SEQUENCE; Schema: maintenance; Owner: -
--

ALTER TABLE maintenance.breakdown ALTER COLUMN breakdown_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME maintenance.breakdown_breakdown_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: collection_channel; Type: TABLE; Schema: maintenance; Owner: -
--

CREATE TABLE maintenance.collection_channel (
    collection_channel_id bigint NOT NULL,
    equipment_id bigint NOT NULL,
    channel_code app.code_t NOT NULL,
    channel_name app.name_t NOT NULL,
    data_type_code app.code_t NOT NULL,
    uom_id bigint,
    collection_interval_sec integer,
    lower_limit numeric(20,6),
    upper_limit numeric(20,6),
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT ck_collection_channel_limits CHECK (((lower_limit IS NULL) OR (upper_limit IS NULL) OR (lower_limit <= upper_limit))),
    CONSTRAINT collection_channel_collection_interval_sec_check CHECK (((collection_interval_sec IS NULL) OR (collection_interval_sec > 0))),
    CONSTRAINT collection_channel_version_no_check CHECK ((version_no > 0))
);


--
-- Name: collection_channel_collection_channel_id_seq; Type: SEQUENCE; Schema: maintenance; Owner: -
--

ALTER TABLE maintenance.collection_channel ALTER COLUMN collection_channel_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME maintenance.collection_channel_collection_channel_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: collection_observation; Type: TABLE; Schema: maintenance; Owner: -
--

CREATE TABLE maintenance.collection_observation (
    collection_observation_id bigint NOT NULL,
    collection_channel_id bigint NOT NULL,
    observed_at timestamp with time zone NOT NULL,
    numeric_value numeric(20,6),
    text_value text,
    boolean_value boolean,
    quality_code app.code_t,
    source_message_id character varying(200),
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT ck_collection_observation_value CHECK ((num_nonnulls(numeric_value, text_value, boolean_value) = 1))
);


--
-- Name: collection_observation_collection_observation_id_seq; Type: SEQUENCE; Schema: maintenance; Owner: -
--

ALTER TABLE maintenance.collection_observation ALTER COLUMN collection_observation_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME maintenance.collection_observation_collection_observation_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: equipment_downtime; Type: TABLE; Schema: maintenance; Owner: -
--

CREATE TABLE maintenance.equipment_downtime (
    equipment_downtime_id bigint NOT NULL,
    equipment_id bigint NOT NULL,
    breakdown_id bigint,
    downtime_type_code app.code_t NOT NULL,
    started_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone,
    reason_code app.code_t,
    closed_by bigint,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    CONSTRAINT ck_equipment_downtime_window CHECK (((ended_at IS NULL) OR (ended_at >= started_at)))
);


--
-- Name: equipment_downtime_equipment_downtime_id_seq; Type: SEQUENCE; Schema: maintenance; Owner: -
--

ALTER TABLE maintenance.equipment_downtime ALTER COLUMN equipment_downtime_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME maintenance.equipment_downtime_equipment_downtime_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: equipment_inspection; Type: TABLE; Schema: maintenance; Owner: -
--

CREATE TABLE maintenance.equipment_inspection (
    equipment_inspection_id bigint NOT NULL,
    inspection_no app.business_no_t NOT NULL,
    equipment_id bigint NOT NULL,
    inspection_type_code app.code_t NOT NULL,
    scheduled_at timestamp with time zone,
    inspected_at timestamp with time zone,
    inspected_by bigint,
    judgment_code app.code_t,
    status_code app.code_t NOT NULL,
    remarks text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT equipment_inspection_version_no_check CHECK ((version_no > 0))
);


--
-- Name: equipment_inspection_equipment_inspection_id_seq; Type: SEQUENCE; Schema: maintenance; Owner: -
--

ALTER TABLE maintenance.equipment_inspection ALTER COLUMN equipment_inspection_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME maintenance.equipment_inspection_equipment_inspection_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: equipment_inspection_result; Type: TABLE; Schema: maintenance; Owner: -
--

CREATE TABLE maintenance.equipment_inspection_result (
    equipment_inspection_result_id bigint NOT NULL,
    equipment_inspection_id bigint NOT NULL,
    equipment_inspection_item_id bigint NOT NULL,
    numeric_value numeric(20,6),
    text_value text,
    boolean_value boolean,
    judgment_code app.code_t NOT NULL,
    remarks text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    CONSTRAINT ck_equipment_inspection_result_value CHECK ((num_nonnulls(numeric_value, text_value, boolean_value) <= 1))
);


--
-- Name: equipment_inspection_result_equipment_inspection_result_id_seq; Type: SEQUENCE; Schema: maintenance; Owner: -
--

ALTER TABLE maintenance.equipment_inspection_result ALTER COLUMN equipment_inspection_result_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME maintenance.equipment_inspection_result_equipment_inspection_result_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: maintenance_order; Type: TABLE; Schema: maintenance; Owner: -
--

CREATE TABLE maintenance.maintenance_order (
    maintenance_order_id bigint NOT NULL,
    maintenance_order_no app.business_no_t NOT NULL,
    equipment_id bigint NOT NULL,
    breakdown_id bigint,
    order_type_code app.code_t NOT NULL,
    priority_code app.code_t NOT NULL,
    scheduled_start_at timestamp with time zone,
    scheduled_end_at timestamp with time zone,
    assigned_worker_id bigint,
    status_code app.code_t NOT NULL,
    cancellation_reason_code app.code_t,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT ck_maintenance_order_window CHECK (((scheduled_end_at IS NULL) OR (scheduled_start_at IS NULL) OR (scheduled_end_at >= scheduled_start_at))),
    CONSTRAINT maintenance_order_version_no_check CHECK ((version_no > 0))
);


--
-- Name: maintenance_order_maintenance_order_id_seq; Type: SEQUENCE; Schema: maintenance; Owner: -
--

ALTER TABLE maintenance.maintenance_order ALTER COLUMN maintenance_order_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME maintenance.maintenance_order_maintenance_order_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: maintenance_result; Type: TABLE; Schema: maintenance; Owner: -
--

CREATE TABLE maintenance.maintenance_result (
    maintenance_result_id bigint NOT NULL,
    maintenance_order_id bigint NOT NULL,
    result_seq integer NOT NULL,
    action_code app.code_t NOT NULL,
    action_description text NOT NULL,
    started_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone NOT NULL,
    performed_by bigint,
    result_code app.code_t NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    CONSTRAINT ck_maintenance_result_window CHECK ((completed_at >= started_at)),
    CONSTRAINT maintenance_result_result_seq_check CHECK ((result_seq > 0))
);


--
-- Name: maintenance_result_maintenance_result_id_seq; Type: SEQUENCE; Schema: maintenance; Owner: -
--

ALTER TABLE maintenance.maintenance_result ALTER COLUMN maintenance_result_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME maintenance.maintenance_result_maintenance_result_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: planned_stop; Type: TABLE; Schema: maintenance; Owner: -
--

CREATE TABLE maintenance.planned_stop (
    planned_stop_id bigint NOT NULL,
    equipment_id bigint,
    production_line_id bigint,
    stop_type_code app.code_t NOT NULL,
    planned_start_at timestamp with time zone NOT NULL,
    planned_end_at timestamp with time zone NOT NULL,
    reason text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT ck_planned_stop_target CHECK ((num_nonnulls(equipment_id, production_line_id) = 1)),
    CONSTRAINT ck_planned_stop_window CHECK ((planned_end_at > planned_start_at)),
    CONSTRAINT planned_stop_version_no_check CHECK ((version_no > 0))
);


--
-- Name: planned_stop_planned_stop_id_seq; Type: SEQUENCE; Schema: maintenance; Owner: -
--

ALTER TABLE maintenance.planned_stop ALTER COLUMN planned_stop_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME maintenance.planned_stop_planned_stop_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: tool_usage; Type: TABLE; Schema: maintenance; Owner: -
--

CREATE TABLE maintenance.tool_usage (
    tool_usage_id bigint NOT NULL,
    mold_id bigint NOT NULL,
    equipment_id bigint,
    work_order_id bigint,
    usage_type_code app.code_t NOT NULL,
    shot_count bigint,
    used_from timestamp with time zone NOT NULL,
    used_to timestamp with time zone,
    recorded_by bigint,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT ck_tool_usage_window CHECK (((used_to IS NULL) OR (used_to >= used_from))),
    CONSTRAINT tool_usage_shot_count_check CHECK (((shot_count IS NULL) OR (shot_count >= 0)))
);


--
-- Name: tool_usage_tool_usage_id_seq; Type: SEQUENCE; Schema: maintenance; Owner: -
--

ALTER TABLE maintenance.tool_usage ALTER COLUMN tool_usage_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME maintenance.tool_usage_tool_usage_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: business_unit; Type: TABLE; Schema: mdm; Owner: -
--

CREATE TABLE mdm.business_unit (
    business_unit_id bigint NOT NULL,
    legal_entity_id bigint NOT NULL,
    business_unit_code app.code_t NOT NULL,
    business_unit_name app.name_t NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT business_unit_version_no_check CHECK ((version_no > 0))
);


--
-- Name: business_unit_business_unit_id_seq; Type: SEQUENCE; Schema: mdm; Owner: -
--

ALTER TABLE mdm.business_unit ALTER COLUMN business_unit_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME mdm.business_unit_business_unit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: code_group; Type: TABLE; Schema: mdm; Owner: -
--

CREATE TABLE mdm.code_group (
    code_group_id bigint NOT NULL,
    group_code app.code_t NOT NULL,
    group_name app.name_t NOT NULL,
    description text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT code_group_version_no_check CHECK ((version_no > 0))
);


--
-- Name: code_group_code_group_id_seq; Type: SEQUENCE; Schema: mdm; Owner: -
--

ALTER TABLE mdm.code_group ALTER COLUMN code_group_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME mdm.code_group_code_group_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: code_value; Type: TABLE; Schema: mdm; Owner: -
--

CREATE TABLE mdm.code_value (
    code_value_id bigint NOT NULL,
    code_group_id bigint NOT NULL,
    code app.code_t NOT NULL,
    code_name app.name_t NOT NULL,
    display_order integer DEFAULT 0 NOT NULL,
    effective_from date,
    effective_to date,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT ck_code_value_dates CHECK (((effective_to IS NULL) OR (effective_from IS NULL) OR (effective_to >= effective_from))),
    CONSTRAINT code_value_version_no_check CHECK ((version_no > 0))
);


--
-- Name: code_value_code_value_id_seq; Type: SEQUENCE; Schema: mdm; Owner: -
--

ALTER TABLE mdm.code_value ALTER COLUMN code_value_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME mdm.code_value_code_value_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: department; Type: TABLE; Schema: mdm; Owner: -
--

CREATE TABLE mdm.department (
    department_id bigint NOT NULL,
    department_code app.code_t NOT NULL,
    department_name app.name_t NOT NULL,
    parent_department_id bigint,
    business_unit_id bigint,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT ck_department_parent CHECK (((parent_department_id IS NULL) OR (parent_department_id <> department_id))),
    CONSTRAINT department_version_no_check CHECK ((version_no > 0))
);


--
-- Name: department_department_id_seq; Type: SEQUENCE; Schema: mdm; Owner: -
--

ALTER TABLE mdm.department ALTER COLUMN department_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME mdm.department_department_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: equipment; Type: TABLE; Schema: mdm; Owner: -
--

CREATE TABLE mdm.equipment (
    equipment_id bigint NOT NULL,
    plant_id bigint NOT NULL,
    equipment_code app.code_t NOT NULL,
    equipment_name app.name_t NOT NULL,
    equipment_type_code app.code_t NOT NULL,
    process_id bigint,
    production_line_id bigint,
    status_code app.code_t NOT NULL,
    calibration_required boolean DEFAULT false NOT NULL,
    last_calibration_date date,
    calibration_due_date date,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    location_id bigint,
    CONSTRAINT equipment_version_no_check CHECK ((version_no > 0))
);


--
-- Name: equipment_equipment_id_seq; Type: SEQUENCE; Schema: mdm; Owner: -
--

ALTER TABLE mdm.equipment ALTER COLUMN equipment_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME mdm.equipment_equipment_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: equipment_group; Type: TABLE; Schema: mdm; Owner: -
--

CREATE TABLE mdm.equipment_group (
    equipment_group_id bigint NOT NULL,
    plant_id bigint NOT NULL,
    equipment_group_code app.code_t NOT NULL,
    equipment_group_name app.name_t NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT equipment_group_version_no_check CHECK ((version_no > 0))
);


--
-- Name: equipment_group_equipment_group_id_seq; Type: SEQUENCE; Schema: mdm; Owner: -
--

ALTER TABLE mdm.equipment_group ALTER COLUMN equipment_group_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME mdm.equipment_group_equipment_group_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: equipment_group_inspection_item; Type: TABLE; Schema: mdm; Owner: -
--

CREATE TABLE mdm.equipment_group_inspection_item (
    equipment_group_inspection_item_id bigint NOT NULL,
    equipment_group_id bigint NOT NULL,
    equipment_inspection_item_id bigint NOT NULL,
    display_order integer DEFAULT 100 NOT NULL,
    is_required_override boolean,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint
);


--
-- Name: equipment_group_inspection_it_equipment_group_inspection_it_seq; Type: SEQUENCE; Schema: mdm; Owner: -
--

ALTER TABLE mdm.equipment_group_inspection_item ALTER COLUMN equipment_group_inspection_item_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME mdm.equipment_group_inspection_it_equipment_group_inspection_it_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: equipment_group_member; Type: TABLE; Schema: mdm; Owner: -
--

CREATE TABLE mdm.equipment_group_member (
    equipment_group_member_id bigint NOT NULL,
    equipment_group_id bigint NOT NULL,
    equipment_id bigint NOT NULL,
    effective_from date NOT NULL,
    effective_to date,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    CONSTRAINT ck_equipment_group_member_dates CHECK (((effective_to IS NULL) OR (effective_to >= effective_from)))
);


--
-- Name: equipment_group_member_equipment_group_member_id_seq; Type: SEQUENCE; Schema: mdm; Owner: -
--

ALTER TABLE mdm.equipment_group_member ALTER COLUMN equipment_group_member_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME mdm.equipment_group_member_equipment_group_member_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: equipment_inspection_item; Type: TABLE; Schema: mdm; Owner: -
--

CREATE TABLE mdm.equipment_inspection_item (
    equipment_inspection_item_id bigint NOT NULL,
    inspection_item_code app.code_t NOT NULL,
    inspection_item_name app.name_t NOT NULL,
    data_type_code app.code_t NOT NULL,
    uom_id bigint,
    lower_limit numeric(20,6),
    upper_limit numeric(20,6),
    is_required boolean DEFAULT true NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT ck_equipment_inspection_limits CHECK (((lower_limit IS NULL) OR (upper_limit IS NULL) OR (lower_limit <= upper_limit))),
    CONSTRAINT equipment_inspection_item_version_no_check CHECK ((version_no > 0))
);


--
-- Name: equipment_inspection_item_assignment; Type: TABLE; Schema: mdm; Owner: -
--

CREATE TABLE mdm.equipment_inspection_item_assignment (
    equipment_inspection_item_assignment_id bigint NOT NULL,
    equipment_id bigint NOT NULL,
    equipment_inspection_item_id bigint NOT NULL,
    display_order integer DEFAULT 100 NOT NULL,
    is_required_override boolean,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint
);


--
-- Name: equipment_inspection_item_ass_equipment_inspection_item_ass_seq; Type: SEQUENCE; Schema: mdm; Owner: -
--

ALTER TABLE mdm.equipment_inspection_item_assignment ALTER COLUMN equipment_inspection_item_assignment_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME mdm.equipment_inspection_item_ass_equipment_inspection_item_ass_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: equipment_inspection_item_equipment_inspection_item_id_seq; Type: SEQUENCE; Schema: mdm; Owner: -
--

ALTER TABLE mdm.equipment_inspection_item ALTER COLUMN equipment_inspection_item_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME mdm.equipment_inspection_item_equipment_inspection_item_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: item_bu_item_map; Type: TABLE; Schema: mdm; Owner: -
--

CREATE TABLE mdm.item_bu_item_map (
    item_bu_item_map_id bigint NOT NULL,
    from_business_unit_id bigint NOT NULL,
    from_item_id bigint NOT NULL,
    to_business_unit_id bigint NOT NULL,
    to_item_id bigint NOT NULL,
    effective_from date NOT NULL,
    effective_to date,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    CONSTRAINT ck_item_bu_map_dates CHECK (((effective_to IS NULL) OR (effective_to >= effective_from))),
    CONSTRAINT ck_item_bu_map_distinct CHECK ((from_business_unit_id <> to_business_unit_id))
);


--
-- Name: item_bu_item_map_item_bu_item_map_id_seq; Type: SEQUENCE; Schema: mdm; Owner: -
--

ALTER TABLE mdm.item_bu_item_map ALTER COLUMN item_bu_item_map_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME mdm.item_bu_item_map_item_bu_item_map_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: item_external_code; Type: TABLE; Schema: mdm; Owner: -
--

CREATE TABLE mdm.item_external_code (
    item_external_code_id bigint NOT NULL,
    item_id bigint NOT NULL,
    external_system_code app.code_t NOT NULL,
    partner_id bigint,
    external_item_code character varying(100) NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint
);


--
-- Name: item_external_code_item_external_code_id_seq; Type: SEQUENCE; Schema: mdm; Owner: -
--

ALTER TABLE mdm.item_external_code ALTER COLUMN item_external_code_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME mdm.item_external_code_item_external_code_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: item_item_id_seq; Type: SEQUENCE; Schema: mdm; Owner: -
--

ALTER TABLE mdm.item ALTER COLUMN item_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME mdm.item_item_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: item_uom_conversion; Type: TABLE; Schema: mdm; Owner: -
--

CREATE TABLE mdm.item_uom_conversion (
    item_uom_conversion_id bigint NOT NULL,
    item_id bigint NOT NULL,
    from_uom_id bigint NOT NULL,
    to_uom_id bigint NOT NULL,
    conversion_rate app.rate_t NOT NULL,
    effective_from date NOT NULL,
    effective_to date,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    CONSTRAINT ck_item_uom_dates CHECK (((effective_to IS NULL) OR (effective_to >= effective_from))),
    CONSTRAINT ck_item_uom_distinct CHECK ((from_uom_id <> to_uom_id)),
    CONSTRAINT item_uom_conversion_conversion_rate_check CHECK (((conversion_rate)::numeric > (0)::numeric))
);


--
-- Name: item_uom_conversion_item_uom_conversion_id_seq; Type: SEQUENCE; Schema: mdm; Owner: -
--

ALTER TABLE mdm.item_uom_conversion ALTER COLUMN item_uom_conversion_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME mdm.item_uom_conversion_item_uom_conversion_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: legal_entity; Type: TABLE; Schema: mdm; Owner: -
--

CREATE TABLE mdm.legal_entity (
    legal_entity_id bigint NOT NULL,
    legal_entity_code app.code_t NOT NULL,
    legal_entity_name app.name_t NOT NULL,
    country_code character varying(3) NOT NULL,
    timezone_code character varying(64) NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT legal_entity_version_no_check CHECK ((version_no > 0))
);


--
-- Name: legal_entity_legal_entity_id_seq; Type: SEQUENCE; Schema: mdm; Owner: -
--

ALTER TABLE mdm.legal_entity ALTER COLUMN legal_entity_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME mdm.legal_entity_legal_entity_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: location; Type: TABLE; Schema: mdm; Owner: -
--

CREATE TABLE mdm.location (
    location_id bigint NOT NULL,
    warehouse_id bigint NOT NULL,
    parent_location_id bigint,
    location_code app.code_t NOT NULL,
    location_name app.name_t NOT NULL,
    location_type_code app.code_t NOT NULL,
    quality_zone_code app.code_t,
    storage_condition_code app.code_t,
    allow_mixed_item boolean DEFAULT true NOT NULL,
    allow_mixed_lot boolean DEFAULT true NOT NULL,
    capacity_qty app.qty_t,
    capacity_uom_id bigint,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT ck_location_capacity CHECK (((capacity_qty IS NULL) = (capacity_uom_id IS NULL))),
    CONSTRAINT location_version_no_check CHECK ((version_no > 0))
);


--
-- Name: location_location_id_seq; Type: SEQUENCE; Schema: mdm; Owner: -
--

ALTER TABLE mdm.location ALTER COLUMN location_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME mdm.location_location_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: mold; Type: TABLE; Schema: mdm; Owner: -
--

CREATE TABLE mdm.mold (
    mold_id bigint NOT NULL,
    plant_id bigint NOT NULL,
    mold_code app.code_t NOT NULL,
    mold_name app.name_t NOT NULL,
    cavity_count integer DEFAULT 1 NOT NULL,
    guaranteed_shot_count bigint,
    current_shot_count bigint DEFAULT 0 NOT NULL,
    status_code app.code_t NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT mold_cavity_count_check CHECK ((cavity_count > 0)),
    CONSTRAINT mold_current_shot_count_check CHECK ((current_shot_count >= 0)),
    CONSTRAINT mold_guaranteed_shot_count_check CHECK (((guaranteed_shot_count IS NULL) OR (guaranteed_shot_count >= 0))),
    CONSTRAINT mold_version_no_check CHECK ((version_no > 0))
);


--
-- Name: mold_mold_id_seq; Type: SEQUENCE; Schema: mdm; Owner: -
--

ALTER TABLE mdm.mold ALTER COLUMN mold_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME mdm.mold_mold_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: partner; Type: TABLE; Schema: mdm; Owner: -
--

CREATE TABLE mdm.partner (
    partner_id bigint NOT NULL,
    partner_code app.code_t NOT NULL,
    partner_name app.name_t NOT NULL,
    country_code character varying(3),
    erp_partner_code character varying(100),
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT partner_version_no_check CHECK ((version_no > 0))
);


--
-- Name: partner_partner_id_seq; Type: SEQUENCE; Schema: mdm; Owner: -
--

ALTER TABLE mdm.partner ALTER COLUMN partner_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME mdm.partner_partner_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: partner_role; Type: TABLE; Schema: mdm; Owner: -
--

CREATE TABLE mdm.partner_role (
    partner_role_id bigint NOT NULL,
    partner_id bigint NOT NULL,
    role_type_code app.code_t NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint
);


--
-- Name: partner_role_partner_role_id_seq; Type: SEQUENCE; Schema: mdm; Owner: -
--

ALTER TABLE mdm.partner_role ALTER COLUMN partner_role_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME mdm.partner_role_partner_role_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: plant; Type: TABLE; Schema: mdm; Owner: -
--

CREATE TABLE mdm.plant (
    plant_id bigint NOT NULL,
    legal_entity_id bigint NOT NULL,
    business_unit_id bigint,
    plant_code app.code_t NOT NULL,
    plant_name app.name_t NOT NULL,
    timezone_code character varying(64) NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT plant_version_no_check CHECK ((version_no > 0))
);


--
-- Name: plant_plant_id_seq; Type: SEQUENCE; Schema: mdm; Owner: -
--

ALTER TABLE mdm.plant ALTER COLUMN plant_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME mdm.plant_plant_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: process; Type: TABLE; Schema: mdm; Owner: -
--

CREATE TABLE mdm.process (
    process_id bigint NOT NULL,
    process_code app.code_t NOT NULL,
    process_name app.name_t NOT NULL,
    process_type_code app.code_t NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT process_version_no_check CHECK ((version_no > 0))
);


--
-- Name: process_process_id_seq; Type: SEQUENCE; Schema: mdm; Owner: -
--

ALTER TABLE mdm.process ALTER COLUMN process_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME mdm.process_process_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: production_line; Type: TABLE; Schema: mdm; Owner: -
--

CREATE TABLE mdm.production_line (
    production_line_id bigint NOT NULL,
    plant_id bigint NOT NULL,
    parent_line_id bigint,
    line_code app.code_t NOT NULL,
    line_name app.name_t NOT NULL,
    line_type_code app.code_t DEFAULT 'LINE'::character varying NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT ck_production_line_parent CHECK (((parent_line_id IS NULL) OR (parent_line_id <> production_line_id))),
    CONSTRAINT production_line_version_no_check CHECK ((version_no > 0))
);


--
-- Name: production_line_production_line_id_seq; Type: SEQUENCE; Schema: mdm; Owner: -
--

ALTER TABLE mdm.production_line ALTER COLUMN production_line_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME mdm.production_line_production_line_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: shift; Type: TABLE; Schema: mdm; Owner: -
--

CREATE TABLE mdm.shift (
    shift_id bigint NOT NULL,
    plant_id bigint NOT NULL,
    shift_code app.code_t NOT NULL,
    shift_name app.name_t NOT NULL,
    start_time time without time zone NOT NULL,
    end_time time without time zone NOT NULL,
    crosses_midnight boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT shift_version_no_check CHECK ((version_no > 0))
);


--
-- Name: shift_shift_id_seq; Type: SEQUENCE; Schema: mdm; Owner: -
--

ALTER TABLE mdm.shift ALTER COLUMN shift_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME mdm.shift_shift_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: spare_part; Type: TABLE; Schema: mdm; Owner: -
--

CREATE TABLE mdm.spare_part (
    spare_part_id bigint NOT NULL,
    spare_part_code app.code_t NOT NULL,
    spare_part_name app.name_t NOT NULL,
    item_id bigint,
    base_uom_id bigint NOT NULL,
    minimum_stock_qty app.qty_t,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT spare_part_version_no_check CHECK ((version_no > 0))
);


--
-- Name: spare_part_equipment; Type: TABLE; Schema: mdm; Owner: -
--

CREATE TABLE mdm.spare_part_equipment (
    spare_part_equipment_id bigint NOT NULL,
    spare_part_id bigint NOT NULL,
    equipment_id bigint NOT NULL,
    recommended_qty app.qty_t,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint
);


--
-- Name: spare_part_equipment_spare_part_equipment_id_seq; Type: SEQUENCE; Schema: mdm; Owner: -
--

ALTER TABLE mdm.spare_part_equipment ALTER COLUMN spare_part_equipment_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME mdm.spare_part_equipment_spare_part_equipment_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: spare_part_spare_part_id_seq; Type: SEQUENCE; Schema: mdm; Owner: -
--

ALTER TABLE mdm.spare_part ALTER COLUMN spare_part_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME mdm.spare_part_spare_part_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: terminal; Type: TABLE; Schema: mdm; Owner: -
--

CREATE TABLE mdm.terminal (
    terminal_id bigint NOT NULL,
    terminal_code app.code_t NOT NULL,
    plant_id bigint NOT NULL,
    location_id bigint,
    terminal_type_code app.code_t NOT NULL,
    status_code app.code_t NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    token_version integer DEFAULT 1 NOT NULL,
    CONSTRAINT terminal_token_version_check CHECK ((token_version > 0)),
    CONSTRAINT terminal_version_no_check CHECK ((version_no > 0))
);


--
-- Name: COLUMN terminal.token_version; Type: COMMENT; Schema: mdm; Owner: -
--

COMMENT ON COLUMN mdm.terminal.token_version IS '단말 토큰 세대. 발급 시 증가하며 이전 세대 토큰은 즉시 무효가 된다. 정본 모델 미포함 — OMF-MES 구현 측 추가분(2026-07-28).';


--
-- Name: terminal_process; Type: TABLE; Schema: mdm; Owner: -
--

CREATE TABLE mdm.terminal_process (
    terminal_process_id bigint NOT NULL,
    terminal_id bigint NOT NULL,
    process_id bigint NOT NULL,
    can_input_material boolean DEFAULT false NOT NULL,
    can_input_result boolean DEFAULT false NOT NULL,
    can_input_inspection boolean DEFAULT false NOT NULL,
    can_print_label boolean DEFAULT false NOT NULL,
    can_start_work boolean DEFAULT false NOT NULL,
    can_complete_work boolean DEFAULT false NOT NULL,
    can_cancel_input boolean DEFAULT false NOT NULL,
    can_return_material boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint
);


--
-- Name: terminal_process_terminal_process_id_seq; Type: SEQUENCE; Schema: mdm; Owner: -
--

ALTER TABLE mdm.terminal_process ALTER COLUMN terminal_process_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME mdm.terminal_process_terminal_process_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: terminal_terminal_id_seq; Type: SEQUENCE; Schema: mdm; Owner: -
--

ALTER TABLE mdm.terminal ALTER COLUMN terminal_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME mdm.terminal_terminal_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: uom; Type: TABLE; Schema: mdm; Owner: -
--

CREATE TABLE mdm.uom (
    uom_id bigint NOT NULL,
    uom_code app.code_t NOT NULL,
    uom_name app.name_t NOT NULL,
    decimal_scale smallint DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT uom_decimal_scale_check CHECK (((decimal_scale >= 0) AND (decimal_scale <= 6))),
    CONSTRAINT uom_version_no_check CHECK ((version_no > 0))
);


--
-- Name: uom_uom_id_seq; Type: SEQUENCE; Schema: mdm; Owner: -
--

ALTER TABLE mdm.uom ALTER COLUMN uom_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME mdm.uom_uom_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: warehouse; Type: TABLE; Schema: mdm; Owner: -
--

CREATE TABLE mdm.warehouse (
    warehouse_id bigint NOT NULL,
    plant_id bigint NOT NULL,
    business_unit_id bigint NOT NULL,
    warehouse_code app.code_t NOT NULL,
    warehouse_name app.name_t NOT NULL,
    warehouse_type_code app.code_t NOT NULL,
    management_level_code app.code_t NOT NULL,
    is_external boolean DEFAULT false NOT NULL,
    partner_id bigint,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    is_defect boolean DEFAULT false NOT NULL,
    CONSTRAINT ck_external_warehouse_partner CHECK (((NOT is_external) OR (partner_id IS NOT NULL))),
    CONSTRAINT warehouse_version_no_check CHECK ((version_no > 0))
);


--
-- Name: COLUMN warehouse.is_defect; Type: COMMENT; Schema: mdm; Owner: -
--

COMMENT ON COLUMN mdm.warehouse.is_defect IS '불량창고 여부. 창고 유형(warehouse_type_code)과 별개의 품질 축이다 — 자재 불량창고와 제품 불량창고가 모두 성립한다. 근거: DR-012 3-C(2026-08-13).';


--
-- Name: warehouse_layout; Type: TABLE; Schema: mdm; Owner: -
--

CREATE TABLE mdm.warehouse_layout (
    warehouse_layout_id bigint NOT NULL,
    warehouse_id bigint NOT NULL,
    layout_version integer NOT NULL,
    layout_data jsonb NOT NULL,
    status_code app.code_t DEFAULT 'DRAFT'::character varying NOT NULL,
    effective_from timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT warehouse_layout_layout_version_check CHECK ((layout_version > 0)),
    CONSTRAINT warehouse_layout_version_no_check CHECK ((version_no > 0))
);


--
-- Name: warehouse_layout_warehouse_layout_id_seq; Type: SEQUENCE; Schema: mdm; Owner: -
--

ALTER TABLE mdm.warehouse_layout ALTER COLUMN warehouse_layout_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME mdm.warehouse_layout_warehouse_layout_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: warehouse_warehouse_id_seq; Type: SEQUENCE; Schema: mdm; Owner: -
--

ALTER TABLE mdm.warehouse ALTER COLUMN warehouse_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME mdm.warehouse_warehouse_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: work_calendar; Type: TABLE; Schema: mdm; Owner: -
--

CREATE TABLE mdm.work_calendar (
    work_calendar_id bigint NOT NULL,
    plant_id bigint NOT NULL,
    calendar_code app.code_t NOT NULL,
    calendar_name app.name_t NOT NULL,
    timezone_name character varying(100) NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT work_calendar_version_no_check CHECK ((version_no > 0))
);


--
-- Name: work_calendar_application; Type: TABLE; Schema: mdm; Owner: -
--

CREATE TABLE mdm.work_calendar_application (
    work_calendar_application_id bigint NOT NULL,
    work_calendar_id bigint NOT NULL,
    target_type_code app.code_t NOT NULL,
    target_id bigint NOT NULL,
    effective_from date NOT NULL,
    effective_to date,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    CONSTRAINT ck_work_calendar_application_dates CHECK (((effective_to IS NULL) OR (effective_to >= effective_from)))
);


--
-- Name: work_calendar_application_work_calendar_application_id_seq; Type: SEQUENCE; Schema: mdm; Owner: -
--

ALTER TABLE mdm.work_calendar_application ALTER COLUMN work_calendar_application_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME mdm.work_calendar_application_work_calendar_application_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: work_calendar_day; Type: TABLE; Schema: mdm; Owner: -
--

CREATE TABLE mdm.work_calendar_day (
    work_calendar_day_id bigint NOT NULL,
    work_calendar_id bigint NOT NULL,
    calendar_date date NOT NULL,
    day_type_code app.code_t NOT NULL,
    work_start_time time without time zone,
    work_end_time time without time zone,
    remarks text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint
);


--
-- Name: work_calendar_day_work_calendar_day_id_seq; Type: SEQUENCE; Schema: mdm; Owner: -
--

ALTER TABLE mdm.work_calendar_day ALTER COLUMN work_calendar_day_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME mdm.work_calendar_day_work_calendar_day_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: work_calendar_work_calendar_id_seq; Type: SEQUENCE; Schema: mdm; Owner: -
--

ALTER TABLE mdm.work_calendar ALTER COLUMN work_calendar_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME mdm.work_calendar_work_calendar_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: worker; Type: TABLE; Schema: mdm; Owner: -
--

CREATE TABLE mdm.worker (
    worker_id bigint NOT NULL,
    worker_no app.code_t NOT NULL,
    worker_name app.name_t NOT NULL,
    business_unit_id bigint NOT NULL,
    plant_id bigint NOT NULL,
    department_id bigint,
    app_user_id bigint,
    status_code app.code_t NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT worker_version_no_check CHECK ((version_no > 0))
);


--
-- Name: worker_qualification; Type: TABLE; Schema: mdm; Owner: -
--

CREATE TABLE mdm.worker_qualification (
    worker_qualification_id bigint NOT NULL,
    worker_id bigint NOT NULL,
    qualification_type_code app.code_t NOT NULL,
    process_id bigint,
    certificate_no character varying(100),
    valid_from date NOT NULL,
    valid_to date,
    certified_by bigint,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    CONSTRAINT ck_worker_qualification_dates CHECK (((valid_to IS NULL) OR (valid_to >= valid_from)))
);


--
-- Name: worker_qualification_worker_qualification_id_seq; Type: SEQUENCE; Schema: mdm; Owner: -
--

ALTER TABLE mdm.worker_qualification ALTER COLUMN worker_qualification_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME mdm.worker_qualification_worker_qualification_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: worker_worker_id_seq; Type: SEQUENCE; Schema: mdm; Owner: -
--

ALTER TABLE mdm.worker ALTER COLUMN worker_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME mdm.worker_worker_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: bom; Type: TABLE; Schema: planning; Owner: -
--

CREATE TABLE planning.bom (
    bom_id bigint NOT NULL,
    parent_item_id bigint NOT NULL,
    bom_code app.code_t NOT NULL,
    bom_version integer NOT NULL,
    status_code app.code_t NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    effective_from date NOT NULL,
    effective_to date,
    base_qty app.qty_t NOT NULL,
    base_uom_id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT bom_base_qty_check CHECK (((base_qty)::numeric > (0)::numeric)),
    CONSTRAINT bom_bom_version_check CHECK ((bom_version > 0)),
    CONSTRAINT bom_version_no_check CHECK ((version_no > 0)),
    CONSTRAINT ck_bom_dates CHECK (((effective_to IS NULL) OR (effective_to >= effective_from)))
);


--
-- Name: bom_bom_id_seq; Type: SEQUENCE; Schema: planning; Owner: -
--

ALTER TABLE planning.bom ALTER COLUMN bom_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME planning.bom_bom_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: bom_component; Type: TABLE; Schema: planning; Owner: -
--

CREATE TABLE planning.bom_component (
    bom_component_id bigint NOT NULL,
    bom_id bigint NOT NULL,
    component_item_id bigint NOT NULL,
    routing_operation_id bigint,
    actual_use_process_id bigint,
    required_qty app.qty_t NOT NULL,
    uom_id bigint NOT NULL,
    scrap_rate numeric(9,6) DEFAULT 0 NOT NULL,
    is_mandatory boolean DEFAULT true NOT NULL,
    lot_trace_required boolean DEFAULT false NOT NULL,
    backflush_allowed boolean DEFAULT false NOT NULL,
    sequence_no integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT bom_component_required_qty_check CHECK (((required_qty)::numeric > (0)::numeric)),
    CONSTRAINT bom_component_scrap_rate_check CHECK (((scrap_rate >= (0)::numeric) AND (scrap_rate <= (1)::numeric))),
    CONSTRAINT bom_component_sequence_no_check CHECK ((sequence_no > 0)),
    CONSTRAINT bom_component_version_no_check CHECK ((version_no > 0))
);


--
-- Name: bom_component_bom_component_id_seq; Type: SEQUENCE; Schema: planning; Owner: -
--

ALTER TABLE planning.bom_component ALTER COLUMN bom_component_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME planning.bom_component_bom_component_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: material_substitution_rule; Type: TABLE; Schema: planning; Owner: -
--

CREATE TABLE planning.material_substitution_rule (
    substitution_rule_id bigint NOT NULL,
    bom_component_id bigint NOT NULL,
    substitute_item_id bigint NOT NULL,
    priority_no integer DEFAULT 1 NOT NULL,
    max_substitute_qty app.qty_t,
    approval_required boolean DEFAULT true NOT NULL,
    customer_restriction_id bigint,
    effective_from date NOT NULL,
    effective_to date,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    CONSTRAINT ck_substitution_dates CHECK (((effective_to IS NULL) OR (effective_to >= effective_from))),
    CONSTRAINT material_substitution_rule_priority_no_check CHECK ((priority_no > 0))
);


--
-- Name: material_substitution_rule_substitution_rule_id_seq; Type: SEQUENCE; Schema: planning; Owner: -
--

ALTER TABLE planning.material_substitution_rule ALTER COLUMN substitution_rule_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME planning.material_substitution_rule_substitution_rule_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: production_order; Type: TABLE; Schema: planning; Owner: -
--

CREATE TABLE planning.production_order (
    production_order_id bigint NOT NULL,
    production_order_no app.business_no_t NOT NULL,
    erp_order_no character varying(100),
    parent_production_order_id bigint,
    bom_level smallint DEFAULT 0 NOT NULL,
    business_unit_id bigint NOT NULL,
    plant_id bigint NOT NULL,
    item_id bigint NOT NULL,
    order_qty app.qty_t NOT NULL,
    uom_id bigint NOT NULL,
    due_date date,
    status_code app.code_t NOT NULL,
    remarks text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT ck_production_order_parent CHECK (((parent_production_order_id IS NULL) OR (parent_production_order_id <> production_order_id))),
    CONSTRAINT production_order_bom_level_check CHECK ((bom_level >= 0)),
    CONSTRAINT production_order_order_qty_check CHECK (((order_qty)::numeric > (0)::numeric)),
    CONSTRAINT production_order_version_no_check CHECK ((version_no > 0))
);


--
-- Name: production_order_production_order_id_seq; Type: SEQUENCE; Schema: planning; Owner: -
--

ALTER TABLE planning.production_order ALTER COLUMN production_order_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME planning.production_order_production_order_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: production_plan; Type: TABLE; Schema: planning; Owner: -
--

CREATE TABLE planning.production_plan (
    production_plan_id bigint NOT NULL,
    production_order_id bigint NOT NULL,
    plan_no app.business_no_t NOT NULL,
    plan_date date NOT NULL,
    planned_qty app.qty_t NOT NULL,
    uom_id bigint NOT NULL,
    bom_id bigint NOT NULL,
    routing_id bigint NOT NULL,
    planned_line_id bigint,
    status_code app.code_t NOT NULL,
    confirmed_at timestamp with time zone,
    confirmed_by bigint,
    remarks text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT production_plan_planned_qty_check CHECK (((planned_qty)::numeric > (0)::numeric)),
    CONSTRAINT production_plan_version_no_check CHECK ((version_no > 0))
);


--
-- Name: production_plan_production_plan_id_seq; Type: SEQUENCE; Schema: planning; Owner: -
--

ALTER TABLE planning.production_plan ALTER COLUMN production_plan_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME planning.production_plan_production_plan_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: routing; Type: TABLE; Schema: planning; Owner: -
--

CREATE TABLE planning.routing (
    routing_id bigint NOT NULL,
    item_id bigint NOT NULL,
    routing_code app.code_t NOT NULL,
    routing_version integer NOT NULL,
    status_code app.code_t NOT NULL,
    effective_from date NOT NULL,
    effective_to date,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    CONSTRAINT ck_routing_dates CHECK (((effective_to IS NULL) OR (effective_to >= effective_from))),
    CONSTRAINT routing_routing_version_check CHECK ((routing_version > 0)),
    CONSTRAINT routing_version_no_check CHECK ((version_no > 0))
);


--
-- Name: routing_operation; Type: TABLE; Schema: planning; Owner: -
--

CREATE TABLE planning.routing_operation (
    routing_operation_id bigint NOT NULL,
    routing_id bigint NOT NULL,
    operation_seq integer NOT NULL,
    process_id bigint NOT NULL,
    operation_name app.name_t NOT NULL,
    mes_managed boolean DEFAULT true NOT NULL,
    material_input_managed boolean DEFAULT false NOT NULL,
    production_result_managed boolean DEFAULT true NOT NULL,
    inspection_managed boolean DEFAULT false NOT NULL,
    output_lot_required boolean DEFAULT false NOT NULL,
    equipment_required boolean DEFAULT false NOT NULL,
    mold_required boolean DEFAULT false NOT NULL,
    standard_cycle_time_sec numeric(18,6),
    standard_yield_rate numeric(9,6),
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    is_subcontract boolean DEFAULT false NOT NULL,
    CONSTRAINT routing_operation_operation_seq_check CHECK ((operation_seq > 0)),
    CONSTRAINT routing_operation_standard_cycle_time_sec_check CHECK (((standard_cycle_time_sec IS NULL) OR (standard_cycle_time_sec > (0)::numeric))),
    CONSTRAINT routing_operation_standard_yield_rate_check CHECK (((standard_yield_rate IS NULL) OR ((standard_yield_rate >= (0)::numeric) AND (standard_yield_rate <= (1)::numeric)))),
    CONSTRAINT routing_operation_version_no_check CHECK ((version_no > 0))
);


--
-- Name: routing_operation_dependency; Type: TABLE; Schema: planning; Owner: -
--

CREATE TABLE planning.routing_operation_dependency (
    routing_operation_dependency_id bigint NOT NULL,
    predecessor_operation_id bigint NOT NULL,
    successor_operation_id bigint NOT NULL,
    dependency_type_code app.code_t DEFAULT 'FINISH_TO_START'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    CONSTRAINT ck_routing_dependency_self CHECK ((predecessor_operation_id <> successor_operation_id))
);


--
-- Name: routing_operation_dependency_routing_operation_dependency_i_seq; Type: SEQUENCE; Schema: planning; Owner: -
--

ALTER TABLE planning.routing_operation_dependency ALTER COLUMN routing_operation_dependency_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME planning.routing_operation_dependency_routing_operation_dependency_i_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: routing_operation_routing_operation_id_seq; Type: SEQUENCE; Schema: planning; Owner: -
--

ALTER TABLE planning.routing_operation ALTER COLUMN routing_operation_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME planning.routing_operation_routing_operation_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: routing_routing_id_seq; Type: SEQUENCE; Schema: planning; Owner: -
--

ALTER TABLE planning.routing ALTER COLUMN routing_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME planning.routing_routing_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: material_consumption; Type: TABLE; Schema: production; Owner: -
--

CREATE TABLE production.material_consumption (
    material_consumption_id bigint NOT NULL,
    consumption_no app.business_no_t NOT NULL,
    work_order_id bigint NOT NULL,
    work_session_id bigint,
    shopfloor_receipt_line_id bigint,
    bom_component_id bigint,
    item_id bigint NOT NULL,
    lot_id bigint NOT NULL,
    consumption_type_code app.code_t NOT NULL,
    corrects_consumption_id bigint,
    replaced_consumption_id bigint,
    change_reason_code app.code_t,
    actual_use_process_id bigint,
    input_qty app.qty_t NOT NULL,
    actual_consumed_qty app.qty_t DEFAULT 0 NOT NULL,
    uom_id bigint NOT NULL,
    entered_qty app.qty_t,
    entered_uom_id bigint,
    occurred_at timestamp with time zone NOT NULL,
    recorded_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    late_entry_reason_code app.code_t,
    worker_id bigint NOT NULL,
    terminal_id bigint NOT NULL,
    status_code app.code_t NOT NULL,
    idempotency_key character varying(150) NOT NULL,
    remarks text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT ck_material_consumption_entered CHECK (((entered_qty IS NULL) = (entered_uom_id IS NULL))),
    CONSTRAINT ck_material_consumption_qty CHECK (((actual_consumed_qty)::numeric <= (input_qty)::numeric)),
    CONSTRAINT material_consumption_input_qty_check CHECK (((input_qty)::numeric > (0)::numeric)),
    CONSTRAINT material_consumption_version_no_check CHECK ((version_no > 0))
);


--
-- Name: material_consumption_material_consumption_id_seq; Type: SEQUENCE; Schema: production; Owner: -
--

ALTER TABLE production.material_consumption ALTER COLUMN material_consumption_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME production.material_consumption_material_consumption_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: material_loss; Type: TABLE; Schema: production; Owner: -
--

CREATE TABLE production.material_loss (
    material_loss_id bigint NOT NULL,
    work_order_id bigint NOT NULL,
    material_consumption_id bigint NOT NULL,
    item_id bigint NOT NULL,
    lot_id bigint NOT NULL,
    loss_type_code app.code_t NOT NULL,
    loss_qty app.qty_t NOT NULL,
    uom_id bigint NOT NULL,
    reason_code app.code_t NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    CONSTRAINT material_loss_loss_qty_check CHECK (((loss_qty)::numeric > (0)::numeric))
);


--
-- Name: material_loss_material_loss_id_seq; Type: SEQUENCE; Schema: production; Owner: -
--

ALTER TABLE production.material_loss ALTER COLUMN material_loss_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME production.material_loss_material_loss_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: material_return; Type: TABLE; Schema: production; Owner: -
--

CREATE TABLE production.material_return (
    material_return_id bigint NOT NULL,
    material_return_no app.business_no_t NOT NULL,
    work_order_id bigint NOT NULL,
    source_location_id bigint NOT NULL,
    destination_warehouse_id bigint NOT NULL,
    status_code app.code_t NOT NULL,
    requested_at timestamp with time zone NOT NULL,
    received_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT material_return_version_no_check CHECK ((version_no > 0))
);


--
-- Name: material_return_line; Type: TABLE; Schema: production; Owner: -
--

CREATE TABLE production.material_return_line (
    material_return_line_id bigint NOT NULL,
    material_return_id bigint NOT NULL,
    line_no integer NOT NULL,
    item_id bigint NOT NULL,
    lot_id bigint NOT NULL,
    return_qty app.qty_t NOT NULL,
    uom_id bigint NOT NULL,
    package_opened boolean DEFAULT false NOT NULL,
    quality_check_required boolean DEFAULT false NOT NULL,
    return_quality_status_code app.code_t NOT NULL,
    inventory_transaction_line_id bigint,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    CONSTRAINT material_return_line_line_no_check CHECK ((line_no > 0)),
    CONSTRAINT material_return_line_return_qty_check CHECK (((return_qty)::numeric > (0)::numeric))
);


--
-- Name: material_return_line_material_return_line_id_seq; Type: SEQUENCE; Schema: production; Owner: -
--

ALTER TABLE production.material_return_line ALTER COLUMN material_return_line_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME production.material_return_line_material_return_line_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: material_return_material_return_id_seq; Type: SEQUENCE; Schema: production; Owner: -
--

ALTER TABLE production.material_return ALTER COLUMN material_return_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME production.material_return_material_return_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: material_usage_allocation; Type: TABLE; Schema: production; Owner: -
--

CREATE TABLE production.material_usage_allocation (
    material_usage_allocation_id bigint NOT NULL,
    material_consumption_id bigint NOT NULL,
    production_result_id bigint,
    output_lot_id bigint,
    allocated_qty app.qty_t NOT NULL,
    uom_id bigint NOT NULL,
    allocation_method_code app.code_t NOT NULL,
    trace_accuracy_code app.code_t NOT NULL,
    effective_from_at timestamp with time zone,
    effective_to_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    CONSTRAINT ck_material_usage_dates CHECK (((effective_to_at IS NULL) OR (effective_from_at IS NULL) OR (effective_to_at >= effective_from_at))),
    CONSTRAINT ck_material_usage_target CHECK (((production_result_id IS NOT NULL) OR (output_lot_id IS NOT NULL))),
    CONSTRAINT material_usage_allocation_allocated_qty_check CHECK (((allocated_qty)::numeric > (0)::numeric))
);


--
-- Name: material_usage_allocation_material_usage_allocation_id_seq; Type: SEQUENCE; Schema: production; Owner: -
--

ALTER TABLE production.material_usage_allocation ALTER COLUMN material_usage_allocation_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME production.material_usage_allocation_material_usage_allocation_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: operation_handover; Type: TABLE; Schema: production; Owner: -
--

CREATE TABLE production.operation_handover (
    operation_handover_id bigint NOT NULL,
    handover_no app.business_no_t NOT NULL,
    from_work_order_id bigint NOT NULL,
    to_work_order_id bigint NOT NULL,
    status_code app.code_t NOT NULL,
    handed_over_at timestamp with time zone NOT NULL,
    received_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT ck_handover_work_orders CHECK ((from_work_order_id <> to_work_order_id)),
    CONSTRAINT operation_handover_version_no_check CHECK ((version_no > 0))
);


--
-- Name: operation_handover_line; Type: TABLE; Schema: production; Owner: -
--

CREATE TABLE production.operation_handover_line (
    operation_handover_line_id bigint NOT NULL,
    operation_handover_id bigint NOT NULL,
    line_no integer NOT NULL,
    source_lot_id bigint NOT NULL,
    handover_qty app.qty_t NOT NULL,
    received_qty app.qty_t DEFAULT 0 NOT NULL,
    uom_id bigint NOT NULL,
    source_location_id bigint NOT NULL,
    destination_location_id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    CONSTRAINT ck_handover_qty CHECK (((received_qty)::numeric <= (handover_qty)::numeric)),
    CONSTRAINT operation_handover_line_handover_qty_check CHECK (((handover_qty)::numeric > (0)::numeric)),
    CONSTRAINT operation_handover_line_line_no_check CHECK ((line_no > 0))
);


--
-- Name: operation_handover_line_operation_handover_line_id_seq; Type: SEQUENCE; Schema: production; Owner: -
--

ALTER TABLE production.operation_handover_line ALTER COLUMN operation_handover_line_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME production.operation_handover_line_operation_handover_line_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: operation_handover_operation_handover_id_seq; Type: SEQUENCE; Schema: production; Owner: -
--

ALTER TABLE production.operation_handover ALTER COLUMN operation_handover_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME production.operation_handover_operation_handover_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: production_order_acknowledgement; Type: TABLE; Schema: production; Owner: -
--

CREATE TABLE production.production_order_acknowledgement (
    production_order_acknowledgement_id bigint NOT NULL,
    production_order_id bigint NOT NULL,
    acknowledgement_type_code app.code_t NOT NULL,
    upstream_version character varying(100),
    received_at timestamp with time zone NOT NULL,
    acknowledged_at timestamp with time zone,
    status_code app.code_t NOT NULL,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    integration_message_id bigint
);


--
-- Name: production_order_acknowledgem_production_order_acknowledgem_seq; Type: SEQUENCE; Schema: production; Owner: -
--

ALTER TABLE production.production_order_acknowledgement ALTER COLUMN production_order_acknowledgement_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME production.production_order_acknowledgem_production_order_acknowledgem_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: production_result; Type: TABLE; Schema: production; Owner: -
--

CREATE TABLE production.production_result (
    production_result_id bigint NOT NULL,
    production_result_no app.business_no_t NOT NULL,
    work_order_id bigint NOT NULL,
    work_session_id bigint,
    result_sequence integer NOT NULL,
    corrects_production_result_id bigint,
    good_qty app.qty_t DEFAULT 0 NOT NULL,
    defect_qty app.qty_t DEFAULT 0 NOT NULL,
    hold_qty app.qty_t DEFAULT 0 NOT NULL,
    scrap_qty app.qty_t DEFAULT 0 NOT NULL,
    rework_qty app.qty_t DEFAULT 0 NOT NULL,
    uom_id bigint NOT NULL,
    result_source_code app.code_t NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    recorded_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    late_entry_reason_code app.code_t,
    worker_id bigint NOT NULL,
    equipment_id bigint,
    mold_id bigint,
    shift_id bigint NOT NULL,
    terminal_id bigint,
    status_code app.code_t NOT NULL,
    idempotency_key character varying(150) NOT NULL,
    remarks text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT ck_production_result_nonzero CHECK (((((((good_qty)::numeric + (defect_qty)::numeric) + (hold_qty)::numeric) + (scrap_qty)::numeric) + (rework_qty)::numeric) > (0)::numeric)),
    CONSTRAINT production_result_result_sequence_check CHECK ((result_sequence > 0)),
    CONSTRAINT production_result_version_no_check CHECK ((version_no > 0))
);


--
-- Name: production_result_lot_allocation; Type: TABLE; Schema: production; Owner: -
--

CREATE TABLE production.production_result_lot_allocation (
    production_result_lot_allocation_id bigint NOT NULL,
    production_result_id bigint NOT NULL,
    lot_id bigint NOT NULL,
    allocated_qty app.qty_t NOT NULL,
    uom_id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    CONSTRAINT production_result_lot_allocation_allocated_qty_check CHECK (((allocated_qty)::numeric > (0)::numeric))
);


--
-- Name: production_result_lot_allocat_production_result_lot_allocat_seq; Type: SEQUENCE; Schema: production; Owner: -
--

ALTER TABLE production.production_result_lot_allocation ALTER COLUMN production_result_lot_allocation_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME production.production_result_lot_allocat_production_result_lot_allocat_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: production_result_production_result_id_seq; Type: SEQUENCE; Schema: production; Owner: -
--

ALTER TABLE production.production_result ALTER COLUMN production_result_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME production.production_result_production_result_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: work_order; Type: TABLE; Schema: production; Owner: -
--

CREATE TABLE production.work_order (
    work_order_id bigint NOT NULL,
    work_order_no app.business_no_t NOT NULL,
    production_plan_id bigint,
    routing_operation_id bigint NOT NULL,
    item_id bigint NOT NULL,
    order_qty app.qty_t NOT NULL,
    uom_id bigint NOT NULL,
    work_order_type_code app.code_t DEFAULT 'NORMAL'::character varying NOT NULL,
    parent_work_order_id bigint,
    rework_source_work_order_id bigint,
    rework_source_lot_id bigint,
    rework_source_nonconformance_id bigint,
    production_line_id bigint,
    responsible_worker_id bigint,
    planned_start_at timestamp with time zone,
    planned_end_at timestamp with time zone,
    planned_equipment_id bigint,
    planned_mold_id bigint,
    planned_shift_id bigint,
    priority_no integer DEFAULT 100 NOT NULL,
    default_wip_location_id bigint,
    default_fg_location_id bigint,
    default_scrap_location_id bigint,
    operation_settings_snapshot jsonb,
    status_code app.code_t NOT NULL,
    released_at timestamp with time zone,
    completed_at timestamp with time zone,
    completion_variance_reason_code app.code_t,
    closed_at timestamp with time zone,
    remarks text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    close_disposition_code app.code_t,
    cancellation_reason_code app.code_t,
    CONSTRAINT ck_work_order_plan_dates CHECK (((planned_end_at IS NULL) OR (planned_start_at IS NULL) OR (planned_end_at >= planned_start_at))),
    CONSTRAINT ck_work_order_rework_self CHECK (((rework_source_work_order_id IS NULL) OR (rework_source_work_order_id <> work_order_id))),
    CONSTRAINT ck_work_order_rework_type CHECK (((rework_source_work_order_id IS NULL) OR ((work_order_type_code)::text = 'REWORK'::text))),
    CONSTRAINT ck_work_order_split_self CHECK (((parent_work_order_id IS NULL) OR (parent_work_order_id <> work_order_id))),
    CONSTRAINT work_order_order_qty_check CHECK (((order_qty)::numeric > (0)::numeric)),
    CONSTRAINT work_order_version_no_check CHECK ((version_no > 0))
);


--
-- Name: v_work_order_progress; Type: VIEW; Schema: production; Owner: -
--

CREATE VIEW production.v_work_order_progress AS
 SELECT wo.work_order_id,
    wo.work_order_no,
    wo.production_plan_id,
    wo.routing_operation_id,
    wo.item_id,
    wo.order_qty,
    wo.uom_id,
    wo.status_code,
    COALESCE(sum((pr.good_qty)::numeric), (0)::numeric) AS good_qty,
    COALESCE(sum((pr.defect_qty)::numeric), (0)::numeric) AS defect_qty,
    COALESCE(sum((pr.hold_qty)::numeric), (0)::numeric) AS hold_qty,
    GREATEST(((wo.order_qty)::numeric - COALESCE(sum((pr.good_qty)::numeric), (0)::numeric)), (0)::numeric) AS remaining_good_qty
   FROM (production.work_order wo
     LEFT JOIN production.production_result pr ON (((pr.work_order_id = wo.work_order_id) AND ((pr.status_code)::text <> ALL ((ARRAY['CANCELLED'::character varying, 'REVERSED'::character varying])::text[])))))
  GROUP BY wo.work_order_id, wo.work_order_no, wo.production_plan_id, wo.routing_operation_id, wo.item_id, wo.order_qty, wo.uom_id, wo.status_code;


--
-- Name: work_order_dependency; Type: TABLE; Schema: production; Owner: -
--

CREATE TABLE production.work_order_dependency (
    work_order_dependency_id bigint NOT NULL,
    predecessor_work_order_id bigint NOT NULL,
    successor_work_order_id bigint NOT NULL,
    dependency_type_code app.code_t DEFAULT 'FINISH_TO_START'::character varying NOT NULL,
    required_qty_rule_code app.code_t DEFAULT 'AVAILABLE_GOOD_QTY'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    CONSTRAINT ck_work_order_dependency_self CHECK ((predecessor_work_order_id <> successor_work_order_id))
);


--
-- Name: work_order_dependency_work_order_dependency_id_seq; Type: SEQUENCE; Schema: production; Owner: -
--

ALTER TABLE production.work_order_dependency ALTER COLUMN work_order_dependency_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME production.work_order_dependency_work_order_dependency_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: work_order_resource_assignment; Type: TABLE; Schema: production; Owner: -
--

CREATE TABLE production.work_order_resource_assignment (
    work_order_resource_assignment_id bigint NOT NULL,
    work_order_id bigint NOT NULL,
    resource_type_code app.code_t NOT NULL,
    equipment_id bigint,
    mold_id bigint,
    worker_id bigint,
    shift_id bigint,
    planned_start_at timestamp with time zone,
    planned_end_at timestamp with time zone,
    assignment_status_code app.code_t DEFAULT 'PLANNED'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT ck_work_order_resource_target CHECK ((num_nonnulls(equipment_id, mold_id, worker_id, shift_id) = 1)),
    CONSTRAINT ck_work_order_resource_window CHECK (((planned_end_at IS NULL) OR (planned_start_at IS NULL) OR (planned_end_at >= planned_start_at))),
    CONSTRAINT work_order_resource_assignment_version_no_check CHECK ((version_no > 0))
);


--
-- Name: work_order_resource_assignmen_work_order_resource_assignmen_seq; Type: SEQUENCE; Schema: production; Owner: -
--

ALTER TABLE production.work_order_resource_assignment ALTER COLUMN work_order_resource_assignment_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME production.work_order_resource_assignmen_work_order_resource_assignmen_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: work_order_work_order_id_seq; Type: SEQUENCE; Schema: production; Owner: -
--

ALTER TABLE production.work_order ALTER COLUMN work_order_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME production.work_order_work_order_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: work_session; Type: TABLE; Schema: production; Owner: -
--

CREATE TABLE production.work_session (
    work_session_id bigint NOT NULL,
    work_order_id bigint NOT NULL,
    session_no integer NOT NULL,
    shift_id bigint NOT NULL,
    equipment_id bigint,
    mold_id bigint,
    terminal_id bigint NOT NULL,
    started_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone,
    status_code app.code_t NOT NULL,
    stop_reason_code app.code_t,
    remarks text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    idempotency_key character varying(150) NOT NULL,
    CONSTRAINT ck_work_session_dates CHECK (((ended_at IS NULL) OR (ended_at >= started_at))),
    CONSTRAINT work_session_session_no_check CHECK ((session_no > 0)),
    CONSTRAINT work_session_version_no_check CHECK ((version_no > 0))
);


--
-- Name: COLUMN work_session.idempotency_key; Type: COMMENT; Schema: production; Owner: -
--

COMMENT ON COLUMN production.work_session.idempotency_key IS '클라이언트 재전송 식별자(Idempotency-Key 헤더). 같은 키의 재요청은 새 세션을 만들지 않고 기존 세션을 돌려준다. 정본 모델 미포함 — OMF-MES 구현 측 추가분(2026-07-28).';


--
-- Name: work_session_event; Type: TABLE; Schema: production; Owner: -
--

CREATE TABLE production.work_session_event (
    work_session_event_id bigint NOT NULL,
    work_session_id bigint NOT NULL,
    event_type_code app.code_t NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    reason_code app.code_t,
    performed_by bigint,
    terminal_id bigint,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);


--
-- Name: work_session_event_work_session_event_id_seq; Type: SEQUENCE; Schema: production; Owner: -
--

ALTER TABLE production.work_session_event ALTER COLUMN work_session_event_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME production.work_session_event_work_session_event_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: work_session_work_session_id_seq; Type: SEQUENCE; Schema: production; Owner: -
--

ALTER TABLE production.work_session ALTER COLUMN work_session_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME production.work_session_work_session_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: work_session_worker; Type: TABLE; Schema: production; Owner: -
--

CREATE TABLE production.work_session_worker (
    work_session_worker_id bigint NOT NULL,
    work_session_id bigint NOT NULL,
    worker_id bigint NOT NULL,
    worker_role_code app.code_t DEFAULT 'OPERATOR'::character varying NOT NULL,
    joined_at timestamp with time zone NOT NULL,
    left_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    CONSTRAINT ck_work_session_worker_dates CHECK (((left_at IS NULL) OR (left_at >= joined_at)))
);


--
-- Name: work_session_worker_work_session_worker_id_seq; Type: SEQUENCE; Schema: production; Owner: -
--

ALTER TABLE production.work_session_worker ALTER COLUMN work_session_worker_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME production.work_session_worker_work_session_worker_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: cause_code; Type: TABLE; Schema: quality; Owner: -
--

CREATE TABLE quality.cause_code (
    cause_code_id bigint NOT NULL,
    cause_code app.code_t NOT NULL,
    cause_name app.name_t NOT NULL,
    parent_cause_code_id bigint,
    process_id bigint,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT cause_code_version_no_check CHECK ((version_no > 0))
);


--
-- Name: cause_code_cause_code_id_seq; Type: SEQUENCE; Schema: quality; Owner: -
--

ALTER TABLE quality.cause_code ALTER COLUMN cause_code_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME quality.cause_code_cause_code_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: concession; Type: TABLE; Schema: quality; Owner: -
--

CREATE TABLE quality.concession (
    concession_id bigint NOT NULL,
    concession_no app.business_no_t NOT NULL,
    nonconformance_id bigint NOT NULL,
    lot_id bigint NOT NULL,
    approved_qty app.qty_t NOT NULL,
    consumed_qty app.qty_t DEFAULT 0 NOT NULL,
    uom_id bigint NOT NULL,
    valid_from date NOT NULL,
    valid_to date,
    allowed_work_order_id bigint,
    allowed_process_id bigint,
    allowed_customer_id bigint,
    approval_request_id bigint NOT NULL,
    status_code app.code_t NOT NULL,
    remarks text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT ck_concession_consumed CHECK (((consumed_qty)::numeric <= (approved_qty)::numeric)),
    CONSTRAINT ck_concession_dates CHECK (((valid_to IS NULL) OR (valid_to >= valid_from))),
    CONSTRAINT concession_approved_qty_check CHECK (((approved_qty)::numeric > (0)::numeric)),
    CONSTRAINT concession_version_no_check CHECK ((version_no > 0))
);


--
-- Name: concession_concession_id_seq; Type: SEQUENCE; Schema: quality; Owner: -
--

ALTER TABLE quality.concession ALTER COLUMN concession_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME quality.concession_concession_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: defect_code; Type: TABLE; Schema: quality; Owner: -
--

CREATE TABLE quality.defect_code (
    defect_code_id bigint NOT NULL,
    defect_code app.code_t NOT NULL,
    defect_name app.name_t NOT NULL,
    parent_defect_code_id bigint,
    process_id bigint,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    disposition_type_code app.code_t,
    CONSTRAINT defect_code_version_no_check CHECK ((version_no > 0))
);


--
-- Name: defect_code_defect_code_id_seq; Type: SEQUENCE; Schema: quality; Owner: -
--

ALTER TABLE quality.defect_code ALTER COLUMN defect_code_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME quality.defect_code_defect_code_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: defect_code_process; Type: TABLE; Schema: quality; Owner: -
--

CREATE TABLE quality.defect_code_process (
    defect_code_process_id bigint NOT NULL,
    defect_code_id bigint NOT NULL,
    process_id bigint NOT NULL,
    is_primary boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint
);


--
-- Name: defect_code_process_defect_code_process_id_seq; Type: SEQUENCE; Schema: quality; Owner: -
--

ALTER TABLE quality.defect_code_process ALTER COLUMN defect_code_process_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME quality.defect_code_process_defect_code_process_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: defect_record; Type: TABLE; Schema: quality; Owner: -
--

CREATE TABLE quality.defect_record (
    defect_record_id bigint NOT NULL,
    production_result_id bigint,
    inspection_result_id bigint,
    work_order_id bigint,
    lot_id bigint,
    defect_code_id bigint NOT NULL,
    suspected_cause_code_id bigint,
    confirmed_cause_code_id bigint,
    responsibility_type_code app.code_t,
    responsible_department_id bigint,
    worker_id bigint,
    defect_description text,
    defect_qty app.qty_t NOT NULL,
    uom_id bigint NOT NULL,
    occurrence_process_id bigint NOT NULL,
    detection_process_id bigint NOT NULL,
    equipment_id bigint,
    mold_id bigint,
    occurred_at timestamp with time zone,
    detected_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    source_type_code app.code_t,
    source_document_id bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT ck_defect_source CHECK (((production_result_id IS NOT NULL) OR (inspection_result_id IS NOT NULL) OR ((source_type_code IS NOT NULL) AND (source_document_id IS NOT NULL)))),
    CONSTRAINT defect_record_defect_qty_check CHECK (((defect_qty)::numeric > (0)::numeric)),
    CONSTRAINT defect_record_version_no_check CHECK ((version_no > 0))
);


--
-- Name: defect_record_defect_record_id_seq; Type: SEQUENCE; Schema: quality; Owner: -
--

ALTER TABLE quality.defect_record ALTER COLUMN defect_record_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME quality.defect_record_defect_record_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: disposition_decision; Type: TABLE; Schema: quality; Owner: -
--

CREATE TABLE quality.disposition_decision (
    disposition_decision_id bigint NOT NULL,
    nonconformance_id bigint NOT NULL,
    disposition_type_code app.code_t NOT NULL,
    decision_qty app.qty_t NOT NULL,
    uom_id bigint NOT NULL,
    reason text NOT NULL,
    decided_by bigint NOT NULL,
    decided_at timestamp with time zone NOT NULL,
    approval_request_id bigint,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT disposition_decision_decision_qty_check CHECK (((decision_qty)::numeric > (0)::numeric))
);


--
-- Name: disposition_decision_disposition_decision_id_seq; Type: SEQUENCE; Schema: quality; Owner: -
--

ALTER TABLE quality.disposition_decision ALTER COLUMN disposition_decision_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME quality.disposition_decision_disposition_decision_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: equipment_calibration; Type: TABLE; Schema: quality; Owner: -
--

CREATE TABLE quality.equipment_calibration (
    equipment_calibration_id bigint NOT NULL,
    equipment_id bigint NOT NULL,
    calibration_date date NOT NULL,
    result_code app.code_t NOT NULL,
    valid_until date,
    certificate_no character varying(100),
    calibrated_by bigint,
    remarks text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint
);


--
-- Name: equipment_calibration_equipment_calibration_id_seq; Type: SEQUENCE; Schema: quality; Owner: -
--

ALTER TABLE quality.equipment_calibration ALTER COLUMN equipment_calibration_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME quality.equipment_calibration_equipment_calibration_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: inspection_item_spec; Type: TABLE; Schema: quality; Owner: -
--

CREATE TABLE quality.inspection_item_spec (
    inspection_item_spec_id bigint NOT NULL,
    inspection_plan_version_id bigint NOT NULL,
    sequence_no integer NOT NULL,
    inspection_item_code app.code_t NOT NULL,
    inspection_item_name app.name_t NOT NULL,
    data_type_code app.code_t NOT NULL,
    uom_id bigint,
    target_value numeric(20,6),
    lower_limit numeric(20,6),
    upper_limit numeric(20,6),
    measurement_count integer DEFAULT 1 NOT NULL,
    inspection_method_code app.code_t,
    default_inspection_equipment_id bigint,
    required_flag boolean DEFAULT true NOT NULL,
    automatic_judgment boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    CONSTRAINT ck_inspection_limits CHECK (((upper_limit IS NULL) OR (lower_limit IS NULL) OR (upper_limit >= lower_limit))),
    CONSTRAINT inspection_item_spec_measurement_count_check CHECK ((measurement_count > 0)),
    CONSTRAINT inspection_item_spec_sequence_no_check CHECK ((sequence_no > 0))
);


--
-- Name: inspection_item_spec_inspection_item_spec_id_seq; Type: SEQUENCE; Schema: quality; Owner: -
--

ALTER TABLE quality.inspection_item_spec ALTER COLUMN inspection_item_spec_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME quality.inspection_item_spec_inspection_item_spec_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: inspection_measurement; Type: TABLE; Schema: quality; Owner: -
--

CREATE TABLE quality.inspection_measurement (
    inspection_measurement_id bigint NOT NULL,
    inspection_result_id bigint NOT NULL,
    inspection_item_spec_id bigint NOT NULL,
    sample_no integer NOT NULL,
    numeric_value numeric(20,6),
    text_value text,
    boolean_value boolean,
    judgment_code app.code_t NOT NULL,
    measured_at timestamp with time zone NOT NULL,
    inspection_equipment_id bigint,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    CONSTRAINT ck_measurement_single_value CHECK ((num_nonnulls(numeric_value, text_value, boolean_value) <= 1)),
    CONSTRAINT inspection_measurement_sample_no_check CHECK ((sample_no > 0))
);


--
-- Name: inspection_measurement_inspection_measurement_id_seq; Type: SEQUENCE; Schema: quality; Owner: -
--

ALTER TABLE quality.inspection_measurement ALTER COLUMN inspection_measurement_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME quality.inspection_measurement_inspection_measurement_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: inspection_plan; Type: TABLE; Schema: quality; Owner: -
--

CREATE TABLE quality.inspection_plan (
    inspection_plan_id bigint NOT NULL,
    inspection_plan_code app.code_t NOT NULL,
    inspection_plan_name app.name_t NOT NULL,
    item_id bigint,
    process_id bigint,
    routing_id bigint,
    inspection_type_code app.code_t NOT NULL,
    approved_by bigint,
    approved_at timestamp with time zone,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    pqc_skip_allowed boolean DEFAULT false NOT NULL,
    skip_reason_code app.code_t,
    simple_judgment_allowed boolean DEFAULT false NOT NULL,
    CONSTRAINT inspection_plan_version_no_check CHECK ((version_no > 0))
);


--
-- Name: inspection_plan_inspection_plan_id_seq; Type: SEQUENCE; Schema: quality; Owner: -
--

ALTER TABLE quality.inspection_plan ALTER COLUMN inspection_plan_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME quality.inspection_plan_inspection_plan_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: inspection_plan_version; Type: TABLE; Schema: quality; Owner: -
--

CREATE TABLE quality.inspection_plan_version (
    inspection_plan_version_id bigint NOT NULL,
    inspection_plan_id bigint NOT NULL,
    plan_version integer NOT NULL,
    effective_from date NOT NULL,
    effective_to date,
    sampling_method_code app.code_t NOT NULL,
    sampling_qty app.qty_t,
    aql_value numeric(9,4),
    acceptance_number integer,
    rejection_number integer,
    inspection_frequency_code app.code_t NOT NULL,
    frequency_interval_value numeric(18,6),
    frequency_interval_uom_code app.code_t,
    status_code app.code_t NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    sampling_ratio numeric(9,6),
    CONSTRAINT ck_inspection_plan_sampling_ratio CHECK (((sampling_ratio IS NULL) OR ((sampling_ratio >= (0)::numeric) AND (sampling_ratio <= (1)::numeric)))),
    CONSTRAINT ck_inspection_plan_version_dates CHECK (((effective_to IS NULL) OR (effective_to >= effective_from))),
    CONSTRAINT inspection_plan_version_acceptance_number_check CHECK (((acceptance_number IS NULL) OR (acceptance_number >= 0))),
    CONSTRAINT inspection_plan_version_plan_version_check CHECK ((plan_version > 0)),
    CONSTRAINT inspection_plan_version_rejection_number_check CHECK (((rejection_number IS NULL) OR (rejection_number > 0))),
    CONSTRAINT inspection_plan_version_version_no_check CHECK ((version_no > 0))
);


--
-- Name: inspection_plan_version_inspection_plan_version_id_seq; Type: SEQUENCE; Schema: quality; Owner: -
--

ALTER TABLE quality.inspection_plan_version ALTER COLUMN inspection_plan_version_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME quality.inspection_plan_version_inspection_plan_version_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: inspection_request; Type: TABLE; Schema: quality; Owner: -
--

CREATE TABLE quality.inspection_request (
    inspection_request_id bigint NOT NULL,
    inspection_request_no app.business_no_t NOT NULL,
    inspection_type_code app.code_t NOT NULL,
    inspection_plan_version_id bigint NOT NULL,
    target_type_code app.code_t NOT NULL,
    target_id bigint NOT NULL,
    item_id bigint NOT NULL,
    lot_id bigint,
    work_order_id bigint,
    production_result_id bigint,
    target_qty app.qty_t NOT NULL,
    uom_id bigint NOT NULL,
    coverage_from_at timestamp with time zone,
    coverage_to_at timestamp with time zone,
    status_code app.code_t NOT NULL,
    requested_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT inspection_request_target_qty_check CHECK (((target_qty)::numeric > (0)::numeric)),
    CONSTRAINT inspection_request_version_no_check CHECK ((version_no > 0))
);


--
-- Name: inspection_request_inspection_request_id_seq; Type: SEQUENCE; Schema: quality; Owner: -
--

ALTER TABLE quality.inspection_request ALTER COLUMN inspection_request_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME quality.inspection_request_inspection_request_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: inspection_result; Type: TABLE; Schema: quality; Owner: -
--

CREATE TABLE quality.inspection_result (
    inspection_result_id bigint NOT NULL,
    inspection_result_no app.business_no_t NOT NULL,
    inspection_request_id bigint NOT NULL,
    inspection_round integer DEFAULT 1 NOT NULL,
    inspected_qty app.qty_t NOT NULL,
    accepted_qty app.qty_t DEFAULT 0 NOT NULL,
    rejected_qty app.qty_t DEFAULT 0 NOT NULL,
    held_qty app.qty_t DEFAULT 0 NOT NULL,
    uom_id bigint NOT NULL,
    overall_judgment_code app.code_t NOT NULL,
    inspector_id bigint NOT NULL,
    inspected_at timestamp with time zone NOT NULL,
    confirmed_at timestamp with time zone,
    terminal_id bigint,
    status_code app.code_t NOT NULL,
    previous_result_id bigint,
    reinspection_reason_code app.code_t,
    idempotency_key character varying(150) NOT NULL,
    remarks text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT ck_inspection_result_qty CHECK (((((accepted_qty)::numeric + (rejected_qty)::numeric) + (held_qty)::numeric) = (inspected_qty)::numeric)),
    CONSTRAINT inspection_result_inspected_qty_check CHECK (((inspected_qty)::numeric > (0)::numeric)),
    CONSTRAINT inspection_result_inspection_round_check CHECK ((inspection_round > 0)),
    CONSTRAINT inspection_result_version_no_check CHECK ((version_no > 0))
);


--
-- Name: inspection_result_inspection_result_id_seq; Type: SEQUENCE; Schema: quality; Owner: -
--

ALTER TABLE quality.inspection_result ALTER COLUMN inspection_result_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME quality.inspection_result_inspection_result_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: nonconformance; Type: TABLE; Schema: quality; Owner: -
--

CREATE TABLE quality.nonconformance (
    nonconformance_id bigint NOT NULL,
    nonconformance_no app.business_no_t NOT NULL,
    item_id bigint NOT NULL,
    work_order_id bigint,
    inspection_result_id bigint,
    severity_code app.code_t NOT NULL,
    description text NOT NULL,
    responsible_department_id bigint,
    action_description text,
    action_owner_id bigint,
    action_due_date date,
    action_completed_at timestamp with time zone,
    status_code app.code_t NOT NULL,
    opened_at timestamp with time zone NOT NULL,
    closed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT ck_nonconformance_dates CHECK (((closed_at IS NULL) OR (closed_at >= opened_at))),
    CONSTRAINT nonconformance_version_no_check CHECK ((version_no > 0))
);


--
-- Name: nonconformance_lot; Type: TABLE; Schema: quality; Owner: -
--

CREATE TABLE quality.nonconformance_lot (
    nonconformance_lot_id bigint NOT NULL,
    nonconformance_id bigint NOT NULL,
    lot_id bigint NOT NULL,
    affected_qty app.qty_t NOT NULL,
    uom_id bigint NOT NULL,
    quality_status_before_code app.code_t NOT NULL,
    quality_status_after_code app.code_t NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    CONSTRAINT nonconformance_lot_affected_qty_check CHECK (((affected_qty)::numeric > (0)::numeric))
);


--
-- Name: nonconformance_lot_nonconformance_lot_id_seq; Type: SEQUENCE; Schema: quality; Owner: -
--

ALTER TABLE quality.nonconformance_lot ALTER COLUMN nonconformance_lot_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME quality.nonconformance_lot_nonconformance_lot_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: nonconformance_nonconformance_id_seq; Type: SEQUENCE; Schema: quality; Owner: -
--

ALTER TABLE quality.nonconformance ALTER COLUMN nonconformance_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME quality.nonconformance_nonconformance_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: repair_result; Type: TABLE; Schema: quality; Owner: -
--

CREATE TABLE quality.repair_result (
    repair_result_id bigint NOT NULL,
    repair_result_no app.business_no_t NOT NULL,
    defect_record_id bigint NOT NULL,
    work_order_id bigint,
    lot_id bigint,
    repair_type_code app.code_t NOT NULL,
    repair_qty app.qty_t NOT NULL,
    uom_id bigint NOT NULL,
    result_code app.code_t NOT NULL,
    repaired_at timestamp with time zone NOT NULL,
    repaired_by bigint,
    remarks text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT repair_result_repair_qty_check CHECK (((repair_qty)::numeric > (0)::numeric)),
    CONSTRAINT repair_result_version_no_check CHECK ((version_no > 0))
);


--
-- Name: repair_result_repair_result_id_seq; Type: SEQUENCE; Schema: quality; Owner: -
--

ALTER TABLE quality.repair_result ALTER COLUMN repair_result_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME quality.repair_result_repair_result_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: sorting_result; Type: TABLE; Schema: quality; Owner: -
--

CREATE TABLE quality.sorting_result (
    sorting_result_id bigint NOT NULL,
    disposition_decision_id bigint NOT NULL,
    sorted_qty app.qty_t NOT NULL,
    good_qty app.qty_t DEFAULT 0 NOT NULL,
    defect_qty app.qty_t DEFAULT 0 NOT NULL,
    hold_qty app.qty_t DEFAULT 0 NOT NULL,
    uom_id bigint NOT NULL,
    sorting_criteria text,
    worker_id bigint NOT NULL,
    started_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone,
    good_lot_id bigint,
    defect_lot_id bigint,
    status_code app.code_t NOT NULL,
    remarks text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    CONSTRAINT ck_sorting_qty CHECK (((((good_qty)::numeric + (defect_qty)::numeric) + (hold_qty)::numeric) <= (sorted_qty)::numeric)),
    CONSTRAINT sorting_result_sorted_qty_check CHECK (((sorted_qty)::numeric > (0)::numeric))
);


--
-- Name: sorting_result_sorting_result_id_seq; Type: SEQUENCE; Schema: quality; Owner: -
--

ALTER TABLE quality.sorting_result ALTER COLUMN sorting_result_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME quality.sorting_result_sorting_result_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: impact_analysis; Type: TABLE; Schema: trace; Owner: -
--

CREATE TABLE trace.impact_analysis (
    impact_analysis_id bigint NOT NULL,
    analysis_no app.business_no_t NOT NULL,
    source_lot_id bigint NOT NULL,
    direction_code app.code_t NOT NULL,
    analysis_condition text,
    analyzed_at timestamp with time zone NOT NULL,
    analyzed_by bigint,
    affected_lot_count integer,
    result_summary jsonb,
    status_code app.code_t NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint
);


--
-- Name: impact_analysis_impact_analysis_id_seq; Type: SEQUENCE; Schema: trace; Owner: -
--

ALTER TABLE trace.impact_analysis ALTER COLUMN impact_analysis_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME trace.impact_analysis_impact_analysis_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: lot_external_identifier; Type: TABLE; Schema: trace; Owner: -
--

CREATE TABLE trace.lot_external_identifier (
    lot_external_identifier_id bigint NOT NULL,
    lot_id bigint NOT NULL,
    identifier_type_code app.code_t NOT NULL,
    external_identifier character varying(150) NOT NULL,
    partner_id bigint,
    external_system_code app.code_t,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint
);


--
-- Name: lot_external_identifier_lot_external_identifier_id_seq; Type: SEQUENCE; Schema: trace; Owner: -
--

ALTER TABLE trace.lot_external_identifier ALTER COLUMN lot_external_identifier_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME trace.lot_external_identifier_lot_external_identifier_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: lot_hold; Type: TABLE; Schema: trace; Owner: -
--

CREATE TABLE trace.lot_hold (
    lot_hold_id bigint NOT NULL,
    lot_id bigint NOT NULL,
    hold_qty app.qty_t,
    uom_id bigint,
    reason_code app.code_t NOT NULL,
    release_condition text,
    status_code app.code_t NOT NULL,
    held_by bigint,
    held_at timestamp with time zone NOT NULL,
    released_by bigint,
    released_at timestamp with time zone,
    remarks text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    release_reason_code app.code_t,
    CONSTRAINT ck_lot_hold_qty_uom CHECK (((hold_qty IS NULL) = (uom_id IS NULL))),
    CONSTRAINT ck_lot_hold_release CHECK (((released_at IS NULL) OR (released_at >= held_at)))
);


--
-- Name: lot_hold_lot_hold_id_seq; Type: SEQUENCE; Schema: trace; Owner: -
--

ALTER TABLE trace.lot_hold ALTER COLUMN lot_hold_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME trace.lot_hold_lot_hold_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: lot_lot_id_seq; Type: SEQUENCE; Schema: trace; Owner: -
--

ALTER TABLE trace.lot ALTER COLUMN lot_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME trace.lot_lot_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: lot_relation; Type: TABLE; Schema: trace; Owner: -
--

CREATE TABLE trace.lot_relation (
    lot_relation_id bigint NOT NULL,
    source_lot_id bigint NOT NULL,
    target_lot_id bigint NOT NULL,
    relation_type_code app.code_t NOT NULL,
    relation_qty app.qty_t NOT NULL,
    uom_id bigint NOT NULL,
    source_event_type_code app.code_t NOT NULL,
    source_event_id bigint NOT NULL,
    allocation_method_code app.code_t NOT NULL,
    trace_accuracy_code app.code_t NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    CONSTRAINT ck_lot_relation_self CHECK ((source_lot_id <> target_lot_id)),
    CONSTRAINT lot_relation_relation_qty_check CHECK (((relation_qty)::numeric > (0)::numeric))
);


--
-- Name: lot_relation_lot_relation_id_seq; Type: SEQUENCE; Schema: trace; Owner: -
--

ALTER TABLE trace.lot_relation ALTER COLUMN lot_relation_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME trace.lot_relation_lot_relation_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: lot_status_event; Type: TABLE; Schema: trace; Owner: -
--

CREATE TABLE trace.lot_status_event (
    lot_status_event_id bigint NOT NULL,
    lot_id bigint NOT NULL,
    location_id bigint,
    quality_status_code app.code_t,
    inventory_status_code app.code_t,
    previous_status_code app.code_t,
    new_status_code app.code_t NOT NULL,
    reason_code app.code_t,
    source_document_type_code app.code_t NOT NULL,
    source_document_id bigint NOT NULL,
    changed_at timestamp with time zone NOT NULL,
    changed_by bigint,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);


--
-- Name: lot_status_event_lot_status_event_id_seq; Type: SEQUENCE; Schema: trace; Owner: -
--

ALTER TABLE trace.lot_status_event ALTER COLUMN lot_status_event_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME trace.lot_status_event_lot_status_event_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: serial_component_relation; Type: TABLE; Schema: trace; Owner: -
--

CREATE TABLE trace.serial_component_relation (
    serial_component_relation_id bigint NOT NULL,
    parent_serial_number_id bigint NOT NULL,
    component_serial_number_id bigint NOT NULL,
    work_order_id bigint NOT NULL,
    assembled_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    CONSTRAINT ck_serial_component_self CHECK ((parent_serial_number_id <> component_serial_number_id))
);


--
-- Name: serial_component_relation_serial_component_relation_id_seq; Type: SEQUENCE; Schema: trace; Owner: -
--

ALTER TABLE trace.serial_component_relation ALTER COLUMN serial_component_relation_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME trace.serial_component_relation_serial_component_relation_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: serial_number; Type: TABLE; Schema: trace; Owner: -
--

CREATE TABLE trace.serial_number (
    serial_number_id bigint NOT NULL,
    serial_no character varying(150) NOT NULL,
    item_id bigint NOT NULL,
    lot_id bigint NOT NULL,
    status_code app.code_t NOT NULL,
    produced_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by bigint,
    version_no integer DEFAULT 1 NOT NULL,
    CONSTRAINT serial_number_version_no_check CHECK ((version_no > 0))
);


--
-- Name: serial_number_serial_number_id_seq; Type: SEQUENCE; Schema: trace; Owner: -
--

ALTER TABLE trace.serial_number ALTER COLUMN serial_number_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME trace.serial_number_serial_number_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: audit_event_default; Type: TABLE ATTACH; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.audit_event ATTACH PARTITION audit.audit_event_default DEFAULT;


--
-- Name: inventory_transaction_default; Type: TABLE ATTACH; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_transaction ATTACH PARTITION inventory.inventory_transaction_default DEFAULT;


--
-- Name: app_user app_user_login_id_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.app_user
    ADD CONSTRAINT app_user_login_id_key UNIQUE (login_id);


--
-- Name: app_user app_user_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.app_user
    ADD CONSTRAINT app_user_pkey PRIMARY KEY (app_user_id);


--
-- Name: approval_request approval_request_approval_request_no_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.approval_request
    ADD CONSTRAINT approval_request_approval_request_no_key UNIQUE (approval_request_no);


--
-- Name: approval_request approval_request_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.approval_request
    ADD CONSTRAINT approval_request_pkey PRIMARY KEY (approval_request_id);


--
-- Name: approval_route approval_route_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.approval_route
    ADD CONSTRAINT approval_route_pkey PRIMARY KEY (approval_route_id);


--
-- Name: approval_route_step approval_route_step_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.approval_route_step
    ADD CONSTRAINT approval_route_step_pkey PRIMARY KEY (approval_route_step_id);


--
-- Name: approval_step approval_step_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.approval_step
    ADD CONSTRAINT approval_step_pkey PRIMARY KEY (approval_step_id);


--
-- Name: attachment attachment_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.attachment
    ADD CONSTRAINT attachment_pkey PRIMARY KEY (attachment_id);


--
-- Name: document_cancellation document_cancellation_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.document_cancellation
    ADD CONSTRAINT document_cancellation_pkey PRIMARY KEY (document_cancellation_id);


--
-- Name: document_issue_log document_issue_log_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.document_issue_log
    ADD CONSTRAINT document_issue_log_pkey PRIMARY KEY (document_issue_log_id);


--
-- Name: entity_type_registry entity_type_registry_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.entity_type_registry
    ADD CONSTRAINT entity_type_registry_pkey PRIMARY KEY (entity_type_code);


--
-- Name: exception_case exception_case_exception_case_no_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.exception_case
    ADD CONSTRAINT exception_case_exception_case_no_key UNIQUE (exception_case_no);


--
-- Name: exception_case exception_case_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.exception_case
    ADD CONSTRAINT exception_case_pkey PRIMARY KEY (exception_case_id);


--
-- Name: idempotency_record idempotency_record_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.idempotency_record
    ADD CONSTRAINT idempotency_record_pkey PRIMARY KEY (idempotency_key);


--
-- Name: localized_text localized_text_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.localized_text
    ADD CONSTRAINT localized_text_pkey PRIMARY KEY (localized_text_id);


--
-- Name: notice_acknowledgement notice_acknowledgement_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.notice_acknowledgement
    ADD CONSTRAINT notice_acknowledgement_pkey PRIMARY KEY (notice_acknowledgement_id);


--
-- Name: notice notice_notice_no_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.notice
    ADD CONSTRAINT notice_notice_no_key UNIQUE (notice_no);


--
-- Name: notice notice_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.notice
    ADD CONSTRAINT notice_pkey PRIMARY KEY (notice_id);


--
-- Name: notification_event notification_event_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.notification_event
    ADD CONSTRAINT notification_event_pkey PRIMARY KEY (notification_event_id);


--
-- Name: notification notification_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.notification
    ADD CONSTRAINT notification_pkey PRIMARY KEY (notification_id);


--
-- Name: notification_subscription notification_subscription_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.notification_subscription
    ADD CONSTRAINT notification_subscription_pkey PRIMARY KEY (notification_subscription_id);


--
-- Name: numbering_counter numbering_counter_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.numbering_counter
    ADD CONSTRAINT numbering_counter_pkey PRIMARY KEY (numbering_counter_id);


--
-- Name: numbering_rule numbering_rule_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.numbering_rule
    ADD CONSTRAINT numbering_rule_pkey PRIMARY KEY (numbering_rule_id);


--
-- Name: operation_policy operation_policy_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.operation_policy
    ADD CONSTRAINT operation_policy_pkey PRIMARY KEY (operation_policy_id);


--
-- Name: printer printer_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.printer
    ADD CONSTRAINT printer_pkey PRIMARY KEY (printer_id);


--
-- Name: role_permission role_permission_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.role_permission
    ADD CONSTRAINT role_permission_pkey PRIMARY KEY (role_permission_id);


--
-- Name: role role_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.role
    ADD CONSTRAINT role_pkey PRIMARY KEY (role_id);


--
-- Name: role role_role_code_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.role
    ADD CONSTRAINT role_role_code_key UNIQUE (role_code);


--
-- Name: approval_route_step uq_approval_route_step; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.approval_route_step
    ADD CONSTRAINT uq_approval_route_step UNIQUE (approval_route_id, step_no);


--
-- Name: approval_step uq_approval_step; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.approval_step
    ADD CONSTRAINT uq_approval_step UNIQUE (approval_request_id, step_no);


--
-- Name: document_issue_log uq_document_issue_log; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.document_issue_log
    ADD CONSTRAINT uq_document_issue_log UNIQUE (document_type_code, target_type_code, target_id, issue_seq);


--
-- Name: entity_type_registry uq_entity_type_table; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.entity_type_registry
    ADD CONSTRAINT uq_entity_type_table UNIQUE (schema_name, table_name);


--
-- Name: localized_text uq_localized_text; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.localized_text
    ADD CONSTRAINT uq_localized_text UNIQUE (entity_type_code, entity_id, field_code, language_code);


--
-- Name: notice_acknowledgement uq_notice_acknowledgement; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.notice_acknowledgement
    ADD CONSTRAINT uq_notice_acknowledgement UNIQUE (notice_id, app_user_id);


--
-- Name: notification_event uq_notification_event; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.notification_event
    ADD CONSTRAINT uq_notification_event UNIQUE (event_type_code, aggregate_type_code, aggregate_id, occurred_at);


--
-- Name: notification uq_notification_recipient; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.notification
    ADD CONSTRAINT uq_notification_recipient UNIQUE (notification_event_id, recipient_user_id);


--
-- Name: notification_subscription uq_notification_subscription; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.notification_subscription
    ADD CONSTRAINT uq_notification_subscription UNIQUE (app_user_id, event_type_code, channel_code);


--
-- Name: numbering_counter uq_numbering_counter; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.numbering_counter
    ADD CONSTRAINT uq_numbering_counter UNIQUE (numbering_rule_id, period_key);


--
-- Name: printer uq_printer; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.printer
    ADD CONSTRAINT uq_printer UNIQUE (plant_id, printer_code);


--
-- Name: role_permission uq_role_permission; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.role_permission
    ADD CONSTRAINT uq_role_permission UNIQUE (role_id, permission_code);


--
-- Name: user_role uq_user_role; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.user_role
    ADD CONSTRAINT uq_user_role UNIQUE (app_user_id, role_id);


--
-- Name: user_credential user_credential_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.user_credential
    ADD CONSTRAINT user_credential_pkey PRIMARY KEY (app_user_id);


--
-- Name: user_data_scope user_data_scope_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.user_data_scope
    ADD CONSTRAINT user_data_scope_pkey PRIMARY KEY (user_data_scope_id);


--
-- Name: user_role user_role_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.user_role
    ADD CONSTRAINT user_role_pkey PRIMARY KEY (user_role_id);


--
-- Name: worker_lease worker_lease_lease_token_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.worker_lease
    ADD CONSTRAINT worker_lease_lease_token_key UNIQUE (lease_token);


--
-- Name: worker_lease worker_lease_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.worker_lease
    ADD CONSTRAINT worker_lease_pkey PRIMARY KEY (worker_lease_id);


--
-- Name: audit_event audit_event_pkey; Type: CONSTRAINT; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.audit_event
    ADD CONSTRAINT audit_event_pkey PRIMARY KEY (audit_event_id, occurred_at);


--
-- Name: audit_event_default audit_event_default_pkey; Type: CONSTRAINT; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.audit_event_default
    ADD CONSTRAINT audit_event_default_pkey PRIMARY KEY (audit_event_id, occurred_at);


--
-- Name: external_document_reference external_document_reference_pkey; Type: CONSTRAINT; Schema: integration; Owner: -
--

ALTER TABLE ONLY integration.external_document_reference
    ADD CONSTRAINT external_document_reference_pkey PRIMARY KEY (external_document_reference_id);


--
-- Name: integration_message integration_message_message_key_key; Type: CONSTRAINT; Schema: integration; Owner: -
--

ALTER TABLE ONLY integration.integration_message
    ADD CONSTRAINT integration_message_message_key_key UNIQUE (message_key);


--
-- Name: integration_message integration_message_pkey; Type: CONSTRAINT; Schema: integration; Owner: -
--

ALTER TABLE ONLY integration.integration_message
    ADD CONSTRAINT integration_message_pkey PRIMARY KEY (integration_message_id);


--
-- Name: interface_definition interface_definition_interface_code_key; Type: CONSTRAINT; Schema: integration; Owner: -
--

ALTER TABLE ONLY integration.interface_definition
    ADD CONSTRAINT interface_definition_interface_code_key UNIQUE (interface_code);


--
-- Name: interface_definition interface_definition_pkey; Type: CONSTRAINT; Schema: integration; Owner: -
--

ALTER TABLE ONLY integration.interface_definition
    ADD CONSTRAINT interface_definition_pkey PRIMARY KEY (interface_definition_id);


--
-- Name: outbound_item_setting outbound_item_setting_pkey; Type: CONSTRAINT; Schema: integration; Owner: -
--

ALTER TABLE ONLY integration.outbound_item_setting
    ADD CONSTRAINT outbound_item_setting_pkey PRIMARY KEY (outbound_item_setting_id);


--
-- Name: record_provenance record_provenance_pkey; Type: CONSTRAINT; Schema: integration; Owner: -
--

ALTER TABLE ONLY integration.record_provenance
    ADD CONSTRAINT record_provenance_pkey PRIMARY KEY (record_provenance_id);


--
-- Name: outbound_item_setting uq_outbound_item_setting; Type: CONSTRAINT; Schema: integration; Owner: -
--

ALTER TABLE ONLY integration.outbound_item_setting
    ADD CONSTRAINT uq_outbound_item_setting UNIQUE (interface_definition_id, item_id, effective_from);


--
-- Name: record_provenance uq_record_provenance; Type: CONSTRAINT; Schema: integration; Owner: -
--

ALTER TABLE ONLY integration.record_provenance
    ADD CONSTRAINT uq_record_provenance UNIQUE (entity_type_code, entity_id, source_system_code);


--
-- Name: handling_unit_content handling_unit_content_pkey; Type: CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.handling_unit_content
    ADD CONSTRAINT handling_unit_content_pkey PRIMARY KEY (handling_unit_content_id);


--
-- Name: handling_unit handling_unit_handling_unit_no_key; Type: CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.handling_unit
    ADD CONSTRAINT handling_unit_handling_unit_no_key UNIQUE (handling_unit_no);


--
-- Name: handling_unit handling_unit_pkey; Type: CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.handling_unit
    ADD CONSTRAINT handling_unit_pkey PRIMARY KEY (handling_unit_id);


--
-- Name: handling_unit_reconfiguration_line handling_unit_reconfiguration_line_pkey; Type: CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.handling_unit_reconfiguration_line
    ADD CONSTRAINT handling_unit_reconfiguration_line_pkey PRIMARY KEY (handling_unit_reconfiguration_line_id);


--
-- Name: handling_unit_reconfiguration handling_unit_reconfiguration_pkey; Type: CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.handling_unit_reconfiguration
    ADD CONSTRAINT handling_unit_reconfiguration_pkey PRIMARY KEY (handling_unit_reconfiguration_id);


--
-- Name: handling_unit_reconfiguration handling_unit_reconfiguration_reconfiguration_no_key; Type: CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.handling_unit_reconfiguration
    ADD CONSTRAINT handling_unit_reconfiguration_reconfiguration_no_key UNIQUE (reconfiguration_no);


--
-- Name: inventory_adjustment inventory_adjustment_inventory_adjustment_no_key; Type: CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_adjustment
    ADD CONSTRAINT inventory_adjustment_inventory_adjustment_no_key UNIQUE (inventory_adjustment_no);


--
-- Name: inventory_adjustment_line inventory_adjustment_line_pkey; Type: CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_adjustment_line
    ADD CONSTRAINT inventory_adjustment_line_pkey PRIMARY KEY (inventory_adjustment_line_id);


--
-- Name: inventory_adjustment inventory_adjustment_pkey; Type: CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_adjustment
    ADD CONSTRAINT inventory_adjustment_pkey PRIMARY KEY (inventory_adjustment_id);


--
-- Name: inventory_balance inventory_balance_pkey; Type: CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_balance
    ADD CONSTRAINT inventory_balance_pkey PRIMARY KEY (inventory_balance_id);


--
-- Name: inventory_count inventory_count_inventory_count_no_key; Type: CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_count
    ADD CONSTRAINT inventory_count_inventory_count_no_key UNIQUE (inventory_count_no);


--
-- Name: inventory_count_line inventory_count_line_pkey; Type: CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_count_line
    ADD CONSTRAINT inventory_count_line_pkey PRIMARY KEY (inventory_count_line_id);


--
-- Name: inventory_count inventory_count_pkey; Type: CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_count
    ADD CONSTRAINT inventory_count_pkey PRIMARY KEY (inventory_count_id);


--
-- Name: inventory_reservation inventory_reservation_pkey; Type: CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_reservation
    ADD CONSTRAINT inventory_reservation_pkey PRIMARY KEY (inventory_reservation_id);


--
-- Name: inventory_reservation inventory_reservation_reservation_no_key; Type: CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_reservation
    ADD CONSTRAINT inventory_reservation_reservation_no_key UNIQUE (reservation_no);


--
-- Name: inventory_transaction uq_inventory_idempotency; Type: CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_transaction
    ADD CONSTRAINT uq_inventory_idempotency UNIQUE (idempotency_key, business_date);


--
-- Name: inventory_transaction_default inventory_transaction_default_idempotency_key_business_date_key; Type: CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_transaction_default
    ADD CONSTRAINT inventory_transaction_default_idempotency_key_business_date_key UNIQUE (idempotency_key, business_date);


--
-- Name: inventory_transaction inventory_transaction_pkey; Type: CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_transaction
    ADD CONSTRAINT inventory_transaction_pkey PRIMARY KEY (inventory_transaction_id, business_date);


--
-- Name: inventory_transaction_default inventory_transaction_default_pkey; Type: CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_transaction_default
    ADD CONSTRAINT inventory_transaction_default_pkey PRIMARY KEY (inventory_transaction_id, business_date);


--
-- Name: inventory_transaction uq_inventory_transaction_no; Type: CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_transaction
    ADD CONSTRAINT uq_inventory_transaction_no UNIQUE (transaction_no, business_date);


--
-- Name: inventory_transaction_default inventory_transaction_default_transaction_no_business_date_key; Type: CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_transaction_default
    ADD CONSTRAINT inventory_transaction_default_transaction_no_business_date_key UNIQUE (transaction_no, business_date);


--
-- Name: inventory_transaction_line inventory_transaction_line_pkey; Type: CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_transaction_line
    ADD CONSTRAINT inventory_transaction_line_pkey PRIMARY KEY (inventory_transaction_line_id);


--
-- Name: handling_unit_content uq_handling_unit_content; Type: CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.handling_unit_content
    ADD CONSTRAINT uq_handling_unit_content UNIQUE (handling_unit_id, item_id, lot_id);


--
-- Name: handling_unit_reconfiguration_line uq_handling_unit_reconfiguration_line; Type: CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.handling_unit_reconfiguration_line
    ADD CONSTRAINT uq_handling_unit_reconfiguration_line UNIQUE (handling_unit_reconfiguration_id, line_no);


--
-- Name: inventory_adjustment_line uq_inventory_adjustment_line; Type: CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_adjustment_line
    ADD CONSTRAINT uq_inventory_adjustment_line UNIQUE (inventory_adjustment_id, line_no);


--
-- Name: inventory_count_line uq_inventory_count_line; Type: CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_count_line
    ADD CONSTRAINT uq_inventory_count_line UNIQUE (inventory_count_id, line_no);


--
-- Name: inventory_transaction_line uq_inventory_transaction_line; Type: CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_transaction_line
    ADD CONSTRAINT uq_inventory_transaction_line UNIQUE (inventory_transaction_id, business_date, line_no);


--
-- Name: asn asn_asn_no_key; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.asn
    ADD CONSTRAINT asn_asn_no_key UNIQUE (asn_no);


--
-- Name: asn_line asn_line_pkey; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.asn_line
    ADD CONSTRAINT asn_line_pkey PRIMARY KEY (asn_line_id);


--
-- Name: asn asn_pkey; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.asn
    ADD CONSTRAINT asn_pkey PRIMARY KEY (asn_id);


--
-- Name: goods_issue goods_issue_goods_issue_no_key; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.goods_issue
    ADD CONSTRAINT goods_issue_goods_issue_no_key UNIQUE (goods_issue_no);


--
-- Name: goods_issue_line goods_issue_line_pkey; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.goods_issue_line
    ADD CONSTRAINT goods_issue_line_pkey PRIMARY KEY (goods_issue_line_id);


--
-- Name: goods_issue goods_issue_pkey; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.goods_issue
    ADD CONSTRAINT goods_issue_pkey PRIMARY KEY (goods_issue_id);


--
-- Name: goods_receipt goods_receipt_goods_receipt_no_key; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.goods_receipt
    ADD CONSTRAINT goods_receipt_goods_receipt_no_key UNIQUE (goods_receipt_no);


--
-- Name: goods_receipt_line goods_receipt_line_pkey; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.goods_receipt_line
    ADD CONSTRAINT goods_receipt_line_pkey PRIMARY KEY (goods_receipt_line_id);


--
-- Name: goods_receipt goods_receipt_pkey; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.goods_receipt
    ADD CONSTRAINT goods_receipt_pkey PRIMARY KEY (goods_receipt_id);


--
-- Name: inbound_receipt inbound_receipt_inbound_receipt_no_key; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.inbound_receipt
    ADD CONSTRAINT inbound_receipt_inbound_receipt_no_key UNIQUE (inbound_receipt_no);


--
-- Name: inbound_receipt_line inbound_receipt_line_pkey; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.inbound_receipt_line
    ADD CONSTRAINT inbound_receipt_line_pkey PRIMARY KEY (inbound_receipt_line_id);


--
-- Name: inbound_receipt inbound_receipt_pkey; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.inbound_receipt
    ADD CONSTRAINT inbound_receipt_pkey PRIMARY KEY (inbound_receipt_id);


--
-- Name: inbound_variance inbound_variance_pkey; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.inbound_variance
    ADD CONSTRAINT inbound_variance_pkey PRIMARY KEY (inbound_variance_id);


--
-- Name: material_issue_request material_issue_request_issue_request_no_key; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.material_issue_request
    ADD CONSTRAINT material_issue_request_issue_request_no_key UNIQUE (issue_request_no);


--
-- Name: material_issue_request_line material_issue_request_line_pkey; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.material_issue_request_line
    ADD CONSTRAINT material_issue_request_line_pkey PRIMARY KEY (material_issue_request_line_id);


--
-- Name: material_issue_request material_issue_request_pkey; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.material_issue_request
    ADD CONSTRAINT material_issue_request_pkey PRIMARY KEY (material_issue_request_id);


--
-- Name: picking_line picking_line_pkey; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.picking_line
    ADD CONSTRAINT picking_line_pkey PRIMARY KEY (picking_line_id);


--
-- Name: picking_order picking_order_picking_order_no_key; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.picking_order
    ADD CONSTRAINT picking_order_picking_order_no_key UNIQUE (picking_order_no);


--
-- Name: picking_order picking_order_pkey; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.picking_order
    ADD CONSTRAINT picking_order_pkey PRIMARY KEY (picking_order_id);


--
-- Name: purchase_order_line purchase_order_line_pkey; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.purchase_order_line
    ADD CONSTRAINT purchase_order_line_pkey PRIMARY KEY (purchase_order_line_id);


--
-- Name: purchase_order purchase_order_pkey; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.purchase_order
    ADD CONSTRAINT purchase_order_pkey PRIMARY KEY (purchase_order_id);


--
-- Name: purchase_order purchase_order_purchase_order_no_key; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.purchase_order
    ADD CONSTRAINT purchase_order_purchase_order_no_key UNIQUE (purchase_order_no);


--
-- Name: putaway_rule putaway_rule_pkey; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.putaway_rule
    ADD CONSTRAINT putaway_rule_pkey PRIMARY KEY (putaway_rule_id);


--
-- Name: putaway_task putaway_task_pkey; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.putaway_task
    ADD CONSTRAINT putaway_task_pkey PRIMARY KEY (putaway_task_id);


--
-- Name: putaway_task putaway_task_putaway_task_no_key; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.putaway_task
    ADD CONSTRAINT putaway_task_putaway_task_no_key UNIQUE (putaway_task_no);


--
-- Name: recycle_entry recycle_entry_pkey; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.recycle_entry
    ADD CONSTRAINT recycle_entry_pkey PRIMARY KEY (recycle_entry_id);


--
-- Name: recycle_entry recycle_entry_recycle_entry_no_key; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.recycle_entry
    ADD CONSTRAINT recycle_entry_recycle_entry_no_key UNIQUE (recycle_entry_no);


--
-- Name: sales_order_line sales_order_line_pkey; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.sales_order_line
    ADD CONSTRAINT sales_order_line_pkey PRIMARY KEY (sales_order_line_id);


--
-- Name: sales_order sales_order_pkey; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.sales_order
    ADD CONSTRAINT sales_order_pkey PRIMARY KEY (sales_order_id);


--
-- Name: sales_order sales_order_sales_order_no_key; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.sales_order
    ADD CONSTRAINT sales_order_sales_order_no_key UNIQUE (sales_order_no);


--
-- Name: shipment_line shipment_line_pkey; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.shipment_line
    ADD CONSTRAINT shipment_line_pkey PRIMARY KEY (shipment_line_id);


--
-- Name: shipment_lot_allocation shipment_lot_allocation_pkey; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.shipment_lot_allocation
    ADD CONSTRAINT shipment_lot_allocation_pkey PRIMARY KEY (shipment_lot_allocation_id);


--
-- Name: shipment shipment_pkey; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.shipment
    ADD CONSTRAINT shipment_pkey PRIMARY KEY (shipment_id);


--
-- Name: shipment_request_line shipment_request_line_pkey; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.shipment_request_line
    ADD CONSTRAINT shipment_request_line_pkey PRIMARY KEY (shipment_request_line_id);


--
-- Name: shipment_request shipment_request_pkey; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.shipment_request
    ADD CONSTRAINT shipment_request_pkey PRIMARY KEY (shipment_request_id);


--
-- Name: shipment_request shipment_request_shipment_request_no_key; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.shipment_request
    ADD CONSTRAINT shipment_request_shipment_request_no_key UNIQUE (shipment_request_no);


--
-- Name: shipment shipment_shipment_no_key; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.shipment
    ADD CONSTRAINT shipment_shipment_no_key UNIQUE (shipment_no);


--
-- Name: shopfloor_receipt_line shopfloor_receipt_line_pkey; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.shopfloor_receipt_line
    ADD CONSTRAINT shopfloor_receipt_line_pkey PRIMARY KEY (shopfloor_receipt_line_id);


--
-- Name: shopfloor_receipt shopfloor_receipt_pkey; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.shopfloor_receipt
    ADD CONSTRAINT shopfloor_receipt_pkey PRIMARY KEY (shopfloor_receipt_id);


--
-- Name: shopfloor_receipt shopfloor_receipt_shopfloor_receipt_no_key; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.shopfloor_receipt
    ADD CONSTRAINT shopfloor_receipt_shopfloor_receipt_no_key UNIQUE (shopfloor_receipt_no);


--
-- Name: stock_transfer_line stock_transfer_line_pkey; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.stock_transfer_line
    ADD CONSTRAINT stock_transfer_line_pkey PRIMARY KEY (stock_transfer_line_id);


--
-- Name: stock_transfer stock_transfer_pkey; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.stock_transfer
    ADD CONSTRAINT stock_transfer_pkey PRIMARY KEY (stock_transfer_id);


--
-- Name: stock_transfer stock_transfer_stock_transfer_no_key; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.stock_transfer
    ADD CONSTRAINT stock_transfer_stock_transfer_no_key UNIQUE (stock_transfer_no);


--
-- Name: subcontract_issue subcontract_issue_pkey; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.subcontract_issue
    ADD CONSTRAINT subcontract_issue_pkey PRIMARY KEY (subcontract_issue_id);


--
-- Name: subcontract_order subcontract_order_pkey; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.subcontract_order
    ADD CONSTRAINT subcontract_order_pkey PRIMARY KEY (subcontract_order_id);


--
-- Name: subcontract_order subcontract_order_subcontract_order_no_key; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.subcontract_order
    ADD CONSTRAINT subcontract_order_subcontract_order_no_key UNIQUE (subcontract_order_no);


--
-- Name: subcontract_receipt subcontract_receipt_pkey; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.subcontract_receipt
    ADD CONSTRAINT subcontract_receipt_pkey PRIMARY KEY (subcontract_receipt_id);


--
-- Name: subcontract_reconciliation subcontract_reconciliation_pkey; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.subcontract_reconciliation
    ADD CONSTRAINT subcontract_reconciliation_pkey PRIMARY KEY (subcontract_reconciliation_id);


--
-- Name: asn_line uq_asn_line; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.asn_line
    ADD CONSTRAINT uq_asn_line UNIQUE (asn_id, line_no);


--
-- Name: goods_issue_line uq_goods_issue_line; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.goods_issue_line
    ADD CONSTRAINT uq_goods_issue_line UNIQUE (goods_issue_id, line_no);


--
-- Name: goods_receipt_line uq_goods_receipt_line; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.goods_receipt_line
    ADD CONSTRAINT uq_goods_receipt_line UNIQUE (goods_receipt_id, line_no);


--
-- Name: inbound_receipt_line uq_inbound_receipt_line; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.inbound_receipt_line
    ADD CONSTRAINT uq_inbound_receipt_line UNIQUE (inbound_receipt_id, line_no);


--
-- Name: material_issue_request_line uq_material_issue_request_line; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.material_issue_request_line
    ADD CONSTRAINT uq_material_issue_request_line UNIQUE (material_issue_request_id, line_no);


--
-- Name: picking_line uq_picking_line; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.picking_line
    ADD CONSTRAINT uq_picking_line UNIQUE (picking_order_id, line_no);


--
-- Name: purchase_order_line uq_purchase_order_line; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.purchase_order_line
    ADD CONSTRAINT uq_purchase_order_line UNIQUE (purchase_order_id, line_no);


--
-- Name: sales_order_line uq_sales_order_line; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.sales_order_line
    ADD CONSTRAINT uq_sales_order_line UNIQUE (sales_order_id, line_no);


--
-- Name: shipment_line uq_shipment_line; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.shipment_line
    ADD CONSTRAINT uq_shipment_line UNIQUE (shipment_id, line_no);


--
-- Name: shipment_request_line uq_shipment_request_line; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.shipment_request_line
    ADD CONSTRAINT uq_shipment_request_line UNIQUE (shipment_request_id, line_no);


--
-- Name: stock_transfer_line uq_stock_transfer_line; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.stock_transfer_line
    ADD CONSTRAINT uq_stock_transfer_line UNIQUE (stock_transfer_id, line_no);


--
-- Name: subcontract_issue uq_subcontract_issue; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.subcontract_issue
    ADD CONSTRAINT uq_subcontract_issue UNIQUE (subcontract_order_id, goods_issue_id);


--
-- Name: subcontract_receipt uq_subcontract_receipt; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.subcontract_receipt
    ADD CONSTRAINT uq_subcontract_receipt UNIQUE (subcontract_order_id, goods_receipt_id);


--
-- Name: subcontract_reconciliation uq_subcontract_reconciliation; Type: CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.subcontract_reconciliation
    ADD CONSTRAINT uq_subcontract_reconciliation UNIQUE (subcontract_order_id, settlement_seq);


--
-- Name: breakdown breakdown_breakdown_no_key; Type: CONSTRAINT; Schema: maintenance; Owner: -
--

ALTER TABLE ONLY maintenance.breakdown
    ADD CONSTRAINT breakdown_breakdown_no_key UNIQUE (breakdown_no);


--
-- Name: breakdown breakdown_pkey; Type: CONSTRAINT; Schema: maintenance; Owner: -
--

ALTER TABLE ONLY maintenance.breakdown
    ADD CONSTRAINT breakdown_pkey PRIMARY KEY (breakdown_id);


--
-- Name: collection_channel collection_channel_pkey; Type: CONSTRAINT; Schema: maintenance; Owner: -
--

ALTER TABLE ONLY maintenance.collection_channel
    ADD CONSTRAINT collection_channel_pkey PRIMARY KEY (collection_channel_id);


--
-- Name: collection_observation collection_observation_pkey; Type: CONSTRAINT; Schema: maintenance; Owner: -
--

ALTER TABLE ONLY maintenance.collection_observation
    ADD CONSTRAINT collection_observation_pkey PRIMARY KEY (collection_observation_id);


--
-- Name: equipment_downtime equipment_downtime_pkey; Type: CONSTRAINT; Schema: maintenance; Owner: -
--

ALTER TABLE ONLY maintenance.equipment_downtime
    ADD CONSTRAINT equipment_downtime_pkey PRIMARY KEY (equipment_downtime_id);


--
-- Name: equipment_inspection equipment_inspection_inspection_no_key; Type: CONSTRAINT; Schema: maintenance; Owner: -
--

ALTER TABLE ONLY maintenance.equipment_inspection
    ADD CONSTRAINT equipment_inspection_inspection_no_key UNIQUE (inspection_no);


--
-- Name: equipment_inspection equipment_inspection_pkey; Type: CONSTRAINT; Schema: maintenance; Owner: -
--

ALTER TABLE ONLY maintenance.equipment_inspection
    ADD CONSTRAINT equipment_inspection_pkey PRIMARY KEY (equipment_inspection_id);


--
-- Name: equipment_inspection_result equipment_inspection_result_pkey; Type: CONSTRAINT; Schema: maintenance; Owner: -
--

ALTER TABLE ONLY maintenance.equipment_inspection_result
    ADD CONSTRAINT equipment_inspection_result_pkey PRIMARY KEY (equipment_inspection_result_id);


--
-- Name: maintenance_order maintenance_order_maintenance_order_no_key; Type: CONSTRAINT; Schema: maintenance; Owner: -
--

ALTER TABLE ONLY maintenance.maintenance_order
    ADD CONSTRAINT maintenance_order_maintenance_order_no_key UNIQUE (maintenance_order_no);


--
-- Name: maintenance_order maintenance_order_pkey; Type: CONSTRAINT; Schema: maintenance; Owner: -
--

ALTER TABLE ONLY maintenance.maintenance_order
    ADD CONSTRAINT maintenance_order_pkey PRIMARY KEY (maintenance_order_id);


--
-- Name: maintenance_result maintenance_result_pkey; Type: CONSTRAINT; Schema: maintenance; Owner: -
--

ALTER TABLE ONLY maintenance.maintenance_result
    ADD CONSTRAINT maintenance_result_pkey PRIMARY KEY (maintenance_result_id);


--
-- Name: planned_stop planned_stop_pkey; Type: CONSTRAINT; Schema: maintenance; Owner: -
--

ALTER TABLE ONLY maintenance.planned_stop
    ADD CONSTRAINT planned_stop_pkey PRIMARY KEY (planned_stop_id);


--
-- Name: tool_usage tool_usage_pkey; Type: CONSTRAINT; Schema: maintenance; Owner: -
--

ALTER TABLE ONLY maintenance.tool_usage
    ADD CONSTRAINT tool_usage_pkey PRIMARY KEY (tool_usage_id);


--
-- Name: collection_channel uq_collection_channel; Type: CONSTRAINT; Schema: maintenance; Owner: -
--

ALTER TABLE ONLY maintenance.collection_channel
    ADD CONSTRAINT uq_collection_channel UNIQUE (equipment_id, channel_code);


--
-- Name: collection_observation uq_collection_observation; Type: CONSTRAINT; Schema: maintenance; Owner: -
--

ALTER TABLE ONLY maintenance.collection_observation
    ADD CONSTRAINT uq_collection_observation UNIQUE (collection_channel_id, observed_at, source_message_id);


--
-- Name: equipment_inspection_result uq_equipment_inspection_result; Type: CONSTRAINT; Schema: maintenance; Owner: -
--

ALTER TABLE ONLY maintenance.equipment_inspection_result
    ADD CONSTRAINT uq_equipment_inspection_result UNIQUE (equipment_inspection_id, equipment_inspection_item_id);


--
-- Name: maintenance_result uq_maintenance_result; Type: CONSTRAINT; Schema: maintenance; Owner: -
--

ALTER TABLE ONLY maintenance.maintenance_result
    ADD CONSTRAINT uq_maintenance_result UNIQUE (maintenance_order_id, result_seq);


--
-- Name: business_unit business_unit_pkey; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.business_unit
    ADD CONSTRAINT business_unit_pkey PRIMARY KEY (business_unit_id);


--
-- Name: code_group code_group_group_code_key; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.code_group
    ADD CONSTRAINT code_group_group_code_key UNIQUE (group_code);


--
-- Name: code_group code_group_pkey; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.code_group
    ADD CONSTRAINT code_group_pkey PRIMARY KEY (code_group_id);


--
-- Name: code_value code_value_pkey; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.code_value
    ADD CONSTRAINT code_value_pkey PRIMARY KEY (code_value_id);


--
-- Name: department department_department_code_key; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.department
    ADD CONSTRAINT department_department_code_key UNIQUE (department_code);


--
-- Name: department department_pkey; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.department
    ADD CONSTRAINT department_pkey PRIMARY KEY (department_id);


--
-- Name: equipment_group_inspection_item equipment_group_inspection_item_pkey; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.equipment_group_inspection_item
    ADD CONSTRAINT equipment_group_inspection_item_pkey PRIMARY KEY (equipment_group_inspection_item_id);


--
-- Name: equipment_group_member equipment_group_member_pkey; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.equipment_group_member
    ADD CONSTRAINT equipment_group_member_pkey PRIMARY KEY (equipment_group_member_id);


--
-- Name: equipment_group equipment_group_pkey; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.equipment_group
    ADD CONSTRAINT equipment_group_pkey PRIMARY KEY (equipment_group_id);


--
-- Name: equipment_inspection_item_assignment equipment_inspection_item_assignment_pkey; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.equipment_inspection_item_assignment
    ADD CONSTRAINT equipment_inspection_item_assignment_pkey PRIMARY KEY (equipment_inspection_item_assignment_id);


--
-- Name: equipment_inspection_item equipment_inspection_item_inspection_item_code_key; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.equipment_inspection_item
    ADD CONSTRAINT equipment_inspection_item_inspection_item_code_key UNIQUE (inspection_item_code);


--
-- Name: equipment_inspection_item equipment_inspection_item_pkey; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.equipment_inspection_item
    ADD CONSTRAINT equipment_inspection_item_pkey PRIMARY KEY (equipment_inspection_item_id);


--
-- Name: equipment equipment_pkey; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.equipment
    ADD CONSTRAINT equipment_pkey PRIMARY KEY (equipment_id);


--
-- Name: item_bu_item_map item_bu_item_map_pkey; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.item_bu_item_map
    ADD CONSTRAINT item_bu_item_map_pkey PRIMARY KEY (item_bu_item_map_id);


--
-- Name: item_external_code item_external_code_pkey; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.item_external_code
    ADD CONSTRAINT item_external_code_pkey PRIMARY KEY (item_external_code_id);


--
-- Name: item item_item_code_key; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.item
    ADD CONSTRAINT item_item_code_key UNIQUE (item_code);


--
-- Name: item item_pkey; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.item
    ADD CONSTRAINT item_pkey PRIMARY KEY (item_id);


--
-- Name: item_uom_conversion item_uom_conversion_pkey; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.item_uom_conversion
    ADD CONSTRAINT item_uom_conversion_pkey PRIMARY KEY (item_uom_conversion_id);


--
-- Name: legal_entity legal_entity_legal_entity_code_key; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.legal_entity
    ADD CONSTRAINT legal_entity_legal_entity_code_key UNIQUE (legal_entity_code);


--
-- Name: legal_entity legal_entity_pkey; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.legal_entity
    ADD CONSTRAINT legal_entity_pkey PRIMARY KEY (legal_entity_id);


--
-- Name: location location_pkey; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.location
    ADD CONSTRAINT location_pkey PRIMARY KEY (location_id);


--
-- Name: mold mold_pkey; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.mold
    ADD CONSTRAINT mold_pkey PRIMARY KEY (mold_id);


--
-- Name: partner partner_partner_code_key; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.partner
    ADD CONSTRAINT partner_partner_code_key UNIQUE (partner_code);


--
-- Name: partner partner_pkey; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.partner
    ADD CONSTRAINT partner_pkey PRIMARY KEY (partner_id);


--
-- Name: partner_role partner_role_pkey; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.partner_role
    ADD CONSTRAINT partner_role_pkey PRIMARY KEY (partner_role_id);


--
-- Name: plant plant_pkey; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.plant
    ADD CONSTRAINT plant_pkey PRIMARY KEY (plant_id);


--
-- Name: process process_pkey; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.process
    ADD CONSTRAINT process_pkey PRIMARY KEY (process_id);


--
-- Name: process process_process_code_key; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.process
    ADD CONSTRAINT process_process_code_key UNIQUE (process_code);


--
-- Name: production_line production_line_pkey; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.production_line
    ADD CONSTRAINT production_line_pkey PRIMARY KEY (production_line_id);


--
-- Name: shift shift_pkey; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.shift
    ADD CONSTRAINT shift_pkey PRIMARY KEY (shift_id);


--
-- Name: spare_part_equipment spare_part_equipment_pkey; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.spare_part_equipment
    ADD CONSTRAINT spare_part_equipment_pkey PRIMARY KEY (spare_part_equipment_id);


--
-- Name: spare_part spare_part_pkey; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.spare_part
    ADD CONSTRAINT spare_part_pkey PRIMARY KEY (spare_part_id);


--
-- Name: spare_part spare_part_spare_part_code_key; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.spare_part
    ADD CONSTRAINT spare_part_spare_part_code_key UNIQUE (spare_part_code);


--
-- Name: terminal terminal_pkey; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.terminal
    ADD CONSTRAINT terminal_pkey PRIMARY KEY (terminal_id);


--
-- Name: terminal_process terminal_process_pkey; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.terminal_process
    ADD CONSTRAINT terminal_process_pkey PRIMARY KEY (terminal_process_id);


--
-- Name: terminal terminal_terminal_code_key; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.terminal
    ADD CONSTRAINT terminal_terminal_code_key UNIQUE (terminal_code);


--
-- Name: uom uom_pkey; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.uom
    ADD CONSTRAINT uom_pkey PRIMARY KEY (uom_id);


--
-- Name: uom uom_uom_code_key; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.uom
    ADD CONSTRAINT uom_uom_code_key UNIQUE (uom_code);


--
-- Name: business_unit uq_business_unit; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.business_unit
    ADD CONSTRAINT uq_business_unit UNIQUE (legal_entity_id, business_unit_code);


--
-- Name: code_value uq_code_value; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.code_value
    ADD CONSTRAINT uq_code_value UNIQUE (code_group_id, code);


--
-- Name: equipment uq_equipment; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.equipment
    ADD CONSTRAINT uq_equipment UNIQUE (plant_id, equipment_code);


--
-- Name: equipment_group uq_equipment_group; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.equipment_group
    ADD CONSTRAINT uq_equipment_group UNIQUE (plant_id, equipment_group_code);


--
-- Name: equipment_group_inspection_item uq_equipment_group_inspection_item; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.equipment_group_inspection_item
    ADD CONSTRAINT uq_equipment_group_inspection_item UNIQUE (equipment_group_id, equipment_inspection_item_id);


--
-- Name: equipment_group_member uq_equipment_group_member; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.equipment_group_member
    ADD CONSTRAINT uq_equipment_group_member UNIQUE (equipment_group_id, equipment_id, effective_from);


--
-- Name: equipment_inspection_item_assignment uq_equipment_inspection_item_assignment; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.equipment_inspection_item_assignment
    ADD CONSTRAINT uq_equipment_inspection_item_assignment UNIQUE (equipment_id, equipment_inspection_item_id);


--
-- Name: item_bu_item_map uq_item_bu_item_map; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.item_bu_item_map
    ADD CONSTRAINT uq_item_bu_item_map UNIQUE (from_business_unit_id, from_item_id, to_business_unit_id, effective_from);


--
-- Name: item_uom_conversion uq_item_uom_conversion; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.item_uom_conversion
    ADD CONSTRAINT uq_item_uom_conversion UNIQUE (item_id, from_uom_id, to_uom_id, effective_from);


--
-- Name: location uq_location; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.location
    ADD CONSTRAINT uq_location UNIQUE (warehouse_id, location_code);


--
-- Name: mold uq_mold; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.mold
    ADD CONSTRAINT uq_mold UNIQUE (plant_id, mold_code);


--
-- Name: partner_role uq_partner_role; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.partner_role
    ADD CONSTRAINT uq_partner_role UNIQUE (partner_id, role_type_code);


--
-- Name: plant uq_plant; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.plant
    ADD CONSTRAINT uq_plant UNIQUE (legal_entity_id, plant_code);


--
-- Name: production_line uq_production_line; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.production_line
    ADD CONSTRAINT uq_production_line UNIQUE (plant_id, line_code);


--
-- Name: shift uq_shift; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.shift
    ADD CONSTRAINT uq_shift UNIQUE (plant_id, shift_code);


--
-- Name: spare_part_equipment uq_spare_part_equipment; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.spare_part_equipment
    ADD CONSTRAINT uq_spare_part_equipment UNIQUE (spare_part_id, equipment_id);


--
-- Name: terminal_process uq_terminal_process; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.terminal_process
    ADD CONSTRAINT uq_terminal_process UNIQUE (terminal_id, process_id);


--
-- Name: warehouse uq_warehouse; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.warehouse
    ADD CONSTRAINT uq_warehouse UNIQUE (plant_id, warehouse_code);


--
-- Name: warehouse_layout uq_warehouse_layout; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.warehouse_layout
    ADD CONSTRAINT uq_warehouse_layout UNIQUE (warehouse_id, layout_version);


--
-- Name: work_calendar uq_work_calendar; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.work_calendar
    ADD CONSTRAINT uq_work_calendar UNIQUE (plant_id, calendar_code);


--
-- Name: work_calendar_application uq_work_calendar_application; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.work_calendar_application
    ADD CONSTRAINT uq_work_calendar_application UNIQUE (work_calendar_id, target_type_code, target_id, effective_from);


--
-- Name: work_calendar_day uq_work_calendar_day; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.work_calendar_day
    ADD CONSTRAINT uq_work_calendar_day UNIQUE (work_calendar_id, calendar_date);


--
-- Name: warehouse_layout warehouse_layout_pkey; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.warehouse_layout
    ADD CONSTRAINT warehouse_layout_pkey PRIMARY KEY (warehouse_layout_id);


--
-- Name: warehouse warehouse_pkey; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.warehouse
    ADD CONSTRAINT warehouse_pkey PRIMARY KEY (warehouse_id);


--
-- Name: work_calendar_application work_calendar_application_pkey; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.work_calendar_application
    ADD CONSTRAINT work_calendar_application_pkey PRIMARY KEY (work_calendar_application_id);


--
-- Name: work_calendar_day work_calendar_day_pkey; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.work_calendar_day
    ADD CONSTRAINT work_calendar_day_pkey PRIMARY KEY (work_calendar_day_id);


--
-- Name: work_calendar work_calendar_pkey; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.work_calendar
    ADD CONSTRAINT work_calendar_pkey PRIMARY KEY (work_calendar_id);


--
-- Name: worker worker_pkey; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.worker
    ADD CONSTRAINT worker_pkey PRIMARY KEY (worker_id);


--
-- Name: worker_qualification worker_qualification_pkey; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.worker_qualification
    ADD CONSTRAINT worker_qualification_pkey PRIMARY KEY (worker_qualification_id);


--
-- Name: worker worker_worker_no_key; Type: CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.worker
    ADD CONSTRAINT worker_worker_no_key UNIQUE (worker_no);


--
-- Name: bom_component bom_component_pkey; Type: CONSTRAINT; Schema: planning; Owner: -
--

ALTER TABLE ONLY planning.bom_component
    ADD CONSTRAINT bom_component_pkey PRIMARY KEY (bom_component_id);


--
-- Name: bom bom_pkey; Type: CONSTRAINT; Schema: planning; Owner: -
--

ALTER TABLE ONLY planning.bom
    ADD CONSTRAINT bom_pkey PRIMARY KEY (bom_id);


--
-- Name: material_substitution_rule material_substitution_rule_pkey; Type: CONSTRAINT; Schema: planning; Owner: -
--

ALTER TABLE ONLY planning.material_substitution_rule
    ADD CONSTRAINT material_substitution_rule_pkey PRIMARY KEY (substitution_rule_id);


--
-- Name: production_order production_order_pkey; Type: CONSTRAINT; Schema: planning; Owner: -
--

ALTER TABLE ONLY planning.production_order
    ADD CONSTRAINT production_order_pkey PRIMARY KEY (production_order_id);


--
-- Name: production_order production_order_production_order_no_key; Type: CONSTRAINT; Schema: planning; Owner: -
--

ALTER TABLE ONLY planning.production_order
    ADD CONSTRAINT production_order_production_order_no_key UNIQUE (production_order_no);


--
-- Name: production_plan production_plan_pkey; Type: CONSTRAINT; Schema: planning; Owner: -
--

ALTER TABLE ONLY planning.production_plan
    ADD CONSTRAINT production_plan_pkey PRIMARY KEY (production_plan_id);


--
-- Name: production_plan production_plan_plan_no_key; Type: CONSTRAINT; Schema: planning; Owner: -
--

ALTER TABLE ONLY planning.production_plan
    ADD CONSTRAINT production_plan_plan_no_key UNIQUE (plan_no);


--
-- Name: routing_operation_dependency routing_operation_dependency_pkey; Type: CONSTRAINT; Schema: planning; Owner: -
--

ALTER TABLE ONLY planning.routing_operation_dependency
    ADD CONSTRAINT routing_operation_dependency_pkey PRIMARY KEY (routing_operation_dependency_id);


--
-- Name: routing_operation routing_operation_pkey; Type: CONSTRAINT; Schema: planning; Owner: -
--

ALTER TABLE ONLY planning.routing_operation
    ADD CONSTRAINT routing_operation_pkey PRIMARY KEY (routing_operation_id);


--
-- Name: routing routing_pkey; Type: CONSTRAINT; Schema: planning; Owner: -
--

ALTER TABLE ONLY planning.routing
    ADD CONSTRAINT routing_pkey PRIMARY KEY (routing_id);


--
-- Name: bom uq_bom; Type: CONSTRAINT; Schema: planning; Owner: -
--

ALTER TABLE ONLY planning.bom
    ADD CONSTRAINT uq_bom UNIQUE (parent_item_id, bom_code, bom_version);


--
-- Name: bom_component uq_bom_component; Type: CONSTRAINT; Schema: planning; Owner: -
--

ALTER TABLE ONLY planning.bom_component
    ADD CONSTRAINT uq_bom_component UNIQUE (bom_id, sequence_no);


--
-- Name: routing uq_routing; Type: CONSTRAINT; Schema: planning; Owner: -
--

ALTER TABLE ONLY planning.routing
    ADD CONSTRAINT uq_routing UNIQUE (item_id, routing_code, routing_version);


--
-- Name: routing_operation_dependency uq_routing_dependency; Type: CONSTRAINT; Schema: planning; Owner: -
--

ALTER TABLE ONLY planning.routing_operation_dependency
    ADD CONSTRAINT uq_routing_dependency UNIQUE (predecessor_operation_id, successor_operation_id);


--
-- Name: routing_operation uq_routing_operation; Type: CONSTRAINT; Schema: planning; Owner: -
--

ALTER TABLE ONLY planning.routing_operation
    ADD CONSTRAINT uq_routing_operation UNIQUE (routing_id, operation_seq);


--
-- Name: material_substitution_rule uq_substitution_rule; Type: CONSTRAINT; Schema: planning; Owner: -
--

ALTER TABLE ONLY planning.material_substitution_rule
    ADD CONSTRAINT uq_substitution_rule UNIQUE (bom_component_id, substitute_item_id, effective_from);


--
-- Name: material_consumption material_consumption_consumption_no_key; Type: CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.material_consumption
    ADD CONSTRAINT material_consumption_consumption_no_key UNIQUE (consumption_no);


--
-- Name: material_consumption material_consumption_idempotency_key_key; Type: CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.material_consumption
    ADD CONSTRAINT material_consumption_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: material_consumption material_consumption_pkey; Type: CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.material_consumption
    ADD CONSTRAINT material_consumption_pkey PRIMARY KEY (material_consumption_id);


--
-- Name: material_loss material_loss_pkey; Type: CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.material_loss
    ADD CONSTRAINT material_loss_pkey PRIMARY KEY (material_loss_id);


--
-- Name: material_return_line material_return_line_pkey; Type: CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.material_return_line
    ADD CONSTRAINT material_return_line_pkey PRIMARY KEY (material_return_line_id);


--
-- Name: material_return material_return_material_return_no_key; Type: CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.material_return
    ADD CONSTRAINT material_return_material_return_no_key UNIQUE (material_return_no);


--
-- Name: material_return material_return_pkey; Type: CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.material_return
    ADD CONSTRAINT material_return_pkey PRIMARY KEY (material_return_id);


--
-- Name: material_usage_allocation material_usage_allocation_pkey; Type: CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.material_usage_allocation
    ADD CONSTRAINT material_usage_allocation_pkey PRIMARY KEY (material_usage_allocation_id);


--
-- Name: operation_handover operation_handover_handover_no_key; Type: CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.operation_handover
    ADD CONSTRAINT operation_handover_handover_no_key UNIQUE (handover_no);


--
-- Name: operation_handover_line operation_handover_line_pkey; Type: CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.operation_handover_line
    ADD CONSTRAINT operation_handover_line_pkey PRIMARY KEY (operation_handover_line_id);


--
-- Name: operation_handover operation_handover_pkey; Type: CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.operation_handover
    ADD CONSTRAINT operation_handover_pkey PRIMARY KEY (operation_handover_id);


--
-- Name: production_order_acknowledgement production_order_acknowledgement_pkey; Type: CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.production_order_acknowledgement
    ADD CONSTRAINT production_order_acknowledgement_pkey PRIMARY KEY (production_order_acknowledgement_id);


--
-- Name: production_result production_result_idempotency_key_key; Type: CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.production_result
    ADD CONSTRAINT production_result_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: production_result_lot_allocation production_result_lot_allocation_pkey; Type: CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.production_result_lot_allocation
    ADD CONSTRAINT production_result_lot_allocation_pkey PRIMARY KEY (production_result_lot_allocation_id);


--
-- Name: production_result production_result_pkey; Type: CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.production_result
    ADD CONSTRAINT production_result_pkey PRIMARY KEY (production_result_id);


--
-- Name: production_result production_result_production_result_no_key; Type: CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.production_result
    ADD CONSTRAINT production_result_production_result_no_key UNIQUE (production_result_no);


--
-- Name: material_return_line uq_material_return_line; Type: CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.material_return_line
    ADD CONSTRAINT uq_material_return_line UNIQUE (material_return_id, line_no);


--
-- Name: operation_handover_line uq_operation_handover_line; Type: CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.operation_handover_line
    ADD CONSTRAINT uq_operation_handover_line UNIQUE (operation_handover_id, line_no);


--
-- Name: production_order_acknowledgement uq_production_order_ack; Type: CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.production_order_acknowledgement
    ADD CONSTRAINT uq_production_order_ack UNIQUE (production_order_id, acknowledgement_type_code, received_at);


--
-- Name: production_result_lot_allocation uq_production_result_lot; Type: CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.production_result_lot_allocation
    ADD CONSTRAINT uq_production_result_lot UNIQUE (production_result_id, lot_id);


--
-- Name: production_result uq_production_result_seq; Type: CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.production_result
    ADD CONSTRAINT uq_production_result_seq UNIQUE (work_order_id, result_sequence);


--
-- Name: work_order_dependency uq_work_order_dependency; Type: CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.work_order_dependency
    ADD CONSTRAINT uq_work_order_dependency UNIQUE (predecessor_work_order_id, successor_work_order_id);


--
-- Name: work_session uq_work_session; Type: CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.work_session
    ADD CONSTRAINT uq_work_session UNIQUE (work_order_id, session_no);


--
-- Name: work_session uq_work_session_idempotency_key; Type: CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.work_session
    ADD CONSTRAINT uq_work_session_idempotency_key UNIQUE (idempotency_key);


--
-- Name: work_order_dependency work_order_dependency_pkey; Type: CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.work_order_dependency
    ADD CONSTRAINT work_order_dependency_pkey PRIMARY KEY (work_order_dependency_id);


--
-- Name: work_order work_order_pkey; Type: CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.work_order
    ADD CONSTRAINT work_order_pkey PRIMARY KEY (work_order_id);


--
-- Name: work_order_resource_assignment work_order_resource_assignment_pkey; Type: CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.work_order_resource_assignment
    ADD CONSTRAINT work_order_resource_assignment_pkey PRIMARY KEY (work_order_resource_assignment_id);


--
-- Name: work_order work_order_work_order_no_key; Type: CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.work_order
    ADD CONSTRAINT work_order_work_order_no_key UNIQUE (work_order_no);


--
-- Name: work_session_event work_session_event_pkey; Type: CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.work_session_event
    ADD CONSTRAINT work_session_event_pkey PRIMARY KEY (work_session_event_id);


--
-- Name: work_session work_session_pkey; Type: CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.work_session
    ADD CONSTRAINT work_session_pkey PRIMARY KEY (work_session_id);


--
-- Name: work_session_worker work_session_worker_pkey; Type: CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.work_session_worker
    ADD CONSTRAINT work_session_worker_pkey PRIMARY KEY (work_session_worker_id);


--
-- Name: cause_code cause_code_cause_code_key; Type: CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.cause_code
    ADD CONSTRAINT cause_code_cause_code_key UNIQUE (cause_code);


--
-- Name: cause_code cause_code_pkey; Type: CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.cause_code
    ADD CONSTRAINT cause_code_pkey PRIMARY KEY (cause_code_id);


--
-- Name: concession concession_concession_no_key; Type: CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.concession
    ADD CONSTRAINT concession_concession_no_key UNIQUE (concession_no);


--
-- Name: concession concession_pkey; Type: CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.concession
    ADD CONSTRAINT concession_pkey PRIMARY KEY (concession_id);


--
-- Name: defect_code defect_code_defect_code_key; Type: CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.defect_code
    ADD CONSTRAINT defect_code_defect_code_key UNIQUE (defect_code);


--
-- Name: defect_code defect_code_pkey; Type: CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.defect_code
    ADD CONSTRAINT defect_code_pkey PRIMARY KEY (defect_code_id);


--
-- Name: defect_code_process defect_code_process_pkey; Type: CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.defect_code_process
    ADD CONSTRAINT defect_code_process_pkey PRIMARY KEY (defect_code_process_id);


--
-- Name: defect_record defect_record_pkey; Type: CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.defect_record
    ADD CONSTRAINT defect_record_pkey PRIMARY KEY (defect_record_id);


--
-- Name: disposition_decision disposition_decision_pkey; Type: CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.disposition_decision
    ADD CONSTRAINT disposition_decision_pkey PRIMARY KEY (disposition_decision_id);


--
-- Name: equipment_calibration equipment_calibration_pkey; Type: CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.equipment_calibration
    ADD CONSTRAINT equipment_calibration_pkey PRIMARY KEY (equipment_calibration_id);


--
-- Name: inspection_item_spec inspection_item_spec_pkey; Type: CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.inspection_item_spec
    ADD CONSTRAINT inspection_item_spec_pkey PRIMARY KEY (inspection_item_spec_id);


--
-- Name: inspection_measurement inspection_measurement_pkey; Type: CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.inspection_measurement
    ADD CONSTRAINT inspection_measurement_pkey PRIMARY KEY (inspection_measurement_id);


--
-- Name: inspection_plan inspection_plan_inspection_plan_code_key; Type: CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.inspection_plan
    ADD CONSTRAINT inspection_plan_inspection_plan_code_key UNIQUE (inspection_plan_code);


--
-- Name: inspection_plan inspection_plan_pkey; Type: CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.inspection_plan
    ADD CONSTRAINT inspection_plan_pkey PRIMARY KEY (inspection_plan_id);


--
-- Name: inspection_plan_version inspection_plan_version_pkey; Type: CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.inspection_plan_version
    ADD CONSTRAINT inspection_plan_version_pkey PRIMARY KEY (inspection_plan_version_id);


--
-- Name: inspection_request inspection_request_inspection_request_no_key; Type: CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.inspection_request
    ADD CONSTRAINT inspection_request_inspection_request_no_key UNIQUE (inspection_request_no);


--
-- Name: inspection_request inspection_request_pkey; Type: CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.inspection_request
    ADD CONSTRAINT inspection_request_pkey PRIMARY KEY (inspection_request_id);


--
-- Name: inspection_result inspection_result_idempotency_key_key; Type: CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.inspection_result
    ADD CONSTRAINT inspection_result_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: inspection_result inspection_result_inspection_result_no_key; Type: CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.inspection_result
    ADD CONSTRAINT inspection_result_inspection_result_no_key UNIQUE (inspection_result_no);


--
-- Name: inspection_result inspection_result_pkey; Type: CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.inspection_result
    ADD CONSTRAINT inspection_result_pkey PRIMARY KEY (inspection_result_id);


--
-- Name: nonconformance_lot nonconformance_lot_pkey; Type: CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.nonconformance_lot
    ADD CONSTRAINT nonconformance_lot_pkey PRIMARY KEY (nonconformance_lot_id);


--
-- Name: nonconformance nonconformance_nonconformance_no_key; Type: CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.nonconformance
    ADD CONSTRAINT nonconformance_nonconformance_no_key UNIQUE (nonconformance_no);


--
-- Name: nonconformance nonconformance_pkey; Type: CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.nonconformance
    ADD CONSTRAINT nonconformance_pkey PRIMARY KEY (nonconformance_id);


--
-- Name: repair_result repair_result_pkey; Type: CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.repair_result
    ADD CONSTRAINT repair_result_pkey PRIMARY KEY (repair_result_id);


--
-- Name: repair_result repair_result_repair_result_no_key; Type: CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.repair_result
    ADD CONSTRAINT repair_result_repair_result_no_key UNIQUE (repair_result_no);


--
-- Name: sorting_result sorting_result_pkey; Type: CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.sorting_result
    ADD CONSTRAINT sorting_result_pkey PRIMARY KEY (sorting_result_id);


--
-- Name: defect_code_process uq_defect_code_process; Type: CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.defect_code_process
    ADD CONSTRAINT uq_defect_code_process UNIQUE (defect_code_id, process_id);


--
-- Name: equipment_calibration uq_equipment_calibration; Type: CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.equipment_calibration
    ADD CONSTRAINT uq_equipment_calibration UNIQUE (equipment_id, calibration_date);


--
-- Name: inspection_item_spec uq_inspection_item_spec; Type: CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.inspection_item_spec
    ADD CONSTRAINT uq_inspection_item_spec UNIQUE (inspection_plan_version_id, sequence_no);


--
-- Name: inspection_measurement uq_inspection_measurement; Type: CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.inspection_measurement
    ADD CONSTRAINT uq_inspection_measurement UNIQUE (inspection_result_id, inspection_item_spec_id, sample_no);


--
-- Name: inspection_plan_version uq_inspection_plan_version; Type: CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.inspection_plan_version
    ADD CONSTRAINT uq_inspection_plan_version UNIQUE (inspection_plan_id, plan_version);


--
-- Name: inspection_result uq_inspection_round; Type: CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.inspection_result
    ADD CONSTRAINT uq_inspection_round UNIQUE (inspection_request_id, inspection_round);


--
-- Name: nonconformance_lot uq_nonconformance_lot; Type: CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.nonconformance_lot
    ADD CONSTRAINT uq_nonconformance_lot UNIQUE (nonconformance_id, lot_id);


--
-- Name: impact_analysis impact_analysis_analysis_no_key; Type: CONSTRAINT; Schema: trace; Owner: -
--

ALTER TABLE ONLY trace.impact_analysis
    ADD CONSTRAINT impact_analysis_analysis_no_key UNIQUE (analysis_no);


--
-- Name: impact_analysis impact_analysis_pkey; Type: CONSTRAINT; Schema: trace; Owner: -
--

ALTER TABLE ONLY trace.impact_analysis
    ADD CONSTRAINT impact_analysis_pkey PRIMARY KEY (impact_analysis_id);


--
-- Name: lot_external_identifier lot_external_identifier_pkey; Type: CONSTRAINT; Schema: trace; Owner: -
--

ALTER TABLE ONLY trace.lot_external_identifier
    ADD CONSTRAINT lot_external_identifier_pkey PRIMARY KEY (lot_external_identifier_id);


--
-- Name: lot_hold lot_hold_pkey; Type: CONSTRAINT; Schema: trace; Owner: -
--

ALTER TABLE ONLY trace.lot_hold
    ADD CONSTRAINT lot_hold_pkey PRIMARY KEY (lot_hold_id);


--
-- Name: lot lot_pkey; Type: CONSTRAINT; Schema: trace; Owner: -
--

ALTER TABLE ONLY trace.lot
    ADD CONSTRAINT lot_pkey PRIMARY KEY (lot_id);


--
-- Name: lot_relation lot_relation_pkey; Type: CONSTRAINT; Schema: trace; Owner: -
--

ALTER TABLE ONLY trace.lot_relation
    ADD CONSTRAINT lot_relation_pkey PRIMARY KEY (lot_relation_id);


--
-- Name: lot_status_event lot_status_event_pkey; Type: CONSTRAINT; Schema: trace; Owner: -
--

ALTER TABLE ONLY trace.lot_status_event
    ADD CONSTRAINT lot_status_event_pkey PRIMARY KEY (lot_status_event_id);


--
-- Name: serial_component_relation serial_component_relation_pkey; Type: CONSTRAINT; Schema: trace; Owner: -
--

ALTER TABLE ONLY trace.serial_component_relation
    ADD CONSTRAINT serial_component_relation_pkey PRIMARY KEY (serial_component_relation_id);


--
-- Name: serial_number serial_number_pkey; Type: CONSTRAINT; Schema: trace; Owner: -
--

ALTER TABLE ONLY trace.serial_number
    ADD CONSTRAINT serial_number_pkey PRIMARY KEY (serial_number_id);


--
-- Name: serial_number serial_number_serial_no_key; Type: CONSTRAINT; Schema: trace; Owner: -
--

ALTER TABLE ONLY trace.serial_number
    ADD CONSTRAINT serial_number_serial_no_key UNIQUE (serial_no);


--
-- Name: lot uq_lot; Type: CONSTRAINT; Schema: trace; Owner: -
--

ALTER TABLE ONLY trace.lot
    ADD CONSTRAINT uq_lot UNIQUE (plant_id, lot_no);


--
-- Name: lot_relation uq_lot_relation; Type: CONSTRAINT; Schema: trace; Owner: -
--

ALTER TABLE ONLY trace.lot_relation
    ADD CONSTRAINT uq_lot_relation UNIQUE (source_lot_id, target_lot_id, relation_type_code, source_event_type_code, source_event_id);


--
-- Name: serial_component_relation uq_serial_component; Type: CONSTRAINT; Schema: trace; Owner: -
--

ALTER TABLE ONLY trace.serial_component_relation
    ADD CONSTRAINT uq_serial_component UNIQUE (parent_serial_number_id, component_serial_number_id);


--
-- Name: ix_app_user_department; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ix_app_user_department ON app.app_user USING btree (department_id);


--
-- Name: ix_approval_route_step_approver_department; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ix_approval_route_step_approver_department ON app.approval_route_step USING btree (approver_department_id);


--
-- Name: ix_document_cancellation_target; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ix_document_cancellation_target ON app.document_cancellation USING btree (document_type_code, document_id, cancelled_at DESC);


--
-- Name: ix_document_issue_lot; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ix_document_issue_lot ON app.document_issue_log USING btree (lot_id) WHERE (lot_id IS NOT NULL);


--
-- Name: ix_document_issue_target; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ix_document_issue_target ON app.document_issue_log USING btree (target_type_code, target_id, issued_at DESC);


--
-- Name: ix_exception_case_assigned_department; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ix_exception_case_assigned_department ON app.exception_case USING btree (assigned_department_id);


--
-- Name: ix_exception_open; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ix_exception_open ON app.exception_case USING btree (severity_code, due_at, created_at) WHERE ((status_code)::text <> ALL ((ARRAY['RESOLVED'::character varying, 'CLOSED'::character varying, 'CANCELLED'::character varying])::text[]));


--
-- Name: ix_idempotency_expires; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ix_idempotency_expires ON app.idempotency_record USING btree (expires_at);


--
-- Name: ix_notification_unread; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ix_notification_unread ON app.notification USING btree (recipient_user_id, created_at DESC) WHERE (read_at IS NULL);


--
-- Name: ix_user_data_scope_legal_entity; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ix_user_data_scope_legal_entity ON app.user_data_scope USING btree (legal_entity_id);


--
-- Name: uq_numbering_rule; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX uq_numbering_rule ON app.numbering_rule USING btree (document_type_code, COALESCE(plant_id, (0)::bigint), COALESCE((lot_type_code)::character varying, ''::character varying));


--
-- Name: uq_operation_policy; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX uq_operation_policy ON app.operation_policy USING btree (policy_code, COALESCE(business_unit_id, (0)::bigint), COALESCE(plant_id, (0)::bigint), COALESCE(item_id, (0)::bigint), COALESCE(process_id, (0)::bigint), effective_from);


--
-- Name: uq_user_data_scope; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX uq_user_data_scope ON app.user_data_scope USING btree (app_user_id, COALESCE(legal_entity_id, (0)::bigint), COALESCE(business_unit_id, (0)::bigint), COALESCE(plant_id, (0)::bigint));


--
-- Name: uq_worker_lease_active; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX uq_worker_lease_active ON app.worker_lease USING btree (resource_type_code, resource_id) WHERE (released_at IS NULL);


--
-- Name: ix_audit_target; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX ix_audit_target ON ONLY audit.audit_event USING btree (target_type_code, target_id, occurred_at DESC);


--
-- Name: audit_event_default_target_type_code_target_id_occurred_at_idx; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX audit_event_default_target_type_code_target_id_occurred_at_idx ON audit.audit_event_default USING btree (target_type_code, target_id, occurred_at DESC);


--
-- Name: ix_integration_pending; Type: INDEX; Schema: integration; Owner: -
--

CREATE INDEX ix_integration_pending ON integration.integration_message USING btree (available_at, created_at) WHERE ((status_code)::text = ANY ((ARRAY['PENDING'::character varying, 'RETRY'::character varying])::text[]));


--
-- Name: ix_integration_target; Type: INDEX; Schema: integration; Owner: -
--

CREATE INDEX ix_integration_target ON integration.integration_message USING btree (target_type_code, target_id, created_at DESC);


--
-- Name: ix_record_provenance_message; Type: INDEX; Schema: integration; Owner: -
--

CREATE INDEX ix_record_provenance_message ON integration.record_provenance USING btree (integration_message_id);


--
-- Name: uq_external_document_reference; Type: INDEX; Schema: integration; Owner: -
--

CREATE UNIQUE INDEX uq_external_document_reference ON integration.external_document_reference USING btree (target_type_code, target_id, external_system_code, external_document_type_code, external_document_no);


--
-- Name: ix_inventory_transaction_occurred_brin; Type: INDEX; Schema: inventory; Owner: -
--

CREATE INDEX ix_inventory_transaction_occurred_brin ON ONLY inventory.inventory_transaction USING brin (occurred_at);


--
-- Name: inventory_transaction_default_occurred_at_idx; Type: INDEX; Schema: inventory; Owner: -
--

CREATE INDEX inventory_transaction_default_occurred_at_idx ON inventory.inventory_transaction_default USING brin (occurred_at);


--
-- Name: ix_inventory_transaction_source; Type: INDEX; Schema: inventory; Owner: -
--

CREATE INDEX ix_inventory_transaction_source ON ONLY inventory.inventory_transaction USING btree (source_document_type_code, source_document_id, business_date DESC);


--
-- Name: inventory_transaction_default_source_document_type_code_sou_idx; Type: INDEX; Schema: inventory; Owner: -
--

CREATE INDEX inventory_transaction_default_source_document_type_code_sou_idx ON inventory.inventory_transaction_default USING btree (source_document_type_code, source_document_id, business_date DESC);


--
-- Name: ix_handling_unit_location; Type: INDEX; Schema: inventory; Owner: -
--

CREATE INDEX ix_handling_unit_location ON inventory.handling_unit USING btree (location_id);


--
-- Name: ix_handling_unit_warehouse; Type: INDEX; Schema: inventory; Owner: -
--

CREATE INDEX ix_handling_unit_warehouse ON inventory.handling_unit USING btree (warehouse_id);


--
-- Name: ix_inventory_adjustment_line_header; Type: INDEX; Schema: inventory; Owner: -
--

CREATE INDEX ix_inventory_adjustment_line_header ON inventory.inventory_adjustment_line USING btree (inventory_adjustment_id);


--
-- Name: ix_inventory_available; Type: INDEX; Schema: inventory; Owner: -
--

CREATE INDEX ix_inventory_available ON inventory.inventory_balance USING btree (warehouse_id, item_id, available_qty DESC) WHERE ((available_qty > (0)::numeric) AND ((inventory_status_code)::text = 'AVAILABLE'::text));


--
-- Name: ix_inventory_balance_location; Type: INDEX; Schema: inventory; Owner: -
--

CREATE INDEX ix_inventory_balance_location ON inventory.inventory_balance USING btree (location_id);


--
-- Name: ix_inventory_balance_lookup; Type: INDEX; Schema: inventory; Owner: -
--

CREATE INDEX ix_inventory_balance_lookup ON inventory.inventory_balance USING btree (plant_id, warehouse_id, item_id, lot_id, quality_status_code, inventory_status_code);


--
-- Name: ix_inventory_balance_warehouse; Type: INDEX; Schema: inventory; Owner: -
--

CREATE INDEX ix_inventory_balance_warehouse ON inventory.inventory_balance USING btree (warehouse_id);


--
-- Name: ix_inventory_count_line_location; Type: INDEX; Schema: inventory; Owner: -
--

CREATE INDEX ix_inventory_count_line_location ON inventory.inventory_count_line USING btree (location_id);


--
-- Name: ix_inventory_count_warehouse; Type: INDEX; Schema: inventory; Owner: -
--

CREATE INDEX ix_inventory_count_warehouse ON inventory.inventory_count USING btree (warehouse_id);


--
-- Name: ix_inventory_line_from_location; Type: INDEX; Schema: inventory; Owner: -
--

CREATE INDEX ix_inventory_line_from_location ON inventory.inventory_transaction_line USING btree (from_location_id);


--
-- Name: ix_inventory_line_from_warehouse; Type: INDEX; Schema: inventory; Owner: -
--

CREATE INDEX ix_inventory_line_from_warehouse ON inventory.inventory_transaction_line USING btree (from_warehouse_id);


--
-- Name: ix_inventory_line_lot; Type: INDEX; Schema: inventory; Owner: -
--

CREATE INDEX ix_inventory_line_lot ON inventory.inventory_transaction_line USING btree (lot_id, business_date DESC);


--
-- Name: ix_inventory_line_to_location; Type: INDEX; Schema: inventory; Owner: -
--

CREATE INDEX ix_inventory_line_to_location ON inventory.inventory_transaction_line USING btree (to_location_id);


--
-- Name: ix_inventory_line_to_warehouse; Type: INDEX; Schema: inventory; Owner: -
--

CREATE INDEX ix_inventory_line_to_warehouse ON inventory.inventory_transaction_line USING btree (to_warehouse_id);


--
-- Name: ix_inventory_reservation_location; Type: INDEX; Schema: inventory; Owner: -
--

CREATE INDEX ix_inventory_reservation_location ON inventory.inventory_reservation USING btree (location_id);


--
-- Name: ix_inventory_reservation_warehouse; Type: INDEX; Schema: inventory; Owner: -
--

CREATE INDEX ix_inventory_reservation_warehouse ON inventory.inventory_reservation USING btree (warehouse_id);


--
-- Name: ix_reservation_source; Type: INDEX; Schema: inventory; Owner: -
--

CREATE INDEX ix_reservation_source ON inventory.inventory_reservation USING btree (source_document_type_code, source_document_id, status_code);


--
-- Name: uq_inventory_balance_dim; Type: INDEX; Schema: inventory; Owner: -
--

CREATE UNIQUE INDEX uq_inventory_balance_dim ON inventory.inventory_balance USING btree (legal_entity_id, business_unit_id, plant_id, warehouse_id, location_id, item_id, COALESCE(lot_id, (0)::bigint), quality_status_code, inventory_status_code, ownership_type_code, COALESCE(owner_partner_id, (0)::bigint));


--
-- Name: ix_asn_expected; Type: INDEX; Schema: logistics; Owner: -
--

CREATE INDEX ix_asn_expected ON logistics.asn USING btree (plant_id, expected_arrival_date, status_code);


--
-- Name: ix_goods_issue_approval_request; Type: INDEX; Schema: logistics; Owner: -
--

CREATE INDEX ix_goods_issue_approval_request ON logistics.goods_issue USING btree (approval_request_id);


--
-- Name: ix_goods_issue_line_source_location; Type: INDEX; Schema: logistics; Owner: -
--

CREATE INDEX ix_goods_issue_line_source_location ON logistics.goods_issue_line USING btree (source_location_id);


--
-- Name: ix_goods_issue_source; Type: INDEX; Schema: logistics; Owner: -
--

CREATE INDEX ix_goods_issue_source ON logistics.goods_issue USING btree (source_document_type_code, source_document_id, issued_at DESC);


--
-- Name: ix_goods_issue_source_warehouse; Type: INDEX; Schema: logistics; Owner: -
--

CREATE INDEX ix_goods_issue_source_warehouse ON logistics.goods_issue USING btree (source_warehouse_id);


--
-- Name: ix_goods_receipt_line_destination_location; Type: INDEX; Schema: logistics; Owner: -
--

CREATE INDEX ix_goods_receipt_line_destination_location ON logistics.goods_receipt_line USING btree (destination_location_id);


--
-- Name: ix_goods_receipt_warehouse; Type: INDEX; Schema: logistics; Owner: -
--

CREATE INDEX ix_goods_receipt_warehouse ON logistics.goods_receipt USING btree (warehouse_id);


--
-- Name: ix_inbound_line_po; Type: INDEX; Schema: logistics; Owner: -
--

CREATE INDEX ix_inbound_line_po ON logistics.inbound_receipt_line USING btree (purchase_order_line_id);


--
-- Name: ix_inbound_receipt_dock_location; Type: INDEX; Schema: logistics; Owner: -
--

CREATE INDEX ix_inbound_receipt_dock_location ON logistics.inbound_receipt USING btree (dock_location_id);


--
-- Name: ix_inbound_receipt_supplier_date; Type: INDEX; Schema: logistics; Owner: -
--

CREATE INDEX ix_inbound_receipt_supplier_date ON logistics.inbound_receipt USING btree (supplier_id, receipt_datetime DESC);


--
-- Name: ix_material_issue_request_destination_location; Type: INDEX; Schema: logistics; Owner: -
--

CREATE INDEX ix_material_issue_request_destination_location ON logistics.material_issue_request USING btree (destination_location_id);


--
-- Name: ix_picking_line_location; Type: INDEX; Schema: logistics; Owner: -
--

CREATE INDEX ix_picking_line_location ON logistics.picking_line USING btree (location_id);


--
-- Name: ix_picking_open; Type: INDEX; Schema: logistics; Owner: -
--

CREATE INDEX ix_picking_open ON logistics.picking_order USING btree (warehouse_id, status_code, created_at) WHERE ((status_code)::text = ANY ((ARRAY['CREATED'::character varying, 'ASSIGNED'::character varying, 'PICKING'::character varying])::text[]));


--
-- Name: ix_picking_order_warehouse; Type: INDEX; Schema: logistics; Owner: -
--

CREATE INDEX ix_picking_order_warehouse ON logistics.picking_order USING btree (warehouse_id);


--
-- Name: ix_putaway_open; Type: INDEX; Schema: logistics; Owner: -
--

CREATE INDEX ix_putaway_open ON logistics.putaway_task USING btree (status_code, priority_no) WHERE (completed_at IS NULL);


--
-- Name: ix_putaway_receipt_line; Type: INDEX; Schema: logistics; Owner: -
--

CREATE INDEX ix_putaway_receipt_line ON logistics.putaway_task USING btree (goods_receipt_line_id);


--
-- Name: ix_putaway_rule_location; Type: INDEX; Schema: logistics; Owner: -
--

CREATE INDEX ix_putaway_rule_location ON logistics.putaway_rule USING btree (location_id);


--
-- Name: ix_putaway_rule_warehouse; Type: INDEX; Schema: logistics; Owner: -
--

CREATE INDEX ix_putaway_rule_warehouse ON logistics.putaway_rule USING btree (warehouse_id);


--
-- Name: ix_putaway_task_actual_location; Type: INDEX; Schema: logistics; Owner: -
--

CREATE INDEX ix_putaway_task_actual_location ON logistics.putaway_task USING btree (actual_location_id);


--
-- Name: ix_putaway_task_from_location; Type: INDEX; Schema: logistics; Owner: -
--

CREATE INDEX ix_putaway_task_from_location ON logistics.putaway_task USING btree (from_location_id);


--
-- Name: ix_putaway_task_recommended_location; Type: INDEX; Schema: logistics; Owner: -
--

CREATE INDEX ix_putaway_task_recommended_location ON logistics.putaway_task USING btree (recommended_location_id);


--
-- Name: ix_recycle_entry_source; Type: INDEX; Schema: logistics; Owner: -
--

CREATE INDEX ix_recycle_entry_source ON logistics.recycle_entry USING btree (source_document_type_code, source_document_id);


--
-- Name: ix_shipment_customer_date; Type: INDEX; Schema: logistics; Owner: -
--

CREATE INDEX ix_shipment_customer_date ON logistics.shipment_request USING btree (customer_id, requested_ship_date, status_code);


--
-- Name: ix_shipment_lot; Type: INDEX; Schema: logistics; Owner: -
--

CREATE INDEX ix_shipment_lot ON logistics.shipment_lot_allocation USING btree (lot_id, shipment_line_id);


--
-- Name: ix_shipment_warehouse; Type: INDEX; Schema: logistics; Owner: -
--

CREATE INDEX ix_shipment_warehouse ON logistics.shipment USING btree (warehouse_id);


--
-- Name: ix_shopfloor_receipt_destination_location; Type: INDEX; Schema: logistics; Owner: -
--

CREATE INDEX ix_shopfloor_receipt_destination_location ON logistics.shopfloor_receipt USING btree (destination_location_id);


--
-- Name: ix_stock_transfer_from_warehouse; Type: INDEX; Schema: logistics; Owner: -
--

CREATE INDEX ix_stock_transfer_from_warehouse ON logistics.stock_transfer USING btree (from_warehouse_id);


--
-- Name: ix_stock_transfer_line_from_location; Type: INDEX; Schema: logistics; Owner: -
--

CREATE INDEX ix_stock_transfer_line_from_location ON logistics.stock_transfer_line USING btree (from_location_id);


--
-- Name: ix_stock_transfer_line_to_location; Type: INDEX; Schema: logistics; Owner: -
--

CREATE INDEX ix_stock_transfer_line_to_location ON logistics.stock_transfer_line USING btree (to_location_id);


--
-- Name: ix_stock_transfer_to_warehouse; Type: INDEX; Schema: logistics; Owner: -
--

CREATE INDEX ix_stock_transfer_to_warehouse ON logistics.stock_transfer USING btree (to_warehouse_id);


--
-- Name: ix_subcontract_reconciliation_order; Type: INDEX; Schema: logistics; Owner: -
--

CREATE INDEX ix_subcontract_reconciliation_order ON logistics.subcontract_reconciliation USING btree (subcontract_order_id, settlement_seq DESC);


--
-- Name: uq_putaway_rule; Type: INDEX; Schema: logistics; Owner: -
--

CREATE UNIQUE INDEX uq_putaway_rule ON logistics.putaway_rule USING btree (item_id, warehouse_id, COALESCE(location_id, (0)::bigint));


--
-- Name: uq_shipment_lot_allocation; Type: INDEX; Schema: logistics; Owner: -
--

CREATE UNIQUE INDEX uq_shipment_lot_allocation ON logistics.shipment_lot_allocation USING btree (shipment_line_id, lot_id, COALESCE(handling_unit_id, (0)::bigint));


--
-- Name: ix_collection_observation_channel_time; Type: INDEX; Schema: maintenance; Owner: -
--

CREATE INDEX ix_collection_observation_channel_time ON maintenance.collection_observation USING btree (collection_channel_id, observed_at DESC);


--
-- Name: ix_equipment_downtime_open; Type: INDEX; Schema: maintenance; Owner: -
--

CREATE INDEX ix_equipment_downtime_open ON maintenance.equipment_downtime USING btree (equipment_id, started_at DESC) WHERE (ended_at IS NULL);


--
-- Name: ix_department_parent; Type: INDEX; Schema: mdm; Owner: -
--

CREATE INDEX ix_department_parent ON mdm.department USING btree (parent_department_id);


--
-- Name: ix_equipment_location; Type: INDEX; Schema: mdm; Owner: -
--

CREATE INDEX ix_equipment_location ON mdm.equipment USING btree (location_id);


--
-- Name: ix_item_bu_item_map_from_item; Type: INDEX; Schema: mdm; Owner: -
--

CREATE INDEX ix_item_bu_item_map_from_item ON mdm.item_bu_item_map USING btree (from_item_id);


--
-- Name: ix_item_type; Type: INDEX; Schema: mdm; Owner: -
--

CREATE INDEX ix_item_type ON mdm.item USING btree (item_type_code, is_active);


--
-- Name: ix_location_parent; Type: INDEX; Schema: mdm; Owner: -
--

CREATE INDEX ix_location_parent ON mdm.location USING btree (parent_location_id);


--
-- Name: ix_terminal_location; Type: INDEX; Schema: mdm; Owner: -
--

CREATE INDEX ix_terminal_location ON mdm.terminal USING btree (location_id);


--
-- Name: ix_worker_department; Type: INDEX; Schema: mdm; Owner: -
--

CREATE INDEX ix_worker_department ON mdm.worker USING btree (department_id);


--
-- Name: ix_worker_qualification_worker; Type: INDEX; Schema: mdm; Owner: -
--

CREATE INDEX ix_worker_qualification_worker ON mdm.worker_qualification USING btree (worker_id, qualification_type_code);


--
-- Name: uq_item_external_code; Type: INDEX; Schema: mdm; Owner: -
--

CREATE UNIQUE INDEX uq_item_external_code ON mdm.item_external_code USING btree (item_id, external_system_code, COALESCE(partner_id, (0)::bigint), external_item_code);


--
-- Name: uq_warehouse_layout_active; Type: INDEX; Schema: mdm; Owner: -
--

CREATE UNIQUE INDEX uq_warehouse_layout_active ON mdm.warehouse_layout USING btree (warehouse_id) WHERE ((status_code)::text = 'ACTIVE'::text);


--
-- Name: uq_worker_qualification; Type: INDEX; Schema: mdm; Owner: -
--

CREATE UNIQUE INDEX uq_worker_qualification ON mdm.worker_qualification USING btree (worker_id, qualification_type_code, COALESCE(process_id, (0)::bigint), valid_from);


--
-- Name: ix_bom_parent_status; Type: INDEX; Schema: planning; Owner: -
--

CREATE INDEX ix_bom_parent_status ON planning.bom USING btree (parent_item_id, status_code, effective_from DESC);


--
-- Name: ix_routing_item_status; Type: INDEX; Schema: planning; Owner: -
--

CREATE INDEX ix_routing_item_status ON planning.routing USING btree (item_id, status_code, effective_from DESC);


--
-- Name: uq_bom_default; Type: INDEX; Schema: planning; Owner: -
--

CREATE UNIQUE INDEX uq_bom_default ON planning.bom USING btree (parent_item_id) WHERE is_default;


--
-- Name: uq_routing_default; Type: INDEX; Schema: planning; Owner: -
--

CREATE UNIQUE INDEX uq_routing_default ON planning.routing USING btree (item_id) WHERE (is_default AND ((status_code)::text = 'ACTIVE'::text));


--
-- Name: ix_material_consumption_lot; Type: INDEX; Schema: production; Owner: -
--

CREATE INDEX ix_material_consumption_lot ON production.material_consumption USING btree (lot_id, occurred_at DESC);


--
-- Name: ix_material_consumption_work_order; Type: INDEX; Schema: production; Owner: -
--

CREATE INDEX ix_material_consumption_work_order ON production.material_consumption USING btree (work_order_id, occurred_at DESC);


--
-- Name: ix_material_return_destination_warehouse; Type: INDEX; Schema: production; Owner: -
--

CREATE INDEX ix_material_return_destination_warehouse ON production.material_return USING btree (destination_warehouse_id);


--
-- Name: ix_material_return_source_location; Type: INDEX; Schema: production; Owner: -
--

CREATE INDEX ix_material_return_source_location ON production.material_return USING btree (source_location_id);


--
-- Name: ix_material_usage_output_lot; Type: INDEX; Schema: production; Owner: -
--

CREATE INDEX ix_material_usage_output_lot ON production.material_usage_allocation USING btree (output_lot_id) WHERE (output_lot_id IS NOT NULL);


--
-- Name: ix_operation_handover_line_destination_location; Type: INDEX; Schema: production; Owner: -
--

CREATE INDEX ix_operation_handover_line_destination_location ON production.operation_handover_line USING btree (destination_location_id);


--
-- Name: ix_operation_handover_line_source_location; Type: INDEX; Schema: production; Owner: -
--

CREATE INDEX ix_operation_handover_line_source_location ON production.operation_handover_line USING btree (source_location_id);


--
-- Name: ix_production_result_lot; Type: INDEX; Schema: production; Owner: -
--

CREATE INDEX ix_production_result_lot ON production.production_result_lot_allocation USING btree (lot_id, production_result_id);


--
-- Name: ix_production_result_work_order; Type: INDEX; Schema: production; Owner: -
--

CREATE INDEX ix_production_result_work_order ON production.production_result USING btree (work_order_id, occurred_at DESC);


--
-- Name: ix_work_order_default_fg_location; Type: INDEX; Schema: production; Owner: -
--

CREATE INDEX ix_work_order_default_fg_location ON production.work_order USING btree (default_fg_location_id);


--
-- Name: ix_work_order_default_scrap_location; Type: INDEX; Schema: production; Owner: -
--

CREATE INDEX ix_work_order_default_scrap_location ON production.work_order USING btree (default_scrap_location_id);


--
-- Name: ix_work_order_default_wip_location; Type: INDEX; Schema: production; Owner: -
--

CREATE INDEX ix_work_order_default_wip_location ON production.work_order USING btree (default_wip_location_id);


--
-- Name: ix_work_order_dispatch; Type: INDEX; Schema: production; Owner: -
--

CREATE INDEX ix_work_order_dispatch ON production.work_order USING btree (status_code, planned_start_at, priority_no) WHERE ((status_code)::text = ANY ((ARRAY['RELEASED'::character varying, 'WAITING'::character varying, 'IN_PROGRESS'::character varying, 'PAUSED'::character varying, 'ON_HOLD'::character varying])::text[]));


--
-- Name: ix_work_order_line; Type: INDEX; Schema: production; Owner: -
--

CREATE INDEX ix_work_order_line ON production.work_order USING btree (production_line_id) WHERE (production_line_id IS NOT NULL);


--
-- Name: ix_work_order_parent; Type: INDEX; Schema: production; Owner: -
--

CREATE INDEX ix_work_order_parent ON production.work_order USING btree (parent_work_order_id) WHERE (parent_work_order_id IS NOT NULL);


--
-- Name: ix_work_order_plan; Type: INDEX; Schema: production; Owner: -
--

CREATE INDEX ix_work_order_plan ON production.work_order USING btree (production_plan_id, routing_operation_id);


--
-- Name: ix_work_order_resource_assignment; Type: INDEX; Schema: production; Owner: -
--

CREATE INDEX ix_work_order_resource_assignment ON production.work_order_resource_assignment USING btree (work_order_id, resource_type_code);


--
-- Name: ix_work_order_rework_source; Type: INDEX; Schema: production; Owner: -
--

CREATE INDEX ix_work_order_rework_source ON production.work_order USING btree (rework_source_work_order_id) WHERE (rework_source_work_order_id IS NOT NULL);


--
-- Name: ix_work_session_open; Type: INDEX; Schema: production; Owner: -
--

CREATE INDEX ix_work_session_open ON production.work_session USING btree (work_order_id, started_at DESC) WHERE (ended_at IS NULL);


--
-- Name: ix_concession_lot; Type: INDEX; Schema: quality; Owner: -
--

CREATE INDEX ix_concession_lot ON quality.concession USING btree (lot_id, status_code);


--
-- Name: ix_defect_record_responsible_department; Type: INDEX; Schema: quality; Owner: -
--

CREATE INDEX ix_defect_record_responsible_department ON quality.defect_record USING btree (responsible_department_id);


--
-- Name: ix_equipment_calibration_history; Type: INDEX; Schema: quality; Owner: -
--

CREATE INDEX ix_equipment_calibration_history ON quality.equipment_calibration USING btree (equipment_id, calibration_date DESC);


--
-- Name: ix_inspection_request_lot; Type: INDEX; Schema: quality; Owner: -
--

CREATE INDEX ix_inspection_request_lot ON quality.inspection_request USING btree (lot_id, requested_at DESC) WHERE (lot_id IS NOT NULL);


--
-- Name: ix_inspection_request_open; Type: INDEX; Schema: quality; Owner: -
--

CREATE INDEX ix_inspection_request_open ON quality.inspection_request USING btree (status_code, requested_at) WHERE ((status_code)::text = ANY ((ARRAY['REQUESTED'::character varying, 'IN_PROGRESS'::character varying, 'PENDING_CONFIRMATION'::character varying])::text[]));


--
-- Name: ix_nonconformance_open; Type: INDEX; Schema: quality; Owner: -
--

CREATE INDEX ix_nonconformance_open ON quality.nonconformance USING btree (status_code, severity_code, opened_at) WHERE (closed_at IS NULL);


--
-- Name: ix_nonconformance_responsible_department; Type: INDEX; Schema: quality; Owner: -
--

CREATE INDEX ix_nonconformance_responsible_department ON quality.nonconformance USING btree (responsible_department_id);


--
-- Name: ix_repair_result_defect; Type: INDEX; Schema: quality; Owner: -
--

CREATE INDEX ix_repair_result_defect ON quality.repair_result USING btree (defect_record_id);


--
-- Name: uq_defect_code_primary_process; Type: INDEX; Schema: quality; Owner: -
--

CREATE UNIQUE INDEX uq_defect_code_primary_process ON quality.defect_code_process USING btree (defect_code_id) WHERE is_primary;


--
-- Name: ix_impact_analysis_lot; Type: INDEX; Schema: trace; Owner: -
--

CREATE INDEX ix_impact_analysis_lot ON trace.impact_analysis USING btree (source_lot_id, analyzed_at DESC);


--
-- Name: ix_lot_bom; Type: INDEX; Schema: trace; Owner: -
--

CREATE INDEX ix_lot_bom ON trace.lot USING btree (bom_id);


--
-- Name: ix_lot_expiry; Type: INDEX; Schema: trace; Owner: -
--

CREATE INDEX ix_lot_expiry ON trace.lot USING btree (expiry_date) WHERE ((expiry_date IS NOT NULL) AND ((status_code)::text = 'ACTIVE'::text));


--
-- Name: ix_lot_hold_active; Type: INDEX; Schema: trace; Owner: -
--

CREATE INDEX ix_lot_hold_active ON trace.lot_hold USING btree (lot_id) WHERE (released_at IS NULL);


--
-- Name: ix_lot_item; Type: INDEX; Schema: trace; Owner: -
--

CREATE INDEX ix_lot_item ON trace.lot USING btree (item_id, created_at DESC);


--
-- Name: ix_lot_relation_source; Type: INDEX; Schema: trace; Owner: -
--

CREATE INDEX ix_lot_relation_source ON trace.lot_relation USING btree (source_lot_id, occurred_at);


--
-- Name: ix_lot_relation_target; Type: INDEX; Schema: trace; Owner: -
--

CREATE INDEX ix_lot_relation_target ON trace.lot_relation USING btree (target_lot_id, occurred_at);


--
-- Name: ix_lot_status_event_lot; Type: INDEX; Schema: trace; Owner: -
--

CREATE INDEX ix_lot_status_event_lot ON trace.lot_status_event USING btree (lot_id, changed_at DESC);


--
-- Name: uq_lot_external_identifier; Type: INDEX; Schema: trace; Owner: -
--

CREATE UNIQUE INDEX uq_lot_external_identifier ON trace.lot_external_identifier USING btree (lot_id, identifier_type_code, COALESCE(partner_id, (0)::bigint), COALESCE((external_system_code)::character varying, ''::character varying), external_identifier);


--
-- Name: audit_event_default_pkey; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.audit_event_pkey ATTACH PARTITION audit.audit_event_default_pkey;


--
-- Name: audit_event_default_target_type_code_target_id_occurred_at_idx; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.ix_audit_target ATTACH PARTITION audit.audit_event_default_target_type_code_target_id_occurred_at_idx;


--
-- Name: inventory_transaction_default_idempotency_key_business_date_key; Type: INDEX ATTACH; Schema: inventory; Owner: -
--

ALTER INDEX inventory.uq_inventory_idempotency ATTACH PARTITION inventory.inventory_transaction_default_idempotency_key_business_date_key;


--
-- Name: inventory_transaction_default_occurred_at_idx; Type: INDEX ATTACH; Schema: inventory; Owner: -
--

ALTER INDEX inventory.ix_inventory_transaction_occurred_brin ATTACH PARTITION inventory.inventory_transaction_default_occurred_at_idx;


--
-- Name: inventory_transaction_default_pkey; Type: INDEX ATTACH; Schema: inventory; Owner: -
--

ALTER INDEX inventory.inventory_transaction_pkey ATTACH PARTITION inventory.inventory_transaction_default_pkey;


--
-- Name: inventory_transaction_default_source_document_type_code_sou_idx; Type: INDEX ATTACH; Schema: inventory; Owner: -
--

ALTER INDEX inventory.ix_inventory_transaction_source ATTACH PARTITION inventory.inventory_transaction_default_source_document_type_code_sou_idx;


--
-- Name: inventory_transaction_default_transaction_no_business_date_key; Type: INDEX ATTACH; Schema: inventory; Owner: -
--

ALTER INDEX inventory.uq_inventory_transaction_no ATTACH PARTITION inventory.inventory_transaction_default_transaction_no_business_date_key;


--
-- Name: app_user trg_app_user_set_updated_at; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER trg_app_user_set_updated_at BEFORE UPDATE ON app.app_user FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: approval_request trg_approval_request_set_updated_at; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER trg_approval_request_set_updated_at BEFORE UPDATE ON app.approval_request FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: approval_route trg_approval_route_set_updated_at; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER trg_approval_route_set_updated_at BEFORE UPDATE ON app.approval_route FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: exception_case trg_exception_case_set_updated_at; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER trg_exception_case_set_updated_at BEFORE UPDATE ON app.exception_case FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: numbering_counter trg_numbering_counter_set_updated_at; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER trg_numbering_counter_set_updated_at BEFORE UPDATE ON app.numbering_counter FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: numbering_rule trg_numbering_rule_set_updated_at; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER trg_numbering_rule_set_updated_at BEFORE UPDATE ON app.numbering_rule FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: operation_policy trg_operation_policy_set_updated_at; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER trg_operation_policy_set_updated_at BEFORE UPDATE ON app.operation_policy FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: role trg_role_set_updated_at; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER trg_role_set_updated_at BEFORE UPDATE ON app.role FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: handling_unit trg_handling_unit_set_updated_at; Type: TRIGGER; Schema: inventory; Owner: -
--

CREATE TRIGGER trg_handling_unit_set_updated_at BEFORE UPDATE ON inventory.handling_unit FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: inventory_adjustment trg_inventory_adjustment_set_updated_at; Type: TRIGGER; Schema: inventory; Owner: -
--

CREATE TRIGGER trg_inventory_adjustment_set_updated_at BEFORE UPDATE ON inventory.inventory_adjustment FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: inventory_balance trg_inventory_balance_qty; Type: TRIGGER; Schema: inventory; Owner: -
--

CREATE TRIGGER trg_inventory_balance_qty BEFORE INSERT OR UPDATE ON inventory.inventory_balance FOR EACH ROW EXECUTE FUNCTION inventory.check_balance_qty();


--
-- Name: inventory_balance trg_inventory_balance_set_updated_at; Type: TRIGGER; Schema: inventory; Owner: -
--

CREATE TRIGGER trg_inventory_balance_set_updated_at BEFORE UPDATE ON inventory.inventory_balance FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: inventory_count trg_inventory_count_set_updated_at; Type: TRIGGER; Schema: inventory; Owner: -
--

CREATE TRIGGER trg_inventory_count_set_updated_at BEFORE UPDATE ON inventory.inventory_count FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: inventory_reservation trg_inventory_reservation_set_updated_at; Type: TRIGGER; Schema: inventory; Owner: -
--

CREATE TRIGGER trg_inventory_reservation_set_updated_at BEFORE UPDATE ON inventory.inventory_reservation FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: inventory_transaction trg_inventory_transaction_immutable; Type: TRIGGER; Schema: inventory; Owner: -
--

CREATE TRIGGER trg_inventory_transaction_immutable BEFORE DELETE OR UPDATE ON inventory.inventory_transaction FOR EACH ROW EXECUTE FUNCTION inventory.block_ledger_header_mutation();


--
-- Name: inventory_transaction_line trg_inventory_transaction_line_immutable; Type: TRIGGER; Schema: inventory; Owner: -
--

CREATE TRIGGER trg_inventory_transaction_line_immutable BEFORE DELETE OR UPDATE ON inventory.inventory_transaction_line FOR EACH ROW EXECUTE FUNCTION inventory.block_ledger_line_mutation();


--
-- Name: asn trg_asn_set_updated_at; Type: TRIGGER; Schema: logistics; Owner: -
--

CREATE TRIGGER trg_asn_set_updated_at BEFORE UPDATE ON logistics.asn FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: goods_issue trg_goods_issue_set_updated_at; Type: TRIGGER; Schema: logistics; Owner: -
--

CREATE TRIGGER trg_goods_issue_set_updated_at BEFORE UPDATE ON logistics.goods_issue FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: goods_receipt trg_goods_receipt_set_updated_at; Type: TRIGGER; Schema: logistics; Owner: -
--

CREATE TRIGGER trg_goods_receipt_set_updated_at BEFORE UPDATE ON logistics.goods_receipt FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: inbound_receipt_line trg_inbound_receipt_line_set_updated_at; Type: TRIGGER; Schema: logistics; Owner: -
--

CREATE TRIGGER trg_inbound_receipt_line_set_updated_at BEFORE UPDATE ON logistics.inbound_receipt_line FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: inbound_receipt trg_inbound_receipt_set_updated_at; Type: TRIGGER; Schema: logistics; Owner: -
--

CREATE TRIGGER trg_inbound_receipt_set_updated_at BEFORE UPDATE ON logistics.inbound_receipt FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: material_issue_request trg_material_issue_request_set_updated_at; Type: TRIGGER; Schema: logistics; Owner: -
--

CREATE TRIGGER trg_material_issue_request_set_updated_at BEFORE UPDATE ON logistics.material_issue_request FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: picking_line trg_picking_line_set_updated_at; Type: TRIGGER; Schema: logistics; Owner: -
--

CREATE TRIGGER trg_picking_line_set_updated_at BEFORE UPDATE ON logistics.picking_line FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: picking_order trg_picking_order_set_updated_at; Type: TRIGGER; Schema: logistics; Owner: -
--

CREATE TRIGGER trg_picking_order_set_updated_at BEFORE UPDATE ON logistics.picking_order FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: purchase_order_line trg_purchase_order_line_set_updated_at; Type: TRIGGER; Schema: logistics; Owner: -
--

CREATE TRIGGER trg_purchase_order_line_set_updated_at BEFORE UPDATE ON logistics.purchase_order_line FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: purchase_order trg_purchase_order_set_updated_at; Type: TRIGGER; Schema: logistics; Owner: -
--

CREATE TRIGGER trg_purchase_order_set_updated_at BEFORE UPDATE ON logistics.purchase_order FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: putaway_rule trg_putaway_rule_set_updated_at; Type: TRIGGER; Schema: logistics; Owner: -
--

CREATE TRIGGER trg_putaway_rule_set_updated_at BEFORE UPDATE ON logistics.putaway_rule FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: putaway_task trg_putaway_task_set_updated_at; Type: TRIGGER; Schema: logistics; Owner: -
--

CREATE TRIGGER trg_putaway_task_set_updated_at BEFORE UPDATE ON logistics.putaway_task FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: sales_order_line trg_sales_order_line_set_updated_at; Type: TRIGGER; Schema: logistics; Owner: -
--

CREATE TRIGGER trg_sales_order_line_set_updated_at BEFORE UPDATE ON logistics.sales_order_line FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: sales_order trg_sales_order_set_updated_at; Type: TRIGGER; Schema: logistics; Owner: -
--

CREATE TRIGGER trg_sales_order_set_updated_at BEFORE UPDATE ON logistics.sales_order FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: shipment_request_line trg_shipment_request_line_set_updated_at; Type: TRIGGER; Schema: logistics; Owner: -
--

CREATE TRIGGER trg_shipment_request_line_set_updated_at BEFORE UPDATE ON logistics.shipment_request_line FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: shipment_request trg_shipment_request_set_updated_at; Type: TRIGGER; Schema: logistics; Owner: -
--

CREATE TRIGGER trg_shipment_request_set_updated_at BEFORE UPDATE ON logistics.shipment_request FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: shipment trg_shipment_set_updated_at; Type: TRIGGER; Schema: logistics; Owner: -
--

CREATE TRIGGER trg_shipment_set_updated_at BEFORE UPDATE ON logistics.shipment FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: shopfloor_receipt trg_shopfloor_receipt_set_updated_at; Type: TRIGGER; Schema: logistics; Owner: -
--

CREATE TRIGGER trg_shopfloor_receipt_set_updated_at BEFORE UPDATE ON logistics.shopfloor_receipt FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: stock_transfer trg_stock_transfer_set_updated_at; Type: TRIGGER; Schema: logistics; Owner: -
--

CREATE TRIGGER trg_stock_transfer_set_updated_at BEFORE UPDATE ON logistics.stock_transfer FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: subcontract_order trg_subcontract_order_set_updated_at; Type: TRIGGER; Schema: logistics; Owner: -
--

CREATE TRIGGER trg_subcontract_order_set_updated_at BEFORE UPDATE ON logistics.subcontract_order FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: business_unit trg_business_unit_set_updated_at; Type: TRIGGER; Schema: mdm; Owner: -
--

CREATE TRIGGER trg_business_unit_set_updated_at BEFORE UPDATE ON mdm.business_unit FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: code_group trg_code_group_set_updated_at; Type: TRIGGER; Schema: mdm; Owner: -
--

CREATE TRIGGER trg_code_group_set_updated_at BEFORE UPDATE ON mdm.code_group FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: code_value trg_code_value_set_updated_at; Type: TRIGGER; Schema: mdm; Owner: -
--

CREATE TRIGGER trg_code_value_set_updated_at BEFORE UPDATE ON mdm.code_value FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: department trg_department_set_updated_at; Type: TRIGGER; Schema: mdm; Owner: -
--

CREATE TRIGGER trg_department_set_updated_at BEFORE UPDATE ON mdm.department FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: equipment trg_equipment_set_updated_at; Type: TRIGGER; Schema: mdm; Owner: -
--

CREATE TRIGGER trg_equipment_set_updated_at BEFORE UPDATE ON mdm.equipment FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: item trg_item_set_updated_at; Type: TRIGGER; Schema: mdm; Owner: -
--

CREATE TRIGGER trg_item_set_updated_at BEFORE UPDATE ON mdm.item FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: legal_entity trg_legal_entity_set_updated_at; Type: TRIGGER; Schema: mdm; Owner: -
--

CREATE TRIGGER trg_legal_entity_set_updated_at BEFORE UPDATE ON mdm.legal_entity FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: location trg_location_set_updated_at; Type: TRIGGER; Schema: mdm; Owner: -
--

CREATE TRIGGER trg_location_set_updated_at BEFORE UPDATE ON mdm.location FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: mold trg_mold_set_updated_at; Type: TRIGGER; Schema: mdm; Owner: -
--

CREATE TRIGGER trg_mold_set_updated_at BEFORE UPDATE ON mdm.mold FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: partner trg_partner_set_updated_at; Type: TRIGGER; Schema: mdm; Owner: -
--

CREATE TRIGGER trg_partner_set_updated_at BEFORE UPDATE ON mdm.partner FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: plant trg_plant_set_updated_at; Type: TRIGGER; Schema: mdm; Owner: -
--

CREATE TRIGGER trg_plant_set_updated_at BEFORE UPDATE ON mdm.plant FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: process trg_process_set_updated_at; Type: TRIGGER; Schema: mdm; Owner: -
--

CREATE TRIGGER trg_process_set_updated_at BEFORE UPDATE ON mdm.process FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: production_line trg_production_line_set_updated_at; Type: TRIGGER; Schema: mdm; Owner: -
--

CREATE TRIGGER trg_production_line_set_updated_at BEFORE UPDATE ON mdm.production_line FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: shift trg_shift_set_updated_at; Type: TRIGGER; Schema: mdm; Owner: -
--

CREATE TRIGGER trg_shift_set_updated_at BEFORE UPDATE ON mdm.shift FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: terminal trg_terminal_set_updated_at; Type: TRIGGER; Schema: mdm; Owner: -
--

CREATE TRIGGER trg_terminal_set_updated_at BEFORE UPDATE ON mdm.terminal FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: uom trg_uom_set_updated_at; Type: TRIGGER; Schema: mdm; Owner: -
--

CREATE TRIGGER trg_uom_set_updated_at BEFORE UPDATE ON mdm.uom FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: warehouse trg_warehouse_set_updated_at; Type: TRIGGER; Schema: mdm; Owner: -
--

CREATE TRIGGER trg_warehouse_set_updated_at BEFORE UPDATE ON mdm.warehouse FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: worker trg_worker_set_updated_at; Type: TRIGGER; Schema: mdm; Owner: -
--

CREATE TRIGGER trg_worker_set_updated_at BEFORE UPDATE ON mdm.worker FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: bom_component trg_bom_component_set_updated_at; Type: TRIGGER; Schema: planning; Owner: -
--

CREATE TRIGGER trg_bom_component_set_updated_at BEFORE UPDATE ON planning.bom_component FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: bom trg_bom_set_updated_at; Type: TRIGGER; Schema: planning; Owner: -
--

CREATE TRIGGER trg_bom_set_updated_at BEFORE UPDATE ON planning.bom FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: production_order trg_production_order_set_updated_at; Type: TRIGGER; Schema: planning; Owner: -
--

CREATE TRIGGER trg_production_order_set_updated_at BEFORE UPDATE ON planning.production_order FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: production_plan trg_production_plan_set_updated_at; Type: TRIGGER; Schema: planning; Owner: -
--

CREATE TRIGGER trg_production_plan_set_updated_at BEFORE UPDATE ON planning.production_plan FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: routing_operation trg_routing_operation_set_updated_at; Type: TRIGGER; Schema: planning; Owner: -
--

CREATE TRIGGER trg_routing_operation_set_updated_at BEFORE UPDATE ON planning.routing_operation FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: routing trg_routing_set_updated_at; Type: TRIGGER; Schema: planning; Owner: -
--

CREATE TRIGGER trg_routing_set_updated_at BEFORE UPDATE ON planning.routing FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: material_consumption trg_material_consumption_set_updated_at; Type: TRIGGER; Schema: production; Owner: -
--

CREATE TRIGGER trg_material_consumption_set_updated_at BEFORE UPDATE ON production.material_consumption FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: material_return trg_material_return_set_updated_at; Type: TRIGGER; Schema: production; Owner: -
--

CREATE TRIGGER trg_material_return_set_updated_at BEFORE UPDATE ON production.material_return FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: material_usage_allocation trg_material_usage_allocation_sum; Type: TRIGGER; Schema: production; Owner: -
--

CREATE CONSTRAINT TRIGGER trg_material_usage_allocation_sum AFTER INSERT OR UPDATE ON production.material_usage_allocation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION production.check_material_usage_allocation();


--
-- Name: operation_handover trg_operation_handover_set_updated_at; Type: TRIGGER; Schema: production; Owner: -
--

CREATE TRIGGER trg_operation_handover_set_updated_at BEFORE UPDATE ON production.operation_handover FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: production_result trg_production_result_set_updated_at; Type: TRIGGER; Schema: production; Owner: -
--

CREATE TRIGGER trg_production_result_set_updated_at BEFORE UPDATE ON production.production_result FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: production_result_lot_allocation trg_result_lot_allocation_sum; Type: TRIGGER; Schema: production; Owner: -
--

CREATE CONSTRAINT TRIGGER trg_result_lot_allocation_sum AFTER INSERT OR UPDATE ON production.production_result_lot_allocation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION production.check_result_lot_allocation();


--
-- Name: work_order trg_work_order_closed_immutable; Type: TRIGGER; Schema: production; Owner: -
--

CREATE TRIGGER trg_work_order_closed_immutable BEFORE UPDATE ON production.work_order FOR EACH ROW EXECUTE FUNCTION production.block_closed_work_order_update();


--
-- Name: work_order trg_work_order_set_updated_at; Type: TRIGGER; Schema: production; Owner: -
--

CREATE TRIGGER trg_work_order_set_updated_at BEFORE UPDATE ON production.work_order FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: work_order trg_work_order_split_sum; Type: TRIGGER; Schema: production; Owner: -
--

CREATE CONSTRAINT TRIGGER trg_work_order_split_sum AFTER INSERT OR UPDATE OF order_qty, parent_work_order_id ON production.work_order DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION production.check_work_order_split();


--
-- Name: work_session trg_work_session_set_updated_at; Type: TRIGGER; Schema: production; Owner: -
--

CREATE TRIGGER trg_work_session_set_updated_at BEFORE UPDATE ON production.work_session FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: cause_code trg_cause_code_set_updated_at; Type: TRIGGER; Schema: quality; Owner: -
--

CREATE TRIGGER trg_cause_code_set_updated_at BEFORE UPDATE ON quality.cause_code FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: concession trg_concession_set_updated_at; Type: TRIGGER; Schema: quality; Owner: -
--

CREATE TRIGGER trg_concession_set_updated_at BEFORE UPDATE ON quality.concession FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: defect_code trg_defect_code_set_updated_at; Type: TRIGGER; Schema: quality; Owner: -
--

CREATE TRIGGER trg_defect_code_set_updated_at BEFORE UPDATE ON quality.defect_code FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: inspection_plan trg_inspection_plan_set_updated_at; Type: TRIGGER; Schema: quality; Owner: -
--

CREATE TRIGGER trg_inspection_plan_set_updated_at BEFORE UPDATE ON quality.inspection_plan FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: inspection_plan_version trg_inspection_plan_version_set_updated_at; Type: TRIGGER; Schema: quality; Owner: -
--

CREATE TRIGGER trg_inspection_plan_version_set_updated_at BEFORE UPDATE ON quality.inspection_plan_version FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: inspection_request trg_inspection_request_set_updated_at; Type: TRIGGER; Schema: quality; Owner: -
--

CREATE TRIGGER trg_inspection_request_set_updated_at BEFORE UPDATE ON quality.inspection_request FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: inspection_result trg_inspection_result_set_updated_at; Type: TRIGGER; Schema: quality; Owner: -
--

CREATE TRIGGER trg_inspection_result_set_updated_at BEFORE UPDATE ON quality.inspection_result FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: nonconformance trg_nonconformance_set_updated_at; Type: TRIGGER; Schema: quality; Owner: -
--

CREATE TRIGGER trg_nonconformance_set_updated_at BEFORE UPDATE ON quality.nonconformance FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: lot_relation trg_lot_relation_cycle; Type: TRIGGER; Schema: trace; Owner: -
--

CREATE TRIGGER trg_lot_relation_cycle BEFORE INSERT OR UPDATE OF source_lot_id, target_lot_id ON trace.lot_relation FOR EACH ROW EXECUTE FUNCTION trace.check_lot_relation_cycle();


--
-- Name: lot trg_lot_set_updated_at; Type: TRIGGER; Schema: trace; Owner: -
--

CREATE TRIGGER trg_lot_set_updated_at BEFORE UPDATE ON trace.lot FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: serial_number trg_serial_number_set_updated_at; Type: TRIGGER; Schema: trace; Owner: -
--

CREATE TRIGGER trg_serial_number_set_updated_at BEFORE UPDATE ON trace.serial_number FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


--
-- Name: app_user app_user_department_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.app_user
    ADD CONSTRAINT app_user_department_id_fkey FOREIGN KEY (department_id) REFERENCES mdm.department(department_id);


--
-- Name: approval_request approval_request_decided_by_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.approval_request
    ADD CONSTRAINT approval_request_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES app.app_user(app_user_id);


--
-- Name: approval_request approval_request_requested_by_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.approval_request
    ADD CONSTRAINT approval_request_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES app.app_user(app_user_id);


--
-- Name: approval_route approval_route_business_unit_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.approval_route
    ADD CONSTRAINT approval_route_business_unit_id_fkey FOREIGN KEY (business_unit_id) REFERENCES mdm.business_unit(business_unit_id);


--
-- Name: approval_route_step approval_route_step_approval_route_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.approval_route_step
    ADD CONSTRAINT approval_route_step_approval_route_id_fkey FOREIGN KEY (approval_route_id) REFERENCES app.approval_route(approval_route_id);


--
-- Name: approval_route_step approval_route_step_approver_department_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.approval_route_step
    ADD CONSTRAINT approval_route_step_approver_department_id_fkey FOREIGN KEY (approver_department_id) REFERENCES mdm.department(department_id);


--
-- Name: approval_route_step approval_route_step_approver_role_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.approval_route_step
    ADD CONSTRAINT approval_route_step_approver_role_id_fkey FOREIGN KEY (approver_role_id) REFERENCES app.role(role_id);


--
-- Name: approval_route_step approval_route_step_approver_user_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.approval_route_step
    ADD CONSTRAINT approval_route_step_approver_user_id_fkey FOREIGN KEY (approver_user_id) REFERENCES app.app_user(app_user_id);


--
-- Name: approval_step approval_step_approval_request_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.approval_step
    ADD CONSTRAINT approval_step_approval_request_id_fkey FOREIGN KEY (approval_request_id) REFERENCES app.approval_request(approval_request_id);


--
-- Name: approval_step approval_step_approver_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.approval_step
    ADD CONSTRAINT approval_step_approver_id_fkey FOREIGN KEY (approver_id) REFERENCES app.app_user(app_user_id);


--
-- Name: attachment attachment_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.attachment
    ADD CONSTRAINT attachment_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES app.app_user(app_user_id);


--
-- Name: document_cancellation document_cancellation_cancelled_by_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.document_cancellation
    ADD CONSTRAINT document_cancellation_cancelled_by_fkey FOREIGN KEY (cancelled_by) REFERENCES app.app_user(app_user_id);


--
-- Name: document_issue_log document_issue_log_issued_by_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.document_issue_log
    ADD CONSTRAINT document_issue_log_issued_by_fkey FOREIGN KEY (issued_by) REFERENCES app.app_user(app_user_id);


--
-- Name: document_issue_log document_issue_log_lot_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.document_issue_log
    ADD CONSTRAINT document_issue_log_lot_id_fkey FOREIGN KEY (lot_id) REFERENCES trace.lot(lot_id);


--
-- Name: document_issue_log document_issue_log_terminal_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.document_issue_log
    ADD CONSTRAINT document_issue_log_terminal_id_fkey FOREIGN KEY (terminal_id) REFERENCES mdm.terminal(terminal_id);


--
-- Name: exception_case exception_case_assigned_department_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.exception_case
    ADD CONSTRAINT exception_case_assigned_department_id_fkey FOREIGN KEY (assigned_department_id) REFERENCES mdm.department(department_id);


--
-- Name: exception_case exception_case_assigned_user_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.exception_case
    ADD CONSTRAINT exception_case_assigned_user_id_fkey FOREIGN KEY (assigned_user_id) REFERENCES app.app_user(app_user_id);


--
-- Name: idempotency_record idempotency_record_app_user_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.idempotency_record
    ADD CONSTRAINT idempotency_record_app_user_id_fkey FOREIGN KEY (app_user_id) REFERENCES app.app_user(app_user_id);


--
-- Name: localized_text localized_text_entity_type_code_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.localized_text
    ADD CONSTRAINT localized_text_entity_type_code_fkey FOREIGN KEY (entity_type_code) REFERENCES app.entity_type_registry(entity_type_code);


--
-- Name: notice_acknowledgement notice_acknowledgement_app_user_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.notice_acknowledgement
    ADD CONSTRAINT notice_acknowledgement_app_user_id_fkey FOREIGN KEY (app_user_id) REFERENCES app.app_user(app_user_id);


--
-- Name: notice_acknowledgement notice_acknowledgement_notice_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.notice_acknowledgement
    ADD CONSTRAINT notice_acknowledgement_notice_id_fkey FOREIGN KEY (notice_id) REFERENCES app.notice(notice_id);


--
-- Name: notice notice_closed_by_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.notice
    ADD CONSTRAINT notice_closed_by_fkey FOREIGN KEY (closed_by) REFERENCES app.app_user(app_user_id);


--
-- Name: notice notice_published_by_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.notice
    ADD CONSTRAINT notice_published_by_fkey FOREIGN KEY (published_by) REFERENCES app.app_user(app_user_id);


--
-- Name: notification notification_notification_event_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.notification
    ADD CONSTRAINT notification_notification_event_id_fkey FOREIGN KEY (notification_event_id) REFERENCES app.notification_event(notification_event_id);


--
-- Name: notification notification_recipient_user_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.notification
    ADD CONSTRAINT notification_recipient_user_id_fkey FOREIGN KEY (recipient_user_id) REFERENCES app.app_user(app_user_id);


--
-- Name: notification_subscription notification_subscription_app_user_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.notification_subscription
    ADD CONSTRAINT notification_subscription_app_user_id_fkey FOREIGN KEY (app_user_id) REFERENCES app.app_user(app_user_id);


--
-- Name: numbering_counter numbering_counter_numbering_rule_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.numbering_counter
    ADD CONSTRAINT numbering_counter_numbering_rule_id_fkey FOREIGN KEY (numbering_rule_id) REFERENCES app.numbering_rule(numbering_rule_id);


--
-- Name: numbering_rule numbering_rule_plant_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.numbering_rule
    ADD CONSTRAINT numbering_rule_plant_id_fkey FOREIGN KEY (plant_id) REFERENCES mdm.plant(plant_id);


--
-- Name: operation_policy operation_policy_business_unit_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.operation_policy
    ADD CONSTRAINT operation_policy_business_unit_id_fkey FOREIGN KEY (business_unit_id) REFERENCES mdm.business_unit(business_unit_id);


--
-- Name: operation_policy operation_policy_item_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.operation_policy
    ADD CONSTRAINT operation_policy_item_id_fkey FOREIGN KEY (item_id) REFERENCES mdm.item(item_id);


--
-- Name: operation_policy operation_policy_plant_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.operation_policy
    ADD CONSTRAINT operation_policy_plant_id_fkey FOREIGN KEY (plant_id) REFERENCES mdm.plant(plant_id);


--
-- Name: operation_policy operation_policy_process_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.operation_policy
    ADD CONSTRAINT operation_policy_process_id_fkey FOREIGN KEY (process_id) REFERENCES mdm.process(process_id);


--
-- Name: printer printer_plant_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.printer
    ADD CONSTRAINT printer_plant_id_fkey FOREIGN KEY (plant_id) REFERENCES mdm.plant(plant_id);


--
-- Name: role_permission role_permission_role_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.role_permission
    ADD CONSTRAINT role_permission_role_id_fkey FOREIGN KEY (role_id) REFERENCES app.role(role_id);


--
-- Name: user_credential user_credential_app_user_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.user_credential
    ADD CONSTRAINT user_credential_app_user_id_fkey FOREIGN KEY (app_user_id) REFERENCES app.app_user(app_user_id) ON DELETE CASCADE;


--
-- Name: user_data_scope user_data_scope_app_user_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.user_data_scope
    ADD CONSTRAINT user_data_scope_app_user_id_fkey FOREIGN KEY (app_user_id) REFERENCES app.app_user(app_user_id);


--
-- Name: user_data_scope user_data_scope_business_unit_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.user_data_scope
    ADD CONSTRAINT user_data_scope_business_unit_id_fkey FOREIGN KEY (business_unit_id) REFERENCES mdm.business_unit(business_unit_id);


--
-- Name: user_data_scope user_data_scope_legal_entity_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.user_data_scope
    ADD CONSTRAINT user_data_scope_legal_entity_id_fkey FOREIGN KEY (legal_entity_id) REFERENCES mdm.legal_entity(legal_entity_id);


--
-- Name: user_data_scope user_data_scope_plant_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.user_data_scope
    ADD CONSTRAINT user_data_scope_plant_id_fkey FOREIGN KEY (plant_id) REFERENCES mdm.plant(plant_id);


--
-- Name: user_role user_role_app_user_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.user_role
    ADD CONSTRAINT user_role_app_user_id_fkey FOREIGN KEY (app_user_id) REFERENCES app.app_user(app_user_id);


--
-- Name: user_role user_role_role_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.user_role
    ADD CONSTRAINT user_role_role_id_fkey FOREIGN KEY (role_id) REFERENCES app.role(role_id);


--
-- Name: worker_lease worker_lease_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.worker_lease
    ADD CONSTRAINT worker_lease_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES app.app_user(app_user_id);


--
-- Name: audit_event audit_event_terminal_id_fkey; Type: FK CONSTRAINT; Schema: audit; Owner: -
--

ALTER TABLE audit.audit_event
    ADD CONSTRAINT audit_event_terminal_id_fkey FOREIGN KEY (terminal_id) REFERENCES mdm.terminal(terminal_id);


--
-- Name: outbound_item_setting outbound_item_setting_interface_definition_id_fkey; Type: FK CONSTRAINT; Schema: integration; Owner: -
--

ALTER TABLE ONLY integration.outbound_item_setting
    ADD CONSTRAINT outbound_item_setting_interface_definition_id_fkey FOREIGN KEY (interface_definition_id) REFERENCES integration.interface_definition(interface_definition_id);


--
-- Name: outbound_item_setting outbound_item_setting_item_id_fkey; Type: FK CONSTRAINT; Schema: integration; Owner: -
--

ALTER TABLE ONLY integration.outbound_item_setting
    ADD CONSTRAINT outbound_item_setting_item_id_fkey FOREIGN KEY (item_id) REFERENCES mdm.item(item_id);


--
-- Name: record_provenance record_provenance_entity_type_code_fkey; Type: FK CONSTRAINT; Schema: integration; Owner: -
--

ALTER TABLE ONLY integration.record_provenance
    ADD CONSTRAINT record_provenance_entity_type_code_fkey FOREIGN KEY (entity_type_code) REFERENCES app.entity_type_registry(entity_type_code);


--
-- Name: record_provenance record_provenance_integration_message_id_fkey; Type: FK CONSTRAINT; Schema: integration; Owner: -
--

ALTER TABLE ONLY integration.record_provenance
    ADD CONSTRAINT record_provenance_integration_message_id_fkey FOREIGN KEY (integration_message_id) REFERENCES integration.integration_message(integration_message_id);


--
-- Name: inventory_adjustment fk_inventory_adjustment_approval; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_adjustment
    ADD CONSTRAINT fk_inventory_adjustment_approval FOREIGN KEY (approval_request_id) REFERENCES app.approval_request(approval_request_id);


--
-- Name: inventory_count_line fk_inventory_count_line_counted_by; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_count_line
    ADD CONSTRAINT fk_inventory_count_line_counted_by FOREIGN KEY (counted_by) REFERENCES app.app_user(app_user_id);


--
-- Name: inventory_transaction_line fk_inventory_transaction_line_header; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_transaction_line
    ADD CONSTRAINT fk_inventory_transaction_line_header FOREIGN KEY (inventory_transaction_id, business_date) REFERENCES inventory.inventory_transaction(inventory_transaction_id, business_date);


--
-- Name: inventory_transaction_line fk_inventory_transaction_line_hu; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_transaction_line
    ADD CONSTRAINT fk_inventory_transaction_line_hu FOREIGN KEY (handling_unit_id) REFERENCES inventory.handling_unit(handling_unit_id);


--
-- Name: inventory_transaction fk_inventory_transaction_reversal; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE inventory.inventory_transaction
    ADD CONSTRAINT fk_inventory_transaction_reversal FOREIGN KEY (reversal_of_transaction_id, reversal_of_business_date) REFERENCES inventory.inventory_transaction(inventory_transaction_id, business_date);


--
-- Name: handling_unit_content handling_unit_content_handling_unit_id_fkey; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.handling_unit_content
    ADD CONSTRAINT handling_unit_content_handling_unit_id_fkey FOREIGN KEY (handling_unit_id) REFERENCES inventory.handling_unit(handling_unit_id);


--
-- Name: handling_unit_content handling_unit_content_item_id_fkey; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.handling_unit_content
    ADD CONSTRAINT handling_unit_content_item_id_fkey FOREIGN KEY (item_id) REFERENCES mdm.item(item_id);


--
-- Name: handling_unit_content handling_unit_content_lot_id_fkey; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.handling_unit_content
    ADD CONSTRAINT handling_unit_content_lot_id_fkey FOREIGN KEY (lot_id) REFERENCES trace.lot(lot_id);


--
-- Name: handling_unit_content handling_unit_content_uom_id_fkey; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.handling_unit_content
    ADD CONSTRAINT handling_unit_content_uom_id_fkey FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: handling_unit handling_unit_location_id_fkey; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.handling_unit
    ADD CONSTRAINT handling_unit_location_id_fkey FOREIGN KEY (location_id) REFERENCES mdm.location(location_id);


--
-- Name: handling_unit handling_unit_parent_handling_unit_id_fkey; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.handling_unit
    ADD CONSTRAINT handling_unit_parent_handling_unit_id_fkey FOREIGN KEY (parent_handling_unit_id) REFERENCES inventory.handling_unit(handling_unit_id);


--
-- Name: handling_unit_reconfiguration_line handling_unit_reconfiguration_handling_unit_reconfiguratio_fkey; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.handling_unit_reconfiguration_line
    ADD CONSTRAINT handling_unit_reconfiguration_handling_unit_reconfiguratio_fkey FOREIGN KEY (handling_unit_reconfiguration_id) REFERENCES inventory.handling_unit_reconfiguration(handling_unit_reconfiguration_id);


--
-- Name: handling_unit_reconfiguration_line handling_unit_reconfiguration_line_item_id_fkey; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.handling_unit_reconfiguration_line
    ADD CONSTRAINT handling_unit_reconfiguration_line_item_id_fkey FOREIGN KEY (item_id) REFERENCES mdm.item(item_id);


--
-- Name: handling_unit_reconfiguration_line handling_unit_reconfiguration_line_lot_id_fkey; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.handling_unit_reconfiguration_line
    ADD CONSTRAINT handling_unit_reconfiguration_line_lot_id_fkey FOREIGN KEY (lot_id) REFERENCES trace.lot(lot_id);


--
-- Name: handling_unit_reconfiguration_line handling_unit_reconfiguration_line_uom_id_fkey; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.handling_unit_reconfiguration_line
    ADD CONSTRAINT handling_unit_reconfiguration_line_uom_id_fkey FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: handling_unit_reconfiguration handling_unit_reconfiguration_performed_by_fkey; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.handling_unit_reconfiguration
    ADD CONSTRAINT handling_unit_reconfiguration_performed_by_fkey FOREIGN KEY (performed_by) REFERENCES app.app_user(app_user_id);


--
-- Name: handling_unit_reconfiguration handling_unit_reconfiguration_source_handling_unit_id_fkey; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.handling_unit_reconfiguration
    ADD CONSTRAINT handling_unit_reconfiguration_source_handling_unit_id_fkey FOREIGN KEY (source_handling_unit_id) REFERENCES inventory.handling_unit(handling_unit_id);


--
-- Name: handling_unit_reconfiguration handling_unit_reconfiguration_target_handling_unit_id_fkey; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.handling_unit_reconfiguration
    ADD CONSTRAINT handling_unit_reconfiguration_target_handling_unit_id_fkey FOREIGN KEY (target_handling_unit_id) REFERENCES inventory.handling_unit(handling_unit_id);


--
-- Name: handling_unit handling_unit_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.handling_unit
    ADD CONSTRAINT handling_unit_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES mdm.warehouse(warehouse_id);


--
-- Name: inventory_adjustment inventory_adjustment_inventory_count_id_fkey; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_adjustment
    ADD CONSTRAINT inventory_adjustment_inventory_count_id_fkey FOREIGN KEY (inventory_count_id) REFERENCES inventory.inventory_count(inventory_count_id);


--
-- Name: inventory_adjustment_line inventory_adjustment_line_inventory_adjustment_id_fkey; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_adjustment_line
    ADD CONSTRAINT inventory_adjustment_line_inventory_adjustment_id_fkey FOREIGN KEY (inventory_adjustment_id) REFERENCES inventory.inventory_adjustment(inventory_adjustment_id);


--
-- Name: inventory_adjustment_line inventory_adjustment_line_inventory_transaction_line_id_fkey; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_adjustment_line
    ADD CONSTRAINT inventory_adjustment_line_inventory_transaction_line_id_fkey FOREIGN KEY (inventory_transaction_line_id) REFERENCES inventory.inventory_transaction_line(inventory_transaction_line_id);


--
-- Name: inventory_adjustment_line inventory_adjustment_line_item_id_fkey; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_adjustment_line
    ADD CONSTRAINT inventory_adjustment_line_item_id_fkey FOREIGN KEY (item_id) REFERENCES mdm.item(item_id);


--
-- Name: inventory_adjustment_line inventory_adjustment_line_location_id_fkey; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_adjustment_line
    ADD CONSTRAINT inventory_adjustment_line_location_id_fkey FOREIGN KEY (location_id) REFERENCES mdm.location(location_id);


--
-- Name: inventory_adjustment_line inventory_adjustment_line_lot_id_fkey; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_adjustment_line
    ADD CONSTRAINT inventory_adjustment_line_lot_id_fkey FOREIGN KEY (lot_id) REFERENCES trace.lot(lot_id);


--
-- Name: inventory_adjustment_line inventory_adjustment_line_uom_id_fkey; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_adjustment_line
    ADD CONSTRAINT inventory_adjustment_line_uom_id_fkey FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: inventory_balance inventory_balance_business_unit_id_fkey; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_balance
    ADD CONSTRAINT inventory_balance_business_unit_id_fkey FOREIGN KEY (business_unit_id) REFERENCES mdm.business_unit(business_unit_id);


--
-- Name: inventory_balance inventory_balance_item_id_fkey; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_balance
    ADD CONSTRAINT inventory_balance_item_id_fkey FOREIGN KEY (item_id) REFERENCES mdm.item(item_id);


--
-- Name: inventory_balance inventory_balance_legal_entity_id_fkey; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_balance
    ADD CONSTRAINT inventory_balance_legal_entity_id_fkey FOREIGN KEY (legal_entity_id) REFERENCES mdm.legal_entity(legal_entity_id);


--
-- Name: inventory_balance inventory_balance_location_id_fkey; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_balance
    ADD CONSTRAINT inventory_balance_location_id_fkey FOREIGN KEY (location_id) REFERENCES mdm.location(location_id);


--
-- Name: inventory_balance inventory_balance_lot_id_fkey; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_balance
    ADD CONSTRAINT inventory_balance_lot_id_fkey FOREIGN KEY (lot_id) REFERENCES trace.lot(lot_id);


--
-- Name: inventory_balance inventory_balance_owner_partner_id_fkey; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_balance
    ADD CONSTRAINT inventory_balance_owner_partner_id_fkey FOREIGN KEY (owner_partner_id) REFERENCES mdm.partner(partner_id);


--
-- Name: inventory_balance inventory_balance_plant_id_fkey; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_balance
    ADD CONSTRAINT inventory_balance_plant_id_fkey FOREIGN KEY (plant_id) REFERENCES mdm.plant(plant_id);


--
-- Name: inventory_balance inventory_balance_uom_id_fkey; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_balance
    ADD CONSTRAINT inventory_balance_uom_id_fkey FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: inventory_balance inventory_balance_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_balance
    ADD CONSTRAINT inventory_balance_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES mdm.warehouse(warehouse_id);


--
-- Name: inventory_count_line inventory_count_line_inventory_count_id_fkey; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_count_line
    ADD CONSTRAINT inventory_count_line_inventory_count_id_fkey FOREIGN KEY (inventory_count_id) REFERENCES inventory.inventory_count(inventory_count_id);


--
-- Name: inventory_count_line inventory_count_line_item_id_fkey; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_count_line
    ADD CONSTRAINT inventory_count_line_item_id_fkey FOREIGN KEY (item_id) REFERENCES mdm.item(item_id);


--
-- Name: inventory_count_line inventory_count_line_location_id_fkey; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_count_line
    ADD CONSTRAINT inventory_count_line_location_id_fkey FOREIGN KEY (location_id) REFERENCES mdm.location(location_id);


--
-- Name: inventory_count_line inventory_count_line_lot_id_fkey; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_count_line
    ADD CONSTRAINT inventory_count_line_lot_id_fkey FOREIGN KEY (lot_id) REFERENCES trace.lot(lot_id);


--
-- Name: inventory_count_line inventory_count_line_uom_id_fkey; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_count_line
    ADD CONSTRAINT inventory_count_line_uom_id_fkey FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: inventory_count inventory_count_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_count
    ADD CONSTRAINT inventory_count_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES mdm.warehouse(warehouse_id);


--
-- Name: inventory_reservation inventory_reservation_item_id_fkey; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_reservation
    ADD CONSTRAINT inventory_reservation_item_id_fkey FOREIGN KEY (item_id) REFERENCES mdm.item(item_id);


--
-- Name: inventory_reservation inventory_reservation_location_id_fkey; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_reservation
    ADD CONSTRAINT inventory_reservation_location_id_fkey FOREIGN KEY (location_id) REFERENCES mdm.location(location_id);


--
-- Name: inventory_reservation inventory_reservation_lot_id_fkey; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_reservation
    ADD CONSTRAINT inventory_reservation_lot_id_fkey FOREIGN KEY (lot_id) REFERENCES trace.lot(lot_id);


--
-- Name: inventory_reservation inventory_reservation_uom_id_fkey; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_reservation
    ADD CONSTRAINT inventory_reservation_uom_id_fkey FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: inventory_reservation inventory_reservation_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_reservation
    ADD CONSTRAINT inventory_reservation_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES mdm.warehouse(warehouse_id);


--
-- Name: inventory_transaction_line inventory_transaction_line_from_location_id_fkey; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_transaction_line
    ADD CONSTRAINT inventory_transaction_line_from_location_id_fkey FOREIGN KEY (from_location_id) REFERENCES mdm.location(location_id);


--
-- Name: inventory_transaction_line inventory_transaction_line_from_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_transaction_line
    ADD CONSTRAINT inventory_transaction_line_from_warehouse_id_fkey FOREIGN KEY (from_warehouse_id) REFERENCES mdm.warehouse(warehouse_id);


--
-- Name: inventory_transaction_line inventory_transaction_line_item_id_fkey; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_transaction_line
    ADD CONSTRAINT inventory_transaction_line_item_id_fkey FOREIGN KEY (item_id) REFERENCES mdm.item(item_id);


--
-- Name: inventory_transaction_line inventory_transaction_line_lot_id_fkey; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_transaction_line
    ADD CONSTRAINT inventory_transaction_line_lot_id_fkey FOREIGN KEY (lot_id) REFERENCES trace.lot(lot_id);


--
-- Name: inventory_transaction_line inventory_transaction_line_owner_partner_id_fkey; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_transaction_line
    ADD CONSTRAINT inventory_transaction_line_owner_partner_id_fkey FOREIGN KEY (owner_partner_id) REFERENCES mdm.partner(partner_id);


--
-- Name: inventory_transaction_line inventory_transaction_line_to_location_id_fkey; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_transaction_line
    ADD CONSTRAINT inventory_transaction_line_to_location_id_fkey FOREIGN KEY (to_location_id) REFERENCES mdm.location(location_id);


--
-- Name: inventory_transaction_line inventory_transaction_line_to_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_transaction_line
    ADD CONSTRAINT inventory_transaction_line_to_warehouse_id_fkey FOREIGN KEY (to_warehouse_id) REFERENCES mdm.warehouse(warehouse_id);


--
-- Name: inventory_transaction_line inventory_transaction_line_uom_id_fkey; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE ONLY inventory.inventory_transaction_line
    ADD CONSTRAINT inventory_transaction_line_uom_id_fkey FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: inventory_transaction inventory_transaction_plant_id_fkey; Type: FK CONSTRAINT; Schema: inventory; Owner: -
--

ALTER TABLE inventory.inventory_transaction
    ADD CONSTRAINT inventory_transaction_plant_id_fkey FOREIGN KEY (plant_id) REFERENCES mdm.plant(plant_id);


--
-- Name: asn_line asn_line_asn_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.asn_line
    ADD CONSTRAINT asn_line_asn_id_fkey FOREIGN KEY (asn_id) REFERENCES logistics.asn(asn_id);


--
-- Name: asn_line asn_line_item_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.asn_line
    ADD CONSTRAINT asn_line_item_id_fkey FOREIGN KEY (item_id) REFERENCES mdm.item(item_id);


--
-- Name: asn_line asn_line_purchase_order_line_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.asn_line
    ADD CONSTRAINT asn_line_purchase_order_line_id_fkey FOREIGN KEY (purchase_order_line_id) REFERENCES logistics.purchase_order_line(purchase_order_line_id);


--
-- Name: asn_line asn_line_uom_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.asn_line
    ADD CONSTRAINT asn_line_uom_id_fkey FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: asn asn_plant_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.asn
    ADD CONSTRAINT asn_plant_id_fkey FOREIGN KEY (plant_id) REFERENCES mdm.plant(plant_id);


--
-- Name: asn asn_supplier_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.asn
    ADD CONSTRAINT asn_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES mdm.partner(partner_id);


--
-- Name: goods_receipt_line fk_goods_receipt_line_orig_shipment; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.goods_receipt_line
    ADD CONSTRAINT fk_goods_receipt_line_orig_shipment FOREIGN KEY (original_shipment_lot_allocation_id) REFERENCES logistics.shipment_lot_allocation(shipment_lot_allocation_id);


--
-- Name: inbound_receipt fk_inbound_receipt_approval; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.inbound_receipt
    ADD CONSTRAINT fk_inbound_receipt_approval FOREIGN KEY (approval_request_id) REFERENCES app.approval_request(approval_request_id);


--
-- Name: inbound_receipt fk_inbound_receipt_received_by; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.inbound_receipt
    ADD CONSTRAINT fk_inbound_receipt_received_by FOREIGN KEY (received_by) REFERENCES app.app_user(app_user_id);


--
-- Name: inbound_variance fk_inbound_variance_approval; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.inbound_variance
    ADD CONSTRAINT fk_inbound_variance_approval FOREIGN KEY (approval_request_id) REFERENCES app.approval_request(approval_request_id);


--
-- Name: shopfloor_receipt fk_shopfloor_receipt_received_by; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.shopfloor_receipt
    ADD CONSTRAINT fk_shopfloor_receipt_received_by FOREIGN KEY (received_by) REFERENCES app.app_user(app_user_id);


--
-- Name: goods_issue goods_issue_approval_request_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.goods_issue
    ADD CONSTRAINT goods_issue_approval_request_id_fkey FOREIGN KEY (approval_request_id) REFERENCES app.approval_request(approval_request_id);


--
-- Name: goods_issue goods_issue_cancelled_by_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.goods_issue
    ADD CONSTRAINT goods_issue_cancelled_by_fkey FOREIGN KEY (cancelled_by) REFERENCES app.app_user(app_user_id);


--
-- Name: goods_issue_line goods_issue_line_goods_issue_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.goods_issue_line
    ADD CONSTRAINT goods_issue_line_goods_issue_id_fkey FOREIGN KEY (goods_issue_id) REFERENCES logistics.goods_issue(goods_issue_id);


--
-- Name: goods_issue_line goods_issue_line_inventory_transaction_line_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.goods_issue_line
    ADD CONSTRAINT goods_issue_line_inventory_transaction_line_id_fkey FOREIGN KEY (inventory_transaction_line_id) REFERENCES inventory.inventory_transaction_line(inventory_transaction_line_id);


--
-- Name: goods_issue_line goods_issue_line_item_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.goods_issue_line
    ADD CONSTRAINT goods_issue_line_item_id_fkey FOREIGN KEY (item_id) REFERENCES mdm.item(item_id);


--
-- Name: goods_issue_line goods_issue_line_lot_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.goods_issue_line
    ADD CONSTRAINT goods_issue_line_lot_id_fkey FOREIGN KEY (lot_id) REFERENCES trace.lot(lot_id);


--
-- Name: goods_issue_line goods_issue_line_picking_line_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.goods_issue_line
    ADD CONSTRAINT goods_issue_line_picking_line_id_fkey FOREIGN KEY (picking_line_id) REFERENCES logistics.picking_line(picking_line_id);


--
-- Name: goods_issue_line goods_issue_line_source_location_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.goods_issue_line
    ADD CONSTRAINT goods_issue_line_source_location_id_fkey FOREIGN KEY (source_location_id) REFERENCES mdm.location(location_id);


--
-- Name: goods_issue_line goods_issue_line_uom_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.goods_issue_line
    ADD CONSTRAINT goods_issue_line_uom_id_fkey FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: goods_issue goods_issue_source_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.goods_issue
    ADD CONSTRAINT goods_issue_source_warehouse_id_fkey FOREIGN KEY (source_warehouse_id) REFERENCES mdm.warehouse(warehouse_id);


--
-- Name: goods_receipt_line goods_receipt_line_destination_location_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.goods_receipt_line
    ADD CONSTRAINT goods_receipt_line_destination_location_id_fkey FOREIGN KEY (destination_location_id) REFERENCES mdm.location(location_id);


--
-- Name: goods_receipt_line goods_receipt_line_goods_receipt_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.goods_receipt_line
    ADD CONSTRAINT goods_receipt_line_goods_receipt_id_fkey FOREIGN KEY (goods_receipt_id) REFERENCES logistics.goods_receipt(goods_receipt_id);


--
-- Name: goods_receipt_line goods_receipt_line_inbound_receipt_line_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.goods_receipt_line
    ADD CONSTRAINT goods_receipt_line_inbound_receipt_line_id_fkey FOREIGN KEY (inbound_receipt_line_id) REFERENCES logistics.inbound_receipt_line(inbound_receipt_line_id);


--
-- Name: goods_receipt_line goods_receipt_line_inventory_transaction_line_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.goods_receipt_line
    ADD CONSTRAINT goods_receipt_line_inventory_transaction_line_id_fkey FOREIGN KEY (inventory_transaction_line_id) REFERENCES inventory.inventory_transaction_line(inventory_transaction_line_id);


--
-- Name: goods_receipt_line goods_receipt_line_item_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.goods_receipt_line
    ADD CONSTRAINT goods_receipt_line_item_id_fkey FOREIGN KEY (item_id) REFERENCES mdm.item(item_id);


--
-- Name: goods_receipt_line goods_receipt_line_lot_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.goods_receipt_line
    ADD CONSTRAINT goods_receipt_line_lot_id_fkey FOREIGN KEY (lot_id) REFERENCES trace.lot(lot_id);


--
-- Name: goods_receipt_line goods_receipt_line_uom_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.goods_receipt_line
    ADD CONSTRAINT goods_receipt_line_uom_id_fkey FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: goods_receipt goods_receipt_plant_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.goods_receipt
    ADD CONSTRAINT goods_receipt_plant_id_fkey FOREIGN KEY (plant_id) REFERENCES mdm.plant(plant_id);


--
-- Name: goods_receipt goods_receipt_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.goods_receipt
    ADD CONSTRAINT goods_receipt_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES mdm.warehouse(warehouse_id);


--
-- Name: inbound_receipt inbound_receipt_dock_location_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.inbound_receipt
    ADD CONSTRAINT inbound_receipt_dock_location_id_fkey FOREIGN KEY (dock_location_id) REFERENCES mdm.location(location_id);


--
-- Name: inbound_receipt_line inbound_receipt_line_asn_line_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.inbound_receipt_line
    ADD CONSTRAINT inbound_receipt_line_asn_line_id_fkey FOREIGN KEY (asn_line_id) REFERENCES logistics.asn_line(asn_line_id);


--
-- Name: inbound_receipt_line inbound_receipt_line_inbound_receipt_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.inbound_receipt_line
    ADD CONSTRAINT inbound_receipt_line_inbound_receipt_id_fkey FOREIGN KEY (inbound_receipt_id) REFERENCES logistics.inbound_receipt(inbound_receipt_id);


--
-- Name: inbound_receipt_line inbound_receipt_line_item_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.inbound_receipt_line
    ADD CONSTRAINT inbound_receipt_line_item_id_fkey FOREIGN KEY (item_id) REFERENCES mdm.item(item_id);


--
-- Name: inbound_receipt_line inbound_receipt_line_purchase_order_line_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.inbound_receipt_line
    ADD CONSTRAINT inbound_receipt_line_purchase_order_line_id_fkey FOREIGN KEY (purchase_order_line_id) REFERENCES logistics.purchase_order_line(purchase_order_line_id);


--
-- Name: inbound_receipt_line inbound_receipt_line_uom_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.inbound_receipt_line
    ADD CONSTRAINT inbound_receipt_line_uom_id_fkey FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: inbound_receipt inbound_receipt_plant_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.inbound_receipt
    ADD CONSTRAINT inbound_receipt_plant_id_fkey FOREIGN KEY (plant_id) REFERENCES mdm.plant(plant_id);


--
-- Name: inbound_receipt inbound_receipt_supplier_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.inbound_receipt
    ADD CONSTRAINT inbound_receipt_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES mdm.partner(partner_id);


--
-- Name: inbound_variance inbound_variance_inbound_receipt_line_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.inbound_variance
    ADD CONSTRAINT inbound_variance_inbound_receipt_line_id_fkey FOREIGN KEY (inbound_receipt_line_id) REFERENCES logistics.inbound_receipt_line(inbound_receipt_line_id);


--
-- Name: inbound_variance inbound_variance_uom_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.inbound_variance
    ADD CONSTRAINT inbound_variance_uom_id_fkey FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: material_issue_request material_issue_request_destination_location_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.material_issue_request
    ADD CONSTRAINT material_issue_request_destination_location_id_fkey FOREIGN KEY (destination_location_id) REFERENCES mdm.location(location_id);


--
-- Name: material_issue_request_line material_issue_request_line_bom_component_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.material_issue_request_line
    ADD CONSTRAINT material_issue_request_line_bom_component_id_fkey FOREIGN KEY (bom_component_id) REFERENCES planning.bom_component(bom_component_id);


--
-- Name: material_issue_request_line material_issue_request_line_item_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.material_issue_request_line
    ADD CONSTRAINT material_issue_request_line_item_id_fkey FOREIGN KEY (item_id) REFERENCES mdm.item(item_id);


--
-- Name: material_issue_request_line material_issue_request_line_material_issue_request_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.material_issue_request_line
    ADD CONSTRAINT material_issue_request_line_material_issue_request_id_fkey FOREIGN KEY (material_issue_request_id) REFERENCES logistics.material_issue_request(material_issue_request_id);


--
-- Name: material_issue_request_line material_issue_request_line_uom_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.material_issue_request_line
    ADD CONSTRAINT material_issue_request_line_uom_id_fkey FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: material_issue_request material_issue_request_requested_by_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.material_issue_request
    ADD CONSTRAINT material_issue_request_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES app.app_user(app_user_id);


--
-- Name: material_issue_request material_issue_request_work_order_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.material_issue_request
    ADD CONSTRAINT material_issue_request_work_order_id_fkey FOREIGN KEY (work_order_id) REFERENCES production.work_order(work_order_id);


--
-- Name: picking_line picking_line_inventory_reservation_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.picking_line
    ADD CONSTRAINT picking_line_inventory_reservation_id_fkey FOREIGN KEY (inventory_reservation_id) REFERENCES inventory.inventory_reservation(inventory_reservation_id);


--
-- Name: picking_line picking_line_item_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.picking_line
    ADD CONSTRAINT picking_line_item_id_fkey FOREIGN KEY (item_id) REFERENCES mdm.item(item_id);


--
-- Name: picking_line picking_line_location_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.picking_line
    ADD CONSTRAINT picking_line_location_id_fkey FOREIGN KEY (location_id) REFERENCES mdm.location(location_id);


--
-- Name: picking_line picking_line_lot_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.picking_line
    ADD CONSTRAINT picking_line_lot_id_fkey FOREIGN KEY (lot_id) REFERENCES trace.lot(lot_id);


--
-- Name: picking_line picking_line_picking_order_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.picking_line
    ADD CONSTRAINT picking_line_picking_order_id_fkey FOREIGN KEY (picking_order_id) REFERENCES logistics.picking_order(picking_order_id);


--
-- Name: picking_line picking_line_uom_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.picking_line
    ADD CONSTRAINT picking_line_uom_id_fkey FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: picking_order picking_order_assigned_worker_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.picking_order
    ADD CONSTRAINT picking_order_assigned_worker_id_fkey FOREIGN KEY (assigned_worker_id) REFERENCES mdm.worker(worker_id);


--
-- Name: picking_order picking_order_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.picking_order
    ADD CONSTRAINT picking_order_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES mdm.warehouse(warehouse_id);


--
-- Name: purchase_order purchase_order_business_unit_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.purchase_order
    ADD CONSTRAINT purchase_order_business_unit_id_fkey FOREIGN KEY (business_unit_id) REFERENCES mdm.business_unit(business_unit_id);


--
-- Name: purchase_order_line purchase_order_line_item_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.purchase_order_line
    ADD CONSTRAINT purchase_order_line_item_id_fkey FOREIGN KEY (item_id) REFERENCES mdm.item(item_id);


--
-- Name: purchase_order_line purchase_order_line_purchase_order_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.purchase_order_line
    ADD CONSTRAINT purchase_order_line_purchase_order_id_fkey FOREIGN KEY (purchase_order_id) REFERENCES logistics.purchase_order(purchase_order_id);


--
-- Name: purchase_order_line purchase_order_line_uom_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.purchase_order_line
    ADD CONSTRAINT purchase_order_line_uom_id_fkey FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: purchase_order purchase_order_plant_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.purchase_order
    ADD CONSTRAINT purchase_order_plant_id_fkey FOREIGN KEY (plant_id) REFERENCES mdm.plant(plant_id);


--
-- Name: purchase_order purchase_order_supplier_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.purchase_order
    ADD CONSTRAINT purchase_order_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES mdm.partner(partner_id);


--
-- Name: putaway_rule putaway_rule_item_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.putaway_rule
    ADD CONSTRAINT putaway_rule_item_id_fkey FOREIGN KEY (item_id) REFERENCES mdm.item(item_id);


--
-- Name: putaway_rule putaway_rule_location_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.putaway_rule
    ADD CONSTRAINT putaway_rule_location_id_fkey FOREIGN KEY (location_id) REFERENCES mdm.location(location_id);


--
-- Name: putaway_rule putaway_rule_uom_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.putaway_rule
    ADD CONSTRAINT putaway_rule_uom_id_fkey FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: putaway_rule putaway_rule_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.putaway_rule
    ADD CONSTRAINT putaway_rule_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES mdm.warehouse(warehouse_id);


--
-- Name: putaway_task putaway_task_actual_location_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.putaway_task
    ADD CONSTRAINT putaway_task_actual_location_id_fkey FOREIGN KEY (actual_location_id) REFERENCES mdm.location(location_id);


--
-- Name: putaway_task putaway_task_applied_putaway_rule_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.putaway_task
    ADD CONSTRAINT putaway_task_applied_putaway_rule_id_fkey FOREIGN KEY (applied_putaway_rule_id) REFERENCES logistics.putaway_rule(putaway_rule_id);


--
-- Name: putaway_task putaway_task_assigned_worker_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.putaway_task
    ADD CONSTRAINT putaway_task_assigned_worker_id_fkey FOREIGN KEY (assigned_worker_id) REFERENCES mdm.worker(worker_id);


--
-- Name: putaway_task putaway_task_from_location_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.putaway_task
    ADD CONSTRAINT putaway_task_from_location_id_fkey FOREIGN KEY (from_location_id) REFERENCES mdm.location(location_id);


--
-- Name: putaway_task putaway_task_goods_receipt_line_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.putaway_task
    ADD CONSTRAINT putaway_task_goods_receipt_line_id_fkey FOREIGN KEY (goods_receipt_line_id) REFERENCES logistics.goods_receipt_line(goods_receipt_line_id);


--
-- Name: putaway_task putaway_task_inventory_transaction_line_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.putaway_task
    ADD CONSTRAINT putaway_task_inventory_transaction_line_id_fkey FOREIGN KEY (inventory_transaction_line_id) REFERENCES inventory.inventory_transaction_line(inventory_transaction_line_id);


--
-- Name: putaway_task putaway_task_item_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.putaway_task
    ADD CONSTRAINT putaway_task_item_id_fkey FOREIGN KEY (item_id) REFERENCES mdm.item(item_id);


--
-- Name: putaway_task putaway_task_lot_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.putaway_task
    ADD CONSTRAINT putaway_task_lot_id_fkey FOREIGN KEY (lot_id) REFERENCES trace.lot(lot_id);


--
-- Name: putaway_task putaway_task_recommended_location_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.putaway_task
    ADD CONSTRAINT putaway_task_recommended_location_id_fkey FOREIGN KEY (recommended_location_id) REFERENCES mdm.location(location_id);


--
-- Name: putaway_task putaway_task_uom_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.putaway_task
    ADD CONSTRAINT putaway_task_uom_id_fkey FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: recycle_entry recycle_entry_destination_location_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.recycle_entry
    ADD CONSTRAINT recycle_entry_destination_location_id_fkey FOREIGN KEY (destination_location_id) REFERENCES mdm.location(location_id);


--
-- Name: recycle_entry recycle_entry_item_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.recycle_entry
    ADD CONSTRAINT recycle_entry_item_id_fkey FOREIGN KEY (item_id) REFERENCES mdm.item(item_id);


--
-- Name: recycle_entry recycle_entry_lot_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.recycle_entry
    ADD CONSTRAINT recycle_entry_lot_id_fkey FOREIGN KEY (lot_id) REFERENCES trace.lot(lot_id);


--
-- Name: recycle_entry recycle_entry_plant_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.recycle_entry
    ADD CONSTRAINT recycle_entry_plant_id_fkey FOREIGN KEY (plant_id) REFERENCES mdm.plant(plant_id);


--
-- Name: recycle_entry recycle_entry_uom_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.recycle_entry
    ADD CONSTRAINT recycle_entry_uom_id_fkey FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: sales_order sales_order_customer_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.sales_order
    ADD CONSTRAINT sales_order_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES mdm.partner(partner_id);


--
-- Name: sales_order_line sales_order_line_item_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.sales_order_line
    ADD CONSTRAINT sales_order_line_item_id_fkey FOREIGN KEY (item_id) REFERENCES mdm.item(item_id);


--
-- Name: sales_order_line sales_order_line_sales_order_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.sales_order_line
    ADD CONSTRAINT sales_order_line_sales_order_id_fkey FOREIGN KEY (sales_order_id) REFERENCES logistics.sales_order(sales_order_id);


--
-- Name: sales_order_line sales_order_line_uom_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.sales_order_line
    ADD CONSTRAINT sales_order_line_uom_id_fkey FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: sales_order sales_order_ship_to_partner_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.sales_order
    ADD CONSTRAINT sales_order_ship_to_partner_id_fkey FOREIGN KEY (ship_to_partner_id) REFERENCES mdm.partner(partner_id);


--
-- Name: shipment shipment_cancelled_by_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.shipment
    ADD CONSTRAINT shipment_cancelled_by_fkey FOREIGN KEY (cancelled_by) REFERENCES app.app_user(app_user_id);


--
-- Name: shipment shipment_carrier_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.shipment
    ADD CONSTRAINT shipment_carrier_id_fkey FOREIGN KEY (carrier_id) REFERENCES mdm.partner(partner_id);


--
-- Name: shipment shipment_confirmed_by_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.shipment
    ADD CONSTRAINT shipment_confirmed_by_fkey FOREIGN KEY (confirmed_by) REFERENCES app.app_user(app_user_id);


--
-- Name: shipment_line shipment_line_goods_issue_line_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.shipment_line
    ADD CONSTRAINT shipment_line_goods_issue_line_id_fkey FOREIGN KEY (goods_issue_line_id) REFERENCES logistics.goods_issue_line(goods_issue_line_id);


--
-- Name: shipment_line shipment_line_item_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.shipment_line
    ADD CONSTRAINT shipment_line_item_id_fkey FOREIGN KEY (item_id) REFERENCES mdm.item(item_id);


--
-- Name: shipment_line shipment_line_shipment_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.shipment_line
    ADD CONSTRAINT shipment_line_shipment_id_fkey FOREIGN KEY (shipment_id) REFERENCES logistics.shipment(shipment_id);


--
-- Name: shipment_line shipment_line_shipment_request_line_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.shipment_line
    ADD CONSTRAINT shipment_line_shipment_request_line_id_fkey FOREIGN KEY (shipment_request_line_id) REFERENCES logistics.shipment_request_line(shipment_request_line_id);


--
-- Name: shipment_line shipment_line_uom_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.shipment_line
    ADD CONSTRAINT shipment_line_uom_id_fkey FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: shipment shipment_loading_worker_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.shipment
    ADD CONSTRAINT shipment_loading_worker_id_fkey FOREIGN KEY (loading_worker_id) REFERENCES mdm.worker(worker_id);


--
-- Name: shipment_lot_allocation shipment_lot_allocation_handling_unit_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.shipment_lot_allocation
    ADD CONSTRAINT shipment_lot_allocation_handling_unit_id_fkey FOREIGN KEY (handling_unit_id) REFERENCES inventory.handling_unit(handling_unit_id);


--
-- Name: shipment_lot_allocation shipment_lot_allocation_lot_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.shipment_lot_allocation
    ADD CONSTRAINT shipment_lot_allocation_lot_id_fkey FOREIGN KEY (lot_id) REFERENCES trace.lot(lot_id);


--
-- Name: shipment_lot_allocation shipment_lot_allocation_shipment_line_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.shipment_lot_allocation
    ADD CONSTRAINT shipment_lot_allocation_shipment_line_id_fkey FOREIGN KEY (shipment_line_id) REFERENCES logistics.shipment_line(shipment_line_id);


--
-- Name: shipment_lot_allocation shipment_lot_allocation_uom_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.shipment_lot_allocation
    ADD CONSTRAINT shipment_lot_allocation_uom_id_fkey FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: shipment_request shipment_request_customer_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.shipment_request
    ADD CONSTRAINT shipment_request_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES mdm.partner(partner_id);


--
-- Name: shipment_request_line shipment_request_line_item_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.shipment_request_line
    ADD CONSTRAINT shipment_request_line_item_id_fkey FOREIGN KEY (item_id) REFERENCES mdm.item(item_id);


--
-- Name: shipment_request_line shipment_request_line_sales_order_line_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.shipment_request_line
    ADD CONSTRAINT shipment_request_line_sales_order_line_id_fkey FOREIGN KEY (sales_order_line_id) REFERENCES logistics.sales_order_line(sales_order_line_id);


--
-- Name: shipment_request_line shipment_request_line_shipment_request_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.shipment_request_line
    ADD CONSTRAINT shipment_request_line_shipment_request_id_fkey FOREIGN KEY (shipment_request_id) REFERENCES logistics.shipment_request(shipment_request_id);


--
-- Name: shipment_request_line shipment_request_line_uom_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.shipment_request_line
    ADD CONSTRAINT shipment_request_line_uom_id_fkey FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: shipment_request shipment_request_ship_to_partner_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.shipment_request
    ADD CONSTRAINT shipment_request_ship_to_partner_id_fkey FOREIGN KEY (ship_to_partner_id) REFERENCES mdm.partner(partner_id);


--
-- Name: shipment shipment_shipment_request_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.shipment
    ADD CONSTRAINT shipment_shipment_request_id_fkey FOREIGN KEY (shipment_request_id) REFERENCES logistics.shipment_request(shipment_request_id);


--
-- Name: shipment shipment_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.shipment
    ADD CONSTRAINT shipment_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES mdm.warehouse(warehouse_id);


--
-- Name: shopfloor_receipt shopfloor_receipt_destination_location_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.shopfloor_receipt
    ADD CONSTRAINT shopfloor_receipt_destination_location_id_fkey FOREIGN KEY (destination_location_id) REFERENCES mdm.location(location_id);


--
-- Name: shopfloor_receipt shopfloor_receipt_goods_issue_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.shopfloor_receipt
    ADD CONSTRAINT shopfloor_receipt_goods_issue_id_fkey FOREIGN KEY (goods_issue_id) REFERENCES logistics.goods_issue(goods_issue_id);


--
-- Name: shopfloor_receipt_line shopfloor_receipt_line_goods_issue_line_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.shopfloor_receipt_line
    ADD CONSTRAINT shopfloor_receipt_line_goods_issue_line_id_fkey FOREIGN KEY (goods_issue_line_id) REFERENCES logistics.goods_issue_line(goods_issue_line_id);


--
-- Name: shopfloor_receipt_line shopfloor_receipt_line_item_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.shopfloor_receipt_line
    ADD CONSTRAINT shopfloor_receipt_line_item_id_fkey FOREIGN KEY (item_id) REFERENCES mdm.item(item_id);


--
-- Name: shopfloor_receipt_line shopfloor_receipt_line_lot_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.shopfloor_receipt_line
    ADD CONSTRAINT shopfloor_receipt_line_lot_id_fkey FOREIGN KEY (lot_id) REFERENCES trace.lot(lot_id);


--
-- Name: shopfloor_receipt_line shopfloor_receipt_line_shopfloor_receipt_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.shopfloor_receipt_line
    ADD CONSTRAINT shopfloor_receipt_line_shopfloor_receipt_id_fkey FOREIGN KEY (shopfloor_receipt_id) REFERENCES logistics.shopfloor_receipt(shopfloor_receipt_id);


--
-- Name: shopfloor_receipt_line shopfloor_receipt_line_uom_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.shopfloor_receipt_line
    ADD CONSTRAINT shopfloor_receipt_line_uom_id_fkey FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: shopfloor_receipt shopfloor_receipt_work_order_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.shopfloor_receipt
    ADD CONSTRAINT shopfloor_receipt_work_order_id_fkey FOREIGN KEY (work_order_id) REFERENCES production.work_order(work_order_id);


--
-- Name: stock_transfer stock_transfer_from_business_unit_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.stock_transfer
    ADD CONSTRAINT stock_transfer_from_business_unit_id_fkey FOREIGN KEY (from_business_unit_id) REFERENCES mdm.business_unit(business_unit_id);


--
-- Name: stock_transfer stock_transfer_from_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.stock_transfer
    ADD CONSTRAINT stock_transfer_from_warehouse_id_fkey FOREIGN KEY (from_warehouse_id) REFERENCES mdm.warehouse(warehouse_id);


--
-- Name: stock_transfer_line stock_transfer_line_from_location_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.stock_transfer_line
    ADD CONSTRAINT stock_transfer_line_from_location_id_fkey FOREIGN KEY (from_location_id) REFERENCES mdm.location(location_id);


--
-- Name: stock_transfer_line stock_transfer_line_issue_transaction_line_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.stock_transfer_line
    ADD CONSTRAINT stock_transfer_line_issue_transaction_line_id_fkey FOREIGN KEY (issue_transaction_line_id) REFERENCES inventory.inventory_transaction_line(inventory_transaction_line_id);


--
-- Name: stock_transfer_line stock_transfer_line_item_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.stock_transfer_line
    ADD CONSTRAINT stock_transfer_line_item_id_fkey FOREIGN KEY (item_id) REFERENCES mdm.item(item_id);


--
-- Name: stock_transfer_line stock_transfer_line_lot_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.stock_transfer_line
    ADD CONSTRAINT stock_transfer_line_lot_id_fkey FOREIGN KEY (lot_id) REFERENCES trace.lot(lot_id);


--
-- Name: stock_transfer_line stock_transfer_line_receipt_transaction_line_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.stock_transfer_line
    ADD CONSTRAINT stock_transfer_line_receipt_transaction_line_id_fkey FOREIGN KEY (receipt_transaction_line_id) REFERENCES inventory.inventory_transaction_line(inventory_transaction_line_id);


--
-- Name: stock_transfer_line stock_transfer_line_stock_transfer_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.stock_transfer_line
    ADD CONSTRAINT stock_transfer_line_stock_transfer_id_fkey FOREIGN KEY (stock_transfer_id) REFERENCES logistics.stock_transfer(stock_transfer_id);


--
-- Name: stock_transfer_line stock_transfer_line_to_location_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.stock_transfer_line
    ADD CONSTRAINT stock_transfer_line_to_location_id_fkey FOREIGN KEY (to_location_id) REFERENCES mdm.location(location_id);


--
-- Name: stock_transfer_line stock_transfer_line_uom_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.stock_transfer_line
    ADD CONSTRAINT stock_transfer_line_uom_id_fkey FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: stock_transfer stock_transfer_to_business_unit_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.stock_transfer
    ADD CONSTRAINT stock_transfer_to_business_unit_id_fkey FOREIGN KEY (to_business_unit_id) REFERENCES mdm.business_unit(business_unit_id);


--
-- Name: stock_transfer stock_transfer_to_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.stock_transfer
    ADD CONSTRAINT stock_transfer_to_warehouse_id_fkey FOREIGN KEY (to_warehouse_id) REFERENCES mdm.warehouse(warehouse_id);


--
-- Name: subcontract_issue subcontract_issue_goods_issue_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.subcontract_issue
    ADD CONSTRAINT subcontract_issue_goods_issue_id_fkey FOREIGN KEY (goods_issue_id) REFERENCES logistics.goods_issue(goods_issue_id);


--
-- Name: subcontract_issue subcontract_issue_subcontract_order_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.subcontract_issue
    ADD CONSTRAINT subcontract_issue_subcontract_order_id_fkey FOREIGN KEY (subcontract_order_id) REFERENCES logistics.subcontract_order(subcontract_order_id);


--
-- Name: subcontract_order subcontract_order_item_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.subcontract_order
    ADD CONSTRAINT subcontract_order_item_id_fkey FOREIGN KEY (item_id) REFERENCES mdm.item(item_id);


--
-- Name: subcontract_order subcontract_order_partner_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.subcontract_order
    ADD CONSTRAINT subcontract_order_partner_id_fkey FOREIGN KEY (partner_id) REFERENCES mdm.partner(partner_id);


--
-- Name: subcontract_order subcontract_order_process_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.subcontract_order
    ADD CONSTRAINT subcontract_order_process_id_fkey FOREIGN KEY (process_id) REFERENCES mdm.process(process_id);


--
-- Name: subcontract_order subcontract_order_uom_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.subcontract_order
    ADD CONSTRAINT subcontract_order_uom_id_fkey FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: subcontract_order subcontract_order_work_order_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.subcontract_order
    ADD CONSTRAINT subcontract_order_work_order_id_fkey FOREIGN KEY (work_order_id) REFERENCES production.work_order(work_order_id);


--
-- Name: subcontract_receipt subcontract_receipt_goods_receipt_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.subcontract_receipt
    ADD CONSTRAINT subcontract_receipt_goods_receipt_id_fkey FOREIGN KEY (goods_receipt_id) REFERENCES logistics.goods_receipt(goods_receipt_id);


--
-- Name: subcontract_receipt subcontract_receipt_subcontract_order_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.subcontract_receipt
    ADD CONSTRAINT subcontract_receipt_subcontract_order_id_fkey FOREIGN KEY (subcontract_order_id) REFERENCES logistics.subcontract_order(subcontract_order_id);


--
-- Name: subcontract_reconciliation subcontract_reconciliation_confirmed_by_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.subcontract_reconciliation
    ADD CONSTRAINT subcontract_reconciliation_confirmed_by_fkey FOREIGN KEY (confirmed_by) REFERENCES app.app_user(app_user_id);


--
-- Name: subcontract_reconciliation subcontract_reconciliation_subcontract_order_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.subcontract_reconciliation
    ADD CONSTRAINT subcontract_reconciliation_subcontract_order_id_fkey FOREIGN KEY (subcontract_order_id) REFERENCES logistics.subcontract_order(subcontract_order_id);


--
-- Name: subcontract_reconciliation subcontract_reconciliation_uom_id_fkey; Type: FK CONSTRAINT; Schema: logistics; Owner: -
--

ALTER TABLE ONLY logistics.subcontract_reconciliation
    ADD CONSTRAINT subcontract_reconciliation_uom_id_fkey FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: breakdown breakdown_equipment_id_fkey; Type: FK CONSTRAINT; Schema: maintenance; Owner: -
--

ALTER TABLE ONLY maintenance.breakdown
    ADD CONSTRAINT breakdown_equipment_id_fkey FOREIGN KEY (equipment_id) REFERENCES mdm.equipment(equipment_id);


--
-- Name: breakdown breakdown_reported_by_fkey; Type: FK CONSTRAINT; Schema: maintenance; Owner: -
--

ALTER TABLE ONLY maintenance.breakdown
    ADD CONSTRAINT breakdown_reported_by_fkey FOREIGN KEY (reported_by) REFERENCES app.app_user(app_user_id);


--
-- Name: collection_channel collection_channel_equipment_id_fkey; Type: FK CONSTRAINT; Schema: maintenance; Owner: -
--

ALTER TABLE ONLY maintenance.collection_channel
    ADD CONSTRAINT collection_channel_equipment_id_fkey FOREIGN KEY (equipment_id) REFERENCES mdm.equipment(equipment_id);


--
-- Name: collection_channel collection_channel_uom_id_fkey; Type: FK CONSTRAINT; Schema: maintenance; Owner: -
--

ALTER TABLE ONLY maintenance.collection_channel
    ADD CONSTRAINT collection_channel_uom_id_fkey FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: collection_observation collection_observation_collection_channel_id_fkey; Type: FK CONSTRAINT; Schema: maintenance; Owner: -
--

ALTER TABLE ONLY maintenance.collection_observation
    ADD CONSTRAINT collection_observation_collection_channel_id_fkey FOREIGN KEY (collection_channel_id) REFERENCES maintenance.collection_channel(collection_channel_id);


--
-- Name: equipment_downtime equipment_downtime_breakdown_id_fkey; Type: FK CONSTRAINT; Schema: maintenance; Owner: -
--

ALTER TABLE ONLY maintenance.equipment_downtime
    ADD CONSTRAINT equipment_downtime_breakdown_id_fkey FOREIGN KEY (breakdown_id) REFERENCES maintenance.breakdown(breakdown_id);


--
-- Name: equipment_downtime equipment_downtime_closed_by_fkey; Type: FK CONSTRAINT; Schema: maintenance; Owner: -
--

ALTER TABLE ONLY maintenance.equipment_downtime
    ADD CONSTRAINT equipment_downtime_closed_by_fkey FOREIGN KEY (closed_by) REFERENCES app.app_user(app_user_id);


--
-- Name: equipment_downtime equipment_downtime_equipment_id_fkey; Type: FK CONSTRAINT; Schema: maintenance; Owner: -
--

ALTER TABLE ONLY maintenance.equipment_downtime
    ADD CONSTRAINT equipment_downtime_equipment_id_fkey FOREIGN KEY (equipment_id) REFERENCES mdm.equipment(equipment_id);


--
-- Name: equipment_inspection equipment_inspection_equipment_id_fkey; Type: FK CONSTRAINT; Schema: maintenance; Owner: -
--

ALTER TABLE ONLY maintenance.equipment_inspection
    ADD CONSTRAINT equipment_inspection_equipment_id_fkey FOREIGN KEY (equipment_id) REFERENCES mdm.equipment(equipment_id);


--
-- Name: equipment_inspection equipment_inspection_inspected_by_fkey; Type: FK CONSTRAINT; Schema: maintenance; Owner: -
--

ALTER TABLE ONLY maintenance.equipment_inspection
    ADD CONSTRAINT equipment_inspection_inspected_by_fkey FOREIGN KEY (inspected_by) REFERENCES mdm.worker(worker_id);


--
-- Name: equipment_inspection_result equipment_inspection_result_equipment_inspection_id_fkey; Type: FK CONSTRAINT; Schema: maintenance; Owner: -
--

ALTER TABLE ONLY maintenance.equipment_inspection_result
    ADD CONSTRAINT equipment_inspection_result_equipment_inspection_id_fkey FOREIGN KEY (equipment_inspection_id) REFERENCES maintenance.equipment_inspection(equipment_inspection_id);


--
-- Name: equipment_inspection_result equipment_inspection_result_equipment_inspection_item_id_fkey; Type: FK CONSTRAINT; Schema: maintenance; Owner: -
--

ALTER TABLE ONLY maintenance.equipment_inspection_result
    ADD CONSTRAINT equipment_inspection_result_equipment_inspection_item_id_fkey FOREIGN KEY (equipment_inspection_item_id) REFERENCES mdm.equipment_inspection_item(equipment_inspection_item_id);


--
-- Name: maintenance_order maintenance_order_assigned_worker_id_fkey; Type: FK CONSTRAINT; Schema: maintenance; Owner: -
--

ALTER TABLE ONLY maintenance.maintenance_order
    ADD CONSTRAINT maintenance_order_assigned_worker_id_fkey FOREIGN KEY (assigned_worker_id) REFERENCES mdm.worker(worker_id);


--
-- Name: maintenance_order maintenance_order_breakdown_id_fkey; Type: FK CONSTRAINT; Schema: maintenance; Owner: -
--

ALTER TABLE ONLY maintenance.maintenance_order
    ADD CONSTRAINT maintenance_order_breakdown_id_fkey FOREIGN KEY (breakdown_id) REFERENCES maintenance.breakdown(breakdown_id);


--
-- Name: maintenance_order maintenance_order_equipment_id_fkey; Type: FK CONSTRAINT; Schema: maintenance; Owner: -
--

ALTER TABLE ONLY maintenance.maintenance_order
    ADD CONSTRAINT maintenance_order_equipment_id_fkey FOREIGN KEY (equipment_id) REFERENCES mdm.equipment(equipment_id);


--
-- Name: maintenance_result maintenance_result_maintenance_order_id_fkey; Type: FK CONSTRAINT; Schema: maintenance; Owner: -
--

ALTER TABLE ONLY maintenance.maintenance_result
    ADD CONSTRAINT maintenance_result_maintenance_order_id_fkey FOREIGN KEY (maintenance_order_id) REFERENCES maintenance.maintenance_order(maintenance_order_id);


--
-- Name: maintenance_result maintenance_result_performed_by_fkey; Type: FK CONSTRAINT; Schema: maintenance; Owner: -
--

ALTER TABLE ONLY maintenance.maintenance_result
    ADD CONSTRAINT maintenance_result_performed_by_fkey FOREIGN KEY (performed_by) REFERENCES mdm.worker(worker_id);


--
-- Name: planned_stop planned_stop_equipment_id_fkey; Type: FK CONSTRAINT; Schema: maintenance; Owner: -
--

ALTER TABLE ONLY maintenance.planned_stop
    ADD CONSTRAINT planned_stop_equipment_id_fkey FOREIGN KEY (equipment_id) REFERENCES mdm.equipment(equipment_id);


--
-- Name: planned_stop planned_stop_production_line_id_fkey; Type: FK CONSTRAINT; Schema: maintenance; Owner: -
--

ALTER TABLE ONLY maintenance.planned_stop
    ADD CONSTRAINT planned_stop_production_line_id_fkey FOREIGN KEY (production_line_id) REFERENCES mdm.production_line(production_line_id);


--
-- Name: tool_usage tool_usage_equipment_id_fkey; Type: FK CONSTRAINT; Schema: maintenance; Owner: -
--

ALTER TABLE ONLY maintenance.tool_usage
    ADD CONSTRAINT tool_usage_equipment_id_fkey FOREIGN KEY (equipment_id) REFERENCES mdm.equipment(equipment_id);


--
-- Name: tool_usage tool_usage_mold_id_fkey; Type: FK CONSTRAINT; Schema: maintenance; Owner: -
--

ALTER TABLE ONLY maintenance.tool_usage
    ADD CONSTRAINT tool_usage_mold_id_fkey FOREIGN KEY (mold_id) REFERENCES mdm.mold(mold_id);


--
-- Name: tool_usage tool_usage_recorded_by_fkey; Type: FK CONSTRAINT; Schema: maintenance; Owner: -
--

ALTER TABLE ONLY maintenance.tool_usage
    ADD CONSTRAINT tool_usage_recorded_by_fkey FOREIGN KEY (recorded_by) REFERENCES mdm.worker(worker_id);


--
-- Name: tool_usage tool_usage_work_order_id_fkey; Type: FK CONSTRAINT; Schema: maintenance; Owner: -
--

ALTER TABLE ONLY maintenance.tool_usage
    ADD CONSTRAINT tool_usage_work_order_id_fkey FOREIGN KEY (work_order_id) REFERENCES production.work_order(work_order_id);


--
-- Name: business_unit business_unit_legal_entity_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.business_unit
    ADD CONSTRAINT business_unit_legal_entity_id_fkey FOREIGN KEY (legal_entity_id) REFERENCES mdm.legal_entity(legal_entity_id);


--
-- Name: code_value code_value_code_group_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.code_value
    ADD CONSTRAINT code_value_code_group_id_fkey FOREIGN KEY (code_group_id) REFERENCES mdm.code_group(code_group_id);


--
-- Name: department department_business_unit_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.department
    ADD CONSTRAINT department_business_unit_id_fkey FOREIGN KEY (business_unit_id) REFERENCES mdm.business_unit(business_unit_id);


--
-- Name: department department_parent_department_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.department
    ADD CONSTRAINT department_parent_department_id_fkey FOREIGN KEY (parent_department_id) REFERENCES mdm.department(department_id);


--
-- Name: equipment_group_inspection_item equipment_group_inspection_it_equipment_inspection_item_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.equipment_group_inspection_item
    ADD CONSTRAINT equipment_group_inspection_it_equipment_inspection_item_id_fkey FOREIGN KEY (equipment_inspection_item_id) REFERENCES mdm.equipment_inspection_item(equipment_inspection_item_id);


--
-- Name: equipment_group_inspection_item equipment_group_inspection_item_equipment_group_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.equipment_group_inspection_item
    ADD CONSTRAINT equipment_group_inspection_item_equipment_group_id_fkey FOREIGN KEY (equipment_group_id) REFERENCES mdm.equipment_group(equipment_group_id);


--
-- Name: equipment_group_member equipment_group_member_equipment_group_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.equipment_group_member
    ADD CONSTRAINT equipment_group_member_equipment_group_id_fkey FOREIGN KEY (equipment_group_id) REFERENCES mdm.equipment_group(equipment_group_id);


--
-- Name: equipment_group_member equipment_group_member_equipment_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.equipment_group_member
    ADD CONSTRAINT equipment_group_member_equipment_id_fkey FOREIGN KEY (equipment_id) REFERENCES mdm.equipment(equipment_id);


--
-- Name: equipment_group equipment_group_plant_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.equipment_group
    ADD CONSTRAINT equipment_group_plant_id_fkey FOREIGN KEY (plant_id) REFERENCES mdm.plant(plant_id);


--
-- Name: equipment_inspection_item_assignment equipment_inspection_item_ass_equipment_inspection_item_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.equipment_inspection_item_assignment
    ADD CONSTRAINT equipment_inspection_item_ass_equipment_inspection_item_id_fkey FOREIGN KEY (equipment_inspection_item_id) REFERENCES mdm.equipment_inspection_item(equipment_inspection_item_id);


--
-- Name: equipment_inspection_item_assignment equipment_inspection_item_assignment_equipment_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.equipment_inspection_item_assignment
    ADD CONSTRAINT equipment_inspection_item_assignment_equipment_id_fkey FOREIGN KEY (equipment_id) REFERENCES mdm.equipment(equipment_id);


--
-- Name: equipment_inspection_item equipment_inspection_item_uom_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.equipment_inspection_item
    ADD CONSTRAINT equipment_inspection_item_uom_id_fkey FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: equipment equipment_location_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.equipment
    ADD CONSTRAINT equipment_location_id_fkey FOREIGN KEY (location_id) REFERENCES mdm.location(location_id);


--
-- Name: equipment equipment_plant_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.equipment
    ADD CONSTRAINT equipment_plant_id_fkey FOREIGN KEY (plant_id) REFERENCES mdm.plant(plant_id);


--
-- Name: equipment equipment_process_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.equipment
    ADD CONSTRAINT equipment_process_id_fkey FOREIGN KEY (process_id) REFERENCES mdm.process(process_id);


--
-- Name: equipment equipment_production_line_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.equipment
    ADD CONSTRAINT equipment_production_line_id_fkey FOREIGN KEY (production_line_id) REFERENCES mdm.production_line(production_line_id);


--
-- Name: item item_base_uom_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.item
    ADD CONSTRAINT item_base_uom_id_fkey FOREIGN KEY (base_uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: item_bu_item_map item_bu_item_map_from_business_unit_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.item_bu_item_map
    ADD CONSTRAINT item_bu_item_map_from_business_unit_id_fkey FOREIGN KEY (from_business_unit_id) REFERENCES mdm.business_unit(business_unit_id);


--
-- Name: item_bu_item_map item_bu_item_map_from_item_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.item_bu_item_map
    ADD CONSTRAINT item_bu_item_map_from_item_id_fkey FOREIGN KEY (from_item_id) REFERENCES mdm.item(item_id);


--
-- Name: item_bu_item_map item_bu_item_map_to_business_unit_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.item_bu_item_map
    ADD CONSTRAINT item_bu_item_map_to_business_unit_id_fkey FOREIGN KEY (to_business_unit_id) REFERENCES mdm.business_unit(business_unit_id);


--
-- Name: item_bu_item_map item_bu_item_map_to_item_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.item_bu_item_map
    ADD CONSTRAINT item_bu_item_map_to_item_id_fkey FOREIGN KEY (to_item_id) REFERENCES mdm.item(item_id);


--
-- Name: item_external_code item_external_code_item_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.item_external_code
    ADD CONSTRAINT item_external_code_item_id_fkey FOREIGN KEY (item_id) REFERENCES mdm.item(item_id);


--
-- Name: item_external_code item_external_code_partner_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.item_external_code
    ADD CONSTRAINT item_external_code_partner_id_fkey FOREIGN KEY (partner_id) REFERENCES mdm.partner(partner_id);


--
-- Name: item item_lot_storage_uom_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.item
    ADD CONSTRAINT item_lot_storage_uom_id_fkey FOREIGN KEY (lot_storage_uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: item_uom_conversion item_uom_conversion_from_uom_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.item_uom_conversion
    ADD CONSTRAINT item_uom_conversion_from_uom_id_fkey FOREIGN KEY (from_uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: item_uom_conversion item_uom_conversion_item_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.item_uom_conversion
    ADD CONSTRAINT item_uom_conversion_item_id_fkey FOREIGN KEY (item_id) REFERENCES mdm.item(item_id);


--
-- Name: item_uom_conversion item_uom_conversion_to_uom_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.item_uom_conversion
    ADD CONSTRAINT item_uom_conversion_to_uom_id_fkey FOREIGN KEY (to_uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: location location_capacity_uom_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.location
    ADD CONSTRAINT location_capacity_uom_id_fkey FOREIGN KEY (capacity_uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: location location_parent_location_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.location
    ADD CONSTRAINT location_parent_location_id_fkey FOREIGN KEY (parent_location_id) REFERENCES mdm.location(location_id);


--
-- Name: location location_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.location
    ADD CONSTRAINT location_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES mdm.warehouse(warehouse_id);


--
-- Name: mold mold_plant_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.mold
    ADD CONSTRAINT mold_plant_id_fkey FOREIGN KEY (plant_id) REFERENCES mdm.plant(plant_id);


--
-- Name: partner_role partner_role_partner_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.partner_role
    ADD CONSTRAINT partner_role_partner_id_fkey FOREIGN KEY (partner_id) REFERENCES mdm.partner(partner_id);


--
-- Name: plant plant_business_unit_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.plant
    ADD CONSTRAINT plant_business_unit_id_fkey FOREIGN KEY (business_unit_id) REFERENCES mdm.business_unit(business_unit_id);


--
-- Name: plant plant_legal_entity_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.plant
    ADD CONSTRAINT plant_legal_entity_id_fkey FOREIGN KEY (legal_entity_id) REFERENCES mdm.legal_entity(legal_entity_id);


--
-- Name: production_line production_line_parent_line_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.production_line
    ADD CONSTRAINT production_line_parent_line_id_fkey FOREIGN KEY (parent_line_id) REFERENCES mdm.production_line(production_line_id);


--
-- Name: production_line production_line_plant_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.production_line
    ADD CONSTRAINT production_line_plant_id_fkey FOREIGN KEY (plant_id) REFERENCES mdm.plant(plant_id);


--
-- Name: shift shift_plant_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.shift
    ADD CONSTRAINT shift_plant_id_fkey FOREIGN KEY (plant_id) REFERENCES mdm.plant(plant_id);


--
-- Name: spare_part spare_part_base_uom_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.spare_part
    ADD CONSTRAINT spare_part_base_uom_id_fkey FOREIGN KEY (base_uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: spare_part_equipment spare_part_equipment_equipment_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.spare_part_equipment
    ADD CONSTRAINT spare_part_equipment_equipment_id_fkey FOREIGN KEY (equipment_id) REFERENCES mdm.equipment(equipment_id);


--
-- Name: spare_part_equipment spare_part_equipment_spare_part_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.spare_part_equipment
    ADD CONSTRAINT spare_part_equipment_spare_part_id_fkey FOREIGN KEY (spare_part_id) REFERENCES mdm.spare_part(spare_part_id);


--
-- Name: spare_part spare_part_item_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.spare_part
    ADD CONSTRAINT spare_part_item_id_fkey FOREIGN KEY (item_id) REFERENCES mdm.item(item_id);


--
-- Name: terminal terminal_location_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.terminal
    ADD CONSTRAINT terminal_location_id_fkey FOREIGN KEY (location_id) REFERENCES mdm.location(location_id);


--
-- Name: terminal terminal_plant_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.terminal
    ADD CONSTRAINT terminal_plant_id_fkey FOREIGN KEY (plant_id) REFERENCES mdm.plant(plant_id);


--
-- Name: terminal_process terminal_process_process_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.terminal_process
    ADD CONSTRAINT terminal_process_process_id_fkey FOREIGN KEY (process_id) REFERENCES mdm.process(process_id);


--
-- Name: terminal_process terminal_process_terminal_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.terminal_process
    ADD CONSTRAINT terminal_process_terminal_id_fkey FOREIGN KEY (terminal_id) REFERENCES mdm.terminal(terminal_id);


--
-- Name: warehouse warehouse_business_unit_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.warehouse
    ADD CONSTRAINT warehouse_business_unit_id_fkey FOREIGN KEY (business_unit_id) REFERENCES mdm.business_unit(business_unit_id);


--
-- Name: warehouse_layout warehouse_layout_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.warehouse_layout
    ADD CONSTRAINT warehouse_layout_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES mdm.warehouse(warehouse_id);


--
-- Name: warehouse warehouse_partner_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.warehouse
    ADD CONSTRAINT warehouse_partner_id_fkey FOREIGN KEY (partner_id) REFERENCES mdm.partner(partner_id);


--
-- Name: warehouse warehouse_plant_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.warehouse
    ADD CONSTRAINT warehouse_plant_id_fkey FOREIGN KEY (plant_id) REFERENCES mdm.plant(plant_id);


--
-- Name: work_calendar_application work_calendar_application_work_calendar_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.work_calendar_application
    ADD CONSTRAINT work_calendar_application_work_calendar_id_fkey FOREIGN KEY (work_calendar_id) REFERENCES mdm.work_calendar(work_calendar_id);


--
-- Name: work_calendar_day work_calendar_day_work_calendar_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.work_calendar_day
    ADD CONSTRAINT work_calendar_day_work_calendar_id_fkey FOREIGN KEY (work_calendar_id) REFERENCES mdm.work_calendar(work_calendar_id);


--
-- Name: work_calendar work_calendar_plant_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.work_calendar
    ADD CONSTRAINT work_calendar_plant_id_fkey FOREIGN KEY (plant_id) REFERENCES mdm.plant(plant_id);


--
-- Name: worker worker_app_user_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.worker
    ADD CONSTRAINT worker_app_user_id_fkey FOREIGN KEY (app_user_id) REFERENCES app.app_user(app_user_id);


--
-- Name: worker worker_business_unit_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.worker
    ADD CONSTRAINT worker_business_unit_id_fkey FOREIGN KEY (business_unit_id) REFERENCES mdm.business_unit(business_unit_id);


--
-- Name: worker worker_department_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.worker
    ADD CONSTRAINT worker_department_id_fkey FOREIGN KEY (department_id) REFERENCES mdm.department(department_id);


--
-- Name: worker worker_plant_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.worker
    ADD CONSTRAINT worker_plant_id_fkey FOREIGN KEY (plant_id) REFERENCES mdm.plant(plant_id);


--
-- Name: worker_qualification worker_qualification_process_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.worker_qualification
    ADD CONSTRAINT worker_qualification_process_id_fkey FOREIGN KEY (process_id) REFERENCES mdm.process(process_id);


--
-- Name: worker_qualification worker_qualification_worker_id_fkey; Type: FK CONSTRAINT; Schema: mdm; Owner: -
--

ALTER TABLE ONLY mdm.worker_qualification
    ADD CONSTRAINT worker_qualification_worker_id_fkey FOREIGN KEY (worker_id) REFERENCES mdm.worker(worker_id);


--
-- Name: bom bom_base_uom_id_fkey; Type: FK CONSTRAINT; Schema: planning; Owner: -
--

ALTER TABLE ONLY planning.bom
    ADD CONSTRAINT bom_base_uom_id_fkey FOREIGN KEY (base_uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: bom_component bom_component_actual_use_process_id_fkey; Type: FK CONSTRAINT; Schema: planning; Owner: -
--

ALTER TABLE ONLY planning.bom_component
    ADD CONSTRAINT bom_component_actual_use_process_id_fkey FOREIGN KEY (actual_use_process_id) REFERENCES mdm.process(process_id);


--
-- Name: bom_component bom_component_bom_id_fkey; Type: FK CONSTRAINT; Schema: planning; Owner: -
--

ALTER TABLE ONLY planning.bom_component
    ADD CONSTRAINT bom_component_bom_id_fkey FOREIGN KEY (bom_id) REFERENCES planning.bom(bom_id);


--
-- Name: bom_component bom_component_component_item_id_fkey; Type: FK CONSTRAINT; Schema: planning; Owner: -
--

ALTER TABLE ONLY planning.bom_component
    ADD CONSTRAINT bom_component_component_item_id_fkey FOREIGN KEY (component_item_id) REFERENCES mdm.item(item_id);


--
-- Name: bom_component bom_component_routing_operation_id_fkey; Type: FK CONSTRAINT; Schema: planning; Owner: -
--

ALTER TABLE ONLY planning.bom_component
    ADD CONSTRAINT bom_component_routing_operation_id_fkey FOREIGN KEY (routing_operation_id) REFERENCES planning.routing_operation(routing_operation_id);


--
-- Name: bom_component bom_component_uom_id_fkey; Type: FK CONSTRAINT; Schema: planning; Owner: -
--

ALTER TABLE ONLY planning.bom_component
    ADD CONSTRAINT bom_component_uom_id_fkey FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: bom bom_parent_item_id_fkey; Type: FK CONSTRAINT; Schema: planning; Owner: -
--

ALTER TABLE ONLY planning.bom
    ADD CONSTRAINT bom_parent_item_id_fkey FOREIGN KEY (parent_item_id) REFERENCES mdm.item(item_id);


--
-- Name: production_plan fk_production_plan_confirmed_by; Type: FK CONSTRAINT; Schema: planning; Owner: -
--

ALTER TABLE ONLY planning.production_plan
    ADD CONSTRAINT fk_production_plan_confirmed_by FOREIGN KEY (confirmed_by) REFERENCES app.app_user(app_user_id);


--
-- Name: material_substitution_rule material_substitution_rule_bom_component_id_fkey; Type: FK CONSTRAINT; Schema: planning; Owner: -
--

ALTER TABLE ONLY planning.material_substitution_rule
    ADD CONSTRAINT material_substitution_rule_bom_component_id_fkey FOREIGN KEY (bom_component_id) REFERENCES planning.bom_component(bom_component_id);


--
-- Name: material_substitution_rule material_substitution_rule_customer_restriction_id_fkey; Type: FK CONSTRAINT; Schema: planning; Owner: -
--

ALTER TABLE ONLY planning.material_substitution_rule
    ADD CONSTRAINT material_substitution_rule_customer_restriction_id_fkey FOREIGN KEY (customer_restriction_id) REFERENCES mdm.partner(partner_id);


--
-- Name: material_substitution_rule material_substitution_rule_substitute_item_id_fkey; Type: FK CONSTRAINT; Schema: planning; Owner: -
--

ALTER TABLE ONLY planning.material_substitution_rule
    ADD CONSTRAINT material_substitution_rule_substitute_item_id_fkey FOREIGN KEY (substitute_item_id) REFERENCES mdm.item(item_id);


--
-- Name: production_order production_order_business_unit_id_fkey; Type: FK CONSTRAINT; Schema: planning; Owner: -
--

ALTER TABLE ONLY planning.production_order
    ADD CONSTRAINT production_order_business_unit_id_fkey FOREIGN KEY (business_unit_id) REFERENCES mdm.business_unit(business_unit_id);


--
-- Name: production_order production_order_item_id_fkey; Type: FK CONSTRAINT; Schema: planning; Owner: -
--

ALTER TABLE ONLY planning.production_order
    ADD CONSTRAINT production_order_item_id_fkey FOREIGN KEY (item_id) REFERENCES mdm.item(item_id);


--
-- Name: production_order production_order_parent_production_order_id_fkey; Type: FK CONSTRAINT; Schema: planning; Owner: -
--

ALTER TABLE ONLY planning.production_order
    ADD CONSTRAINT production_order_parent_production_order_id_fkey FOREIGN KEY (parent_production_order_id) REFERENCES planning.production_order(production_order_id);


--
-- Name: production_order production_order_plant_id_fkey; Type: FK CONSTRAINT; Schema: planning; Owner: -
--

ALTER TABLE ONLY planning.production_order
    ADD CONSTRAINT production_order_plant_id_fkey FOREIGN KEY (plant_id) REFERENCES mdm.plant(plant_id);


--
-- Name: production_order production_order_uom_id_fkey; Type: FK CONSTRAINT; Schema: planning; Owner: -
--

ALTER TABLE ONLY planning.production_order
    ADD CONSTRAINT production_order_uom_id_fkey FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: production_plan production_plan_bom_id_fkey; Type: FK CONSTRAINT; Schema: planning; Owner: -
--

ALTER TABLE ONLY planning.production_plan
    ADD CONSTRAINT production_plan_bom_id_fkey FOREIGN KEY (bom_id) REFERENCES planning.bom(bom_id);


--
-- Name: production_plan production_plan_planned_line_id_fkey; Type: FK CONSTRAINT; Schema: planning; Owner: -
--

ALTER TABLE ONLY planning.production_plan
    ADD CONSTRAINT production_plan_planned_line_id_fkey FOREIGN KEY (planned_line_id) REFERENCES mdm.production_line(production_line_id);


--
-- Name: production_plan production_plan_production_order_id_fkey; Type: FK CONSTRAINT; Schema: planning; Owner: -
--

ALTER TABLE ONLY planning.production_plan
    ADD CONSTRAINT production_plan_production_order_id_fkey FOREIGN KEY (production_order_id) REFERENCES planning.production_order(production_order_id);


--
-- Name: production_plan production_plan_routing_id_fkey; Type: FK CONSTRAINT; Schema: planning; Owner: -
--

ALTER TABLE ONLY planning.production_plan
    ADD CONSTRAINT production_plan_routing_id_fkey FOREIGN KEY (routing_id) REFERENCES planning.routing(routing_id);


--
-- Name: production_plan production_plan_uom_id_fkey; Type: FK CONSTRAINT; Schema: planning; Owner: -
--

ALTER TABLE ONLY planning.production_plan
    ADD CONSTRAINT production_plan_uom_id_fkey FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: routing routing_item_id_fkey; Type: FK CONSTRAINT; Schema: planning; Owner: -
--

ALTER TABLE ONLY planning.routing
    ADD CONSTRAINT routing_item_id_fkey FOREIGN KEY (item_id) REFERENCES mdm.item(item_id);


--
-- Name: routing_operation_dependency routing_operation_dependency_predecessor_operation_id_fkey; Type: FK CONSTRAINT; Schema: planning; Owner: -
--

ALTER TABLE ONLY planning.routing_operation_dependency
    ADD CONSTRAINT routing_operation_dependency_predecessor_operation_id_fkey FOREIGN KEY (predecessor_operation_id) REFERENCES planning.routing_operation(routing_operation_id);


--
-- Name: routing_operation_dependency routing_operation_dependency_successor_operation_id_fkey; Type: FK CONSTRAINT; Schema: planning; Owner: -
--

ALTER TABLE ONLY planning.routing_operation_dependency
    ADD CONSTRAINT routing_operation_dependency_successor_operation_id_fkey FOREIGN KEY (successor_operation_id) REFERENCES planning.routing_operation(routing_operation_id);


--
-- Name: routing_operation routing_operation_process_id_fkey; Type: FK CONSTRAINT; Schema: planning; Owner: -
--

ALTER TABLE ONLY planning.routing_operation
    ADD CONSTRAINT routing_operation_process_id_fkey FOREIGN KEY (process_id) REFERENCES mdm.process(process_id);


--
-- Name: routing_operation routing_operation_routing_id_fkey; Type: FK CONSTRAINT; Schema: planning; Owner: -
--

ALTER TABLE ONLY planning.routing_operation
    ADD CONSTRAINT routing_operation_routing_id_fkey FOREIGN KEY (routing_id) REFERENCES planning.routing(routing_id);


--
-- Name: work_order fk_work_order_rework_lot; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.work_order
    ADD CONSTRAINT fk_work_order_rework_lot FOREIGN KEY (rework_source_lot_id) REFERENCES trace.lot(lot_id);


--
-- Name: work_order fk_work_order_rework_nc; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.work_order
    ADD CONSTRAINT fk_work_order_rework_nc FOREIGN KEY (rework_source_nonconformance_id) REFERENCES quality.nonconformance(nonconformance_id);


--
-- Name: work_session_event fk_work_session_event_performed_by; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.work_session_event
    ADD CONSTRAINT fk_work_session_event_performed_by FOREIGN KEY (performed_by) REFERENCES app.app_user(app_user_id);


--
-- Name: material_consumption material_consumption_actual_use_process_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.material_consumption
    ADD CONSTRAINT material_consumption_actual_use_process_id_fkey FOREIGN KEY (actual_use_process_id) REFERENCES mdm.process(process_id);


--
-- Name: material_consumption material_consumption_bom_component_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.material_consumption
    ADD CONSTRAINT material_consumption_bom_component_id_fkey FOREIGN KEY (bom_component_id) REFERENCES planning.bom_component(bom_component_id);


--
-- Name: material_consumption material_consumption_corrects_consumption_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.material_consumption
    ADD CONSTRAINT material_consumption_corrects_consumption_id_fkey FOREIGN KEY (corrects_consumption_id) REFERENCES production.material_consumption(material_consumption_id);


--
-- Name: material_consumption material_consumption_entered_uom_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.material_consumption
    ADD CONSTRAINT material_consumption_entered_uom_id_fkey FOREIGN KEY (entered_uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: material_consumption material_consumption_item_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.material_consumption
    ADD CONSTRAINT material_consumption_item_id_fkey FOREIGN KEY (item_id) REFERENCES mdm.item(item_id);


--
-- Name: material_consumption material_consumption_lot_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.material_consumption
    ADD CONSTRAINT material_consumption_lot_id_fkey FOREIGN KEY (lot_id) REFERENCES trace.lot(lot_id);


--
-- Name: material_consumption material_consumption_replaced_consumption_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.material_consumption
    ADD CONSTRAINT material_consumption_replaced_consumption_id_fkey FOREIGN KEY (replaced_consumption_id) REFERENCES production.material_consumption(material_consumption_id);


--
-- Name: material_consumption material_consumption_shopfloor_receipt_line_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.material_consumption
    ADD CONSTRAINT material_consumption_shopfloor_receipt_line_id_fkey FOREIGN KEY (shopfloor_receipt_line_id) REFERENCES logistics.shopfloor_receipt_line(shopfloor_receipt_line_id);


--
-- Name: material_consumption material_consumption_terminal_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.material_consumption
    ADD CONSTRAINT material_consumption_terminal_id_fkey FOREIGN KEY (terminal_id) REFERENCES mdm.terminal(terminal_id);


--
-- Name: material_consumption material_consumption_uom_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.material_consumption
    ADD CONSTRAINT material_consumption_uom_id_fkey FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: material_consumption material_consumption_work_order_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.material_consumption
    ADD CONSTRAINT material_consumption_work_order_id_fkey FOREIGN KEY (work_order_id) REFERENCES production.work_order(work_order_id);


--
-- Name: material_consumption material_consumption_work_session_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.material_consumption
    ADD CONSTRAINT material_consumption_work_session_id_fkey FOREIGN KEY (work_session_id) REFERENCES production.work_session(work_session_id);


--
-- Name: material_consumption material_consumption_worker_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.material_consumption
    ADD CONSTRAINT material_consumption_worker_id_fkey FOREIGN KEY (worker_id) REFERENCES mdm.worker(worker_id);


--
-- Name: material_loss material_loss_item_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.material_loss
    ADD CONSTRAINT material_loss_item_id_fkey FOREIGN KEY (item_id) REFERENCES mdm.item(item_id);


--
-- Name: material_loss material_loss_lot_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.material_loss
    ADD CONSTRAINT material_loss_lot_id_fkey FOREIGN KEY (lot_id) REFERENCES trace.lot(lot_id);


--
-- Name: material_loss material_loss_material_consumption_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.material_loss
    ADD CONSTRAINT material_loss_material_consumption_id_fkey FOREIGN KEY (material_consumption_id) REFERENCES production.material_consumption(material_consumption_id);


--
-- Name: material_loss material_loss_uom_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.material_loss
    ADD CONSTRAINT material_loss_uom_id_fkey FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: material_loss material_loss_work_order_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.material_loss
    ADD CONSTRAINT material_loss_work_order_id_fkey FOREIGN KEY (work_order_id) REFERENCES production.work_order(work_order_id);


--
-- Name: material_return material_return_destination_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.material_return
    ADD CONSTRAINT material_return_destination_warehouse_id_fkey FOREIGN KEY (destination_warehouse_id) REFERENCES mdm.warehouse(warehouse_id);


--
-- Name: material_return_line material_return_line_inventory_transaction_line_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.material_return_line
    ADD CONSTRAINT material_return_line_inventory_transaction_line_id_fkey FOREIGN KEY (inventory_transaction_line_id) REFERENCES inventory.inventory_transaction_line(inventory_transaction_line_id);


--
-- Name: material_return_line material_return_line_item_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.material_return_line
    ADD CONSTRAINT material_return_line_item_id_fkey FOREIGN KEY (item_id) REFERENCES mdm.item(item_id);


--
-- Name: material_return_line material_return_line_lot_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.material_return_line
    ADD CONSTRAINT material_return_line_lot_id_fkey FOREIGN KEY (lot_id) REFERENCES trace.lot(lot_id);


--
-- Name: material_return_line material_return_line_material_return_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.material_return_line
    ADD CONSTRAINT material_return_line_material_return_id_fkey FOREIGN KEY (material_return_id) REFERENCES production.material_return(material_return_id);


--
-- Name: material_return_line material_return_line_uom_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.material_return_line
    ADD CONSTRAINT material_return_line_uom_id_fkey FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: material_return material_return_source_location_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.material_return
    ADD CONSTRAINT material_return_source_location_id_fkey FOREIGN KEY (source_location_id) REFERENCES mdm.location(location_id);


--
-- Name: material_return material_return_work_order_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.material_return
    ADD CONSTRAINT material_return_work_order_id_fkey FOREIGN KEY (work_order_id) REFERENCES production.work_order(work_order_id);


--
-- Name: material_usage_allocation material_usage_allocation_material_consumption_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.material_usage_allocation
    ADD CONSTRAINT material_usage_allocation_material_consumption_id_fkey FOREIGN KEY (material_consumption_id) REFERENCES production.material_consumption(material_consumption_id);


--
-- Name: material_usage_allocation material_usage_allocation_output_lot_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.material_usage_allocation
    ADD CONSTRAINT material_usage_allocation_output_lot_id_fkey FOREIGN KEY (output_lot_id) REFERENCES trace.lot(lot_id);


--
-- Name: material_usage_allocation material_usage_allocation_production_result_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.material_usage_allocation
    ADD CONSTRAINT material_usage_allocation_production_result_id_fkey FOREIGN KEY (production_result_id) REFERENCES production.production_result(production_result_id);


--
-- Name: material_usage_allocation material_usage_allocation_uom_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.material_usage_allocation
    ADD CONSTRAINT material_usage_allocation_uom_id_fkey FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: operation_handover operation_handover_from_work_order_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.operation_handover
    ADD CONSTRAINT operation_handover_from_work_order_id_fkey FOREIGN KEY (from_work_order_id) REFERENCES production.work_order(work_order_id);


--
-- Name: operation_handover_line operation_handover_line_destination_location_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.operation_handover_line
    ADD CONSTRAINT operation_handover_line_destination_location_id_fkey FOREIGN KEY (destination_location_id) REFERENCES mdm.location(location_id);


--
-- Name: operation_handover_line operation_handover_line_operation_handover_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.operation_handover_line
    ADD CONSTRAINT operation_handover_line_operation_handover_id_fkey FOREIGN KEY (operation_handover_id) REFERENCES production.operation_handover(operation_handover_id);


--
-- Name: operation_handover_line operation_handover_line_source_location_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.operation_handover_line
    ADD CONSTRAINT operation_handover_line_source_location_id_fkey FOREIGN KEY (source_location_id) REFERENCES mdm.location(location_id);


--
-- Name: operation_handover_line operation_handover_line_source_lot_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.operation_handover_line
    ADD CONSTRAINT operation_handover_line_source_lot_id_fkey FOREIGN KEY (source_lot_id) REFERENCES trace.lot(lot_id);


--
-- Name: operation_handover_line operation_handover_line_uom_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.operation_handover_line
    ADD CONSTRAINT operation_handover_line_uom_id_fkey FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: operation_handover operation_handover_to_work_order_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.operation_handover
    ADD CONSTRAINT operation_handover_to_work_order_id_fkey FOREIGN KEY (to_work_order_id) REFERENCES production.work_order(work_order_id);


--
-- Name: production_order_acknowledgement production_order_acknowledgement_integration_message_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.production_order_acknowledgement
    ADD CONSTRAINT production_order_acknowledgement_integration_message_id_fkey FOREIGN KEY (integration_message_id) REFERENCES integration.integration_message(integration_message_id);


--
-- Name: production_order_acknowledgement production_order_acknowledgement_production_order_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.production_order_acknowledgement
    ADD CONSTRAINT production_order_acknowledgement_production_order_id_fkey FOREIGN KEY (production_order_id) REFERENCES planning.production_order(production_order_id);


--
-- Name: production_result production_result_corrects_production_result_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.production_result
    ADD CONSTRAINT production_result_corrects_production_result_id_fkey FOREIGN KEY (corrects_production_result_id) REFERENCES production.production_result(production_result_id);


--
-- Name: production_result production_result_equipment_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.production_result
    ADD CONSTRAINT production_result_equipment_id_fkey FOREIGN KEY (equipment_id) REFERENCES mdm.equipment(equipment_id);


--
-- Name: production_result_lot_allocation production_result_lot_allocation_lot_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.production_result_lot_allocation
    ADD CONSTRAINT production_result_lot_allocation_lot_id_fkey FOREIGN KEY (lot_id) REFERENCES trace.lot(lot_id);


--
-- Name: production_result_lot_allocation production_result_lot_allocation_production_result_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.production_result_lot_allocation
    ADD CONSTRAINT production_result_lot_allocation_production_result_id_fkey FOREIGN KEY (production_result_id) REFERENCES production.production_result(production_result_id);


--
-- Name: production_result_lot_allocation production_result_lot_allocation_uom_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.production_result_lot_allocation
    ADD CONSTRAINT production_result_lot_allocation_uom_id_fkey FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: production_result production_result_mold_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.production_result
    ADD CONSTRAINT production_result_mold_id_fkey FOREIGN KEY (mold_id) REFERENCES mdm.mold(mold_id);


--
-- Name: production_result production_result_shift_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.production_result
    ADD CONSTRAINT production_result_shift_id_fkey FOREIGN KEY (shift_id) REFERENCES mdm.shift(shift_id);


--
-- Name: production_result production_result_terminal_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.production_result
    ADD CONSTRAINT production_result_terminal_id_fkey FOREIGN KEY (terminal_id) REFERENCES mdm.terminal(terminal_id);


--
-- Name: production_result production_result_uom_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.production_result
    ADD CONSTRAINT production_result_uom_id_fkey FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: production_result production_result_work_order_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.production_result
    ADD CONSTRAINT production_result_work_order_id_fkey FOREIGN KEY (work_order_id) REFERENCES production.work_order(work_order_id);


--
-- Name: production_result production_result_work_session_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.production_result
    ADD CONSTRAINT production_result_work_session_id_fkey FOREIGN KEY (work_session_id) REFERENCES production.work_session(work_session_id);


--
-- Name: production_result production_result_worker_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.production_result
    ADD CONSTRAINT production_result_worker_id_fkey FOREIGN KEY (worker_id) REFERENCES mdm.worker(worker_id);


--
-- Name: work_order work_order_default_fg_location_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.work_order
    ADD CONSTRAINT work_order_default_fg_location_id_fkey FOREIGN KEY (default_fg_location_id) REFERENCES mdm.location(location_id);


--
-- Name: work_order work_order_default_scrap_location_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.work_order
    ADD CONSTRAINT work_order_default_scrap_location_id_fkey FOREIGN KEY (default_scrap_location_id) REFERENCES mdm.location(location_id);


--
-- Name: work_order work_order_default_wip_location_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.work_order
    ADD CONSTRAINT work_order_default_wip_location_id_fkey FOREIGN KEY (default_wip_location_id) REFERENCES mdm.location(location_id);


--
-- Name: work_order_dependency work_order_dependency_predecessor_work_order_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.work_order_dependency
    ADD CONSTRAINT work_order_dependency_predecessor_work_order_id_fkey FOREIGN KEY (predecessor_work_order_id) REFERENCES production.work_order(work_order_id);


--
-- Name: work_order_dependency work_order_dependency_successor_work_order_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.work_order_dependency
    ADD CONSTRAINT work_order_dependency_successor_work_order_id_fkey FOREIGN KEY (successor_work_order_id) REFERENCES production.work_order(work_order_id);


--
-- Name: work_order work_order_item_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.work_order
    ADD CONSTRAINT work_order_item_id_fkey FOREIGN KEY (item_id) REFERENCES mdm.item(item_id);


--
-- Name: work_order work_order_parent_work_order_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.work_order
    ADD CONSTRAINT work_order_parent_work_order_id_fkey FOREIGN KEY (parent_work_order_id) REFERENCES production.work_order(work_order_id);


--
-- Name: work_order work_order_planned_equipment_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.work_order
    ADD CONSTRAINT work_order_planned_equipment_id_fkey FOREIGN KEY (planned_equipment_id) REFERENCES mdm.equipment(equipment_id);


--
-- Name: work_order work_order_planned_mold_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.work_order
    ADD CONSTRAINT work_order_planned_mold_id_fkey FOREIGN KEY (planned_mold_id) REFERENCES mdm.mold(mold_id);


--
-- Name: work_order work_order_planned_shift_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.work_order
    ADD CONSTRAINT work_order_planned_shift_id_fkey FOREIGN KEY (planned_shift_id) REFERENCES mdm.shift(shift_id);


--
-- Name: work_order work_order_production_line_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.work_order
    ADD CONSTRAINT work_order_production_line_id_fkey FOREIGN KEY (production_line_id) REFERENCES mdm.production_line(production_line_id);


--
-- Name: work_order work_order_production_plan_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.work_order
    ADD CONSTRAINT work_order_production_plan_id_fkey FOREIGN KEY (production_plan_id) REFERENCES planning.production_plan(production_plan_id);


--
-- Name: work_order_resource_assignment work_order_resource_assignment_equipment_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.work_order_resource_assignment
    ADD CONSTRAINT work_order_resource_assignment_equipment_id_fkey FOREIGN KEY (equipment_id) REFERENCES mdm.equipment(equipment_id);


--
-- Name: work_order_resource_assignment work_order_resource_assignment_mold_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.work_order_resource_assignment
    ADD CONSTRAINT work_order_resource_assignment_mold_id_fkey FOREIGN KEY (mold_id) REFERENCES mdm.mold(mold_id);


--
-- Name: work_order_resource_assignment work_order_resource_assignment_shift_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.work_order_resource_assignment
    ADD CONSTRAINT work_order_resource_assignment_shift_id_fkey FOREIGN KEY (shift_id) REFERENCES mdm.shift(shift_id);


--
-- Name: work_order_resource_assignment work_order_resource_assignment_work_order_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.work_order_resource_assignment
    ADD CONSTRAINT work_order_resource_assignment_work_order_id_fkey FOREIGN KEY (work_order_id) REFERENCES production.work_order(work_order_id);


--
-- Name: work_order_resource_assignment work_order_resource_assignment_worker_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.work_order_resource_assignment
    ADD CONSTRAINT work_order_resource_assignment_worker_id_fkey FOREIGN KEY (worker_id) REFERENCES mdm.worker(worker_id);


--
-- Name: work_order work_order_responsible_worker_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.work_order
    ADD CONSTRAINT work_order_responsible_worker_id_fkey FOREIGN KEY (responsible_worker_id) REFERENCES mdm.worker(worker_id);


--
-- Name: work_order work_order_rework_source_work_order_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.work_order
    ADD CONSTRAINT work_order_rework_source_work_order_id_fkey FOREIGN KEY (rework_source_work_order_id) REFERENCES production.work_order(work_order_id);


--
-- Name: work_order work_order_routing_operation_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.work_order
    ADD CONSTRAINT work_order_routing_operation_id_fkey FOREIGN KEY (routing_operation_id) REFERENCES planning.routing_operation(routing_operation_id);


--
-- Name: work_order work_order_uom_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.work_order
    ADD CONSTRAINT work_order_uom_id_fkey FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: work_session work_session_equipment_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.work_session
    ADD CONSTRAINT work_session_equipment_id_fkey FOREIGN KEY (equipment_id) REFERENCES mdm.equipment(equipment_id);


--
-- Name: work_session_event work_session_event_terminal_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.work_session_event
    ADD CONSTRAINT work_session_event_terminal_id_fkey FOREIGN KEY (terminal_id) REFERENCES mdm.terminal(terminal_id);


--
-- Name: work_session_event work_session_event_work_session_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.work_session_event
    ADD CONSTRAINT work_session_event_work_session_id_fkey FOREIGN KEY (work_session_id) REFERENCES production.work_session(work_session_id);


--
-- Name: work_session work_session_mold_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.work_session
    ADD CONSTRAINT work_session_mold_id_fkey FOREIGN KEY (mold_id) REFERENCES mdm.mold(mold_id);


--
-- Name: work_session work_session_shift_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.work_session
    ADD CONSTRAINT work_session_shift_id_fkey FOREIGN KEY (shift_id) REFERENCES mdm.shift(shift_id);


--
-- Name: work_session work_session_terminal_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.work_session
    ADD CONSTRAINT work_session_terminal_id_fkey FOREIGN KEY (terminal_id) REFERENCES mdm.terminal(terminal_id);


--
-- Name: work_session work_session_work_order_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.work_session
    ADD CONSTRAINT work_session_work_order_id_fkey FOREIGN KEY (work_order_id) REFERENCES production.work_order(work_order_id);


--
-- Name: work_session_worker work_session_worker_work_session_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.work_session_worker
    ADD CONSTRAINT work_session_worker_work_session_id_fkey FOREIGN KEY (work_session_id) REFERENCES production.work_session(work_session_id);


--
-- Name: work_session_worker work_session_worker_worker_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.work_session_worker
    ADD CONSTRAINT work_session_worker_worker_id_fkey FOREIGN KEY (worker_id) REFERENCES mdm.worker(worker_id);


--
-- Name: cause_code cause_code_parent_cause_code_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.cause_code
    ADD CONSTRAINT cause_code_parent_cause_code_id_fkey FOREIGN KEY (parent_cause_code_id) REFERENCES quality.cause_code(cause_code_id);


--
-- Name: cause_code cause_code_process_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.cause_code
    ADD CONSTRAINT cause_code_process_id_fkey FOREIGN KEY (process_id) REFERENCES mdm.process(process_id);


--
-- Name: concession concession_allowed_customer_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.concession
    ADD CONSTRAINT concession_allowed_customer_id_fkey FOREIGN KEY (allowed_customer_id) REFERENCES mdm.partner(partner_id);


--
-- Name: concession concession_allowed_process_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.concession
    ADD CONSTRAINT concession_allowed_process_id_fkey FOREIGN KEY (allowed_process_id) REFERENCES mdm.process(process_id);


--
-- Name: concession concession_allowed_work_order_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.concession
    ADD CONSTRAINT concession_allowed_work_order_id_fkey FOREIGN KEY (allowed_work_order_id) REFERENCES production.work_order(work_order_id);


--
-- Name: concession concession_lot_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.concession
    ADD CONSTRAINT concession_lot_id_fkey FOREIGN KEY (lot_id) REFERENCES trace.lot(lot_id);


--
-- Name: concession concession_nonconformance_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.concession
    ADD CONSTRAINT concession_nonconformance_id_fkey FOREIGN KEY (nonconformance_id) REFERENCES quality.nonconformance(nonconformance_id);


--
-- Name: concession concession_uom_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.concession
    ADD CONSTRAINT concession_uom_id_fkey FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: defect_code defect_code_parent_defect_code_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.defect_code
    ADD CONSTRAINT defect_code_parent_defect_code_id_fkey FOREIGN KEY (parent_defect_code_id) REFERENCES quality.defect_code(defect_code_id);


--
-- Name: defect_code_process defect_code_process_defect_code_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.defect_code_process
    ADD CONSTRAINT defect_code_process_defect_code_id_fkey FOREIGN KEY (defect_code_id) REFERENCES quality.defect_code(defect_code_id);


--
-- Name: defect_code defect_code_process_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.defect_code
    ADD CONSTRAINT defect_code_process_id_fkey FOREIGN KEY (process_id) REFERENCES mdm.process(process_id);


--
-- Name: defect_code_process defect_code_process_process_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.defect_code_process
    ADD CONSTRAINT defect_code_process_process_id_fkey FOREIGN KEY (process_id) REFERENCES mdm.process(process_id);


--
-- Name: defect_record defect_record_confirmed_cause_code_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.defect_record
    ADD CONSTRAINT defect_record_confirmed_cause_code_id_fkey FOREIGN KEY (confirmed_cause_code_id) REFERENCES quality.cause_code(cause_code_id);


--
-- Name: defect_record defect_record_defect_code_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.defect_record
    ADD CONSTRAINT defect_record_defect_code_id_fkey FOREIGN KEY (defect_code_id) REFERENCES quality.defect_code(defect_code_id);


--
-- Name: defect_record defect_record_detection_process_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.defect_record
    ADD CONSTRAINT defect_record_detection_process_id_fkey FOREIGN KEY (detection_process_id) REFERENCES mdm.process(process_id);


--
-- Name: defect_record defect_record_equipment_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.defect_record
    ADD CONSTRAINT defect_record_equipment_id_fkey FOREIGN KEY (equipment_id) REFERENCES mdm.equipment(equipment_id);


--
-- Name: defect_record defect_record_inspection_result_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.defect_record
    ADD CONSTRAINT defect_record_inspection_result_id_fkey FOREIGN KEY (inspection_result_id) REFERENCES quality.inspection_result(inspection_result_id);


--
-- Name: defect_record defect_record_lot_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.defect_record
    ADD CONSTRAINT defect_record_lot_id_fkey FOREIGN KEY (lot_id) REFERENCES trace.lot(lot_id);


--
-- Name: defect_record defect_record_mold_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.defect_record
    ADD CONSTRAINT defect_record_mold_id_fkey FOREIGN KEY (mold_id) REFERENCES mdm.mold(mold_id);


--
-- Name: defect_record defect_record_occurrence_process_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.defect_record
    ADD CONSTRAINT defect_record_occurrence_process_id_fkey FOREIGN KEY (occurrence_process_id) REFERENCES mdm.process(process_id);


--
-- Name: defect_record defect_record_production_result_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.defect_record
    ADD CONSTRAINT defect_record_production_result_id_fkey FOREIGN KEY (production_result_id) REFERENCES production.production_result(production_result_id);


--
-- Name: defect_record defect_record_responsible_department_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.defect_record
    ADD CONSTRAINT defect_record_responsible_department_id_fkey FOREIGN KEY (responsible_department_id) REFERENCES mdm.department(department_id);


--
-- Name: defect_record defect_record_suspected_cause_code_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.defect_record
    ADD CONSTRAINT defect_record_suspected_cause_code_id_fkey FOREIGN KEY (suspected_cause_code_id) REFERENCES quality.cause_code(cause_code_id);


--
-- Name: defect_record defect_record_uom_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.defect_record
    ADD CONSTRAINT defect_record_uom_id_fkey FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: defect_record defect_record_work_order_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.defect_record
    ADD CONSTRAINT defect_record_work_order_id_fkey FOREIGN KEY (work_order_id) REFERENCES production.work_order(work_order_id);


--
-- Name: defect_record defect_record_worker_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.defect_record
    ADD CONSTRAINT defect_record_worker_id_fkey FOREIGN KEY (worker_id) REFERENCES mdm.worker(worker_id);


--
-- Name: disposition_decision disposition_decision_decided_by_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.disposition_decision
    ADD CONSTRAINT disposition_decision_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES app.app_user(app_user_id);


--
-- Name: disposition_decision disposition_decision_nonconformance_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.disposition_decision
    ADD CONSTRAINT disposition_decision_nonconformance_id_fkey FOREIGN KEY (nonconformance_id) REFERENCES quality.nonconformance(nonconformance_id);


--
-- Name: disposition_decision disposition_decision_uom_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.disposition_decision
    ADD CONSTRAINT disposition_decision_uom_id_fkey FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: equipment_calibration equipment_calibration_calibrated_by_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.equipment_calibration
    ADD CONSTRAINT equipment_calibration_calibrated_by_fkey FOREIGN KEY (calibrated_by) REFERENCES app.app_user(app_user_id);


--
-- Name: equipment_calibration equipment_calibration_equipment_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.equipment_calibration
    ADD CONSTRAINT equipment_calibration_equipment_id_fkey FOREIGN KEY (equipment_id) REFERENCES mdm.equipment(equipment_id);


--
-- Name: concession fk_concession_approval; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.concession
    ADD CONSTRAINT fk_concession_approval FOREIGN KEY (approval_request_id) REFERENCES app.approval_request(approval_request_id);


--
-- Name: disposition_decision fk_disposition_approval; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.disposition_decision
    ADD CONSTRAINT fk_disposition_approval FOREIGN KEY (approval_request_id) REFERENCES app.approval_request(approval_request_id);


--
-- Name: inspection_item_spec inspection_item_spec_default_inspection_equipment_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.inspection_item_spec
    ADD CONSTRAINT inspection_item_spec_default_inspection_equipment_id_fkey FOREIGN KEY (default_inspection_equipment_id) REFERENCES mdm.equipment(equipment_id);


--
-- Name: inspection_item_spec inspection_item_spec_inspection_plan_version_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.inspection_item_spec
    ADD CONSTRAINT inspection_item_spec_inspection_plan_version_id_fkey FOREIGN KEY (inspection_plan_version_id) REFERENCES quality.inspection_plan_version(inspection_plan_version_id);


--
-- Name: inspection_item_spec inspection_item_spec_uom_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.inspection_item_spec
    ADD CONSTRAINT inspection_item_spec_uom_id_fkey FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: inspection_measurement inspection_measurement_inspection_equipment_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.inspection_measurement
    ADD CONSTRAINT inspection_measurement_inspection_equipment_id_fkey FOREIGN KEY (inspection_equipment_id) REFERENCES mdm.equipment(equipment_id);


--
-- Name: inspection_measurement inspection_measurement_inspection_item_spec_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.inspection_measurement
    ADD CONSTRAINT inspection_measurement_inspection_item_spec_id_fkey FOREIGN KEY (inspection_item_spec_id) REFERENCES quality.inspection_item_spec(inspection_item_spec_id);


--
-- Name: inspection_measurement inspection_measurement_inspection_result_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.inspection_measurement
    ADD CONSTRAINT inspection_measurement_inspection_result_id_fkey FOREIGN KEY (inspection_result_id) REFERENCES quality.inspection_result(inspection_result_id);


--
-- Name: inspection_plan inspection_plan_approved_by_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.inspection_plan
    ADD CONSTRAINT inspection_plan_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES app.app_user(app_user_id);


--
-- Name: inspection_plan inspection_plan_item_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.inspection_plan
    ADD CONSTRAINT inspection_plan_item_id_fkey FOREIGN KEY (item_id) REFERENCES mdm.item(item_id);


--
-- Name: inspection_plan inspection_plan_process_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.inspection_plan
    ADD CONSTRAINT inspection_plan_process_id_fkey FOREIGN KEY (process_id) REFERENCES mdm.process(process_id);


--
-- Name: inspection_plan inspection_plan_routing_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.inspection_plan
    ADD CONSTRAINT inspection_plan_routing_id_fkey FOREIGN KEY (routing_id) REFERENCES planning.routing(routing_id);


--
-- Name: inspection_plan_version inspection_plan_version_inspection_plan_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.inspection_plan_version
    ADD CONSTRAINT inspection_plan_version_inspection_plan_id_fkey FOREIGN KEY (inspection_plan_id) REFERENCES quality.inspection_plan(inspection_plan_id);


--
-- Name: inspection_request inspection_request_inspection_plan_version_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.inspection_request
    ADD CONSTRAINT inspection_request_inspection_plan_version_id_fkey FOREIGN KEY (inspection_plan_version_id) REFERENCES quality.inspection_plan_version(inspection_plan_version_id);


--
-- Name: inspection_request inspection_request_item_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.inspection_request
    ADD CONSTRAINT inspection_request_item_id_fkey FOREIGN KEY (item_id) REFERENCES mdm.item(item_id);


--
-- Name: inspection_request inspection_request_lot_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.inspection_request
    ADD CONSTRAINT inspection_request_lot_id_fkey FOREIGN KEY (lot_id) REFERENCES trace.lot(lot_id);


--
-- Name: inspection_request inspection_request_production_result_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.inspection_request
    ADD CONSTRAINT inspection_request_production_result_id_fkey FOREIGN KEY (production_result_id) REFERENCES production.production_result(production_result_id);


--
-- Name: inspection_request inspection_request_uom_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.inspection_request
    ADD CONSTRAINT inspection_request_uom_id_fkey FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: inspection_request inspection_request_work_order_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.inspection_request
    ADD CONSTRAINT inspection_request_work_order_id_fkey FOREIGN KEY (work_order_id) REFERENCES production.work_order(work_order_id);


--
-- Name: inspection_result inspection_result_inspection_request_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.inspection_result
    ADD CONSTRAINT inspection_result_inspection_request_id_fkey FOREIGN KEY (inspection_request_id) REFERENCES quality.inspection_request(inspection_request_id);


--
-- Name: inspection_result inspection_result_inspector_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.inspection_result
    ADD CONSTRAINT inspection_result_inspector_id_fkey FOREIGN KEY (inspector_id) REFERENCES mdm.worker(worker_id);


--
-- Name: inspection_result inspection_result_previous_result_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.inspection_result
    ADD CONSTRAINT inspection_result_previous_result_id_fkey FOREIGN KEY (previous_result_id) REFERENCES quality.inspection_result(inspection_result_id);


--
-- Name: inspection_result inspection_result_terminal_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.inspection_result
    ADD CONSTRAINT inspection_result_terminal_id_fkey FOREIGN KEY (terminal_id) REFERENCES mdm.terminal(terminal_id);


--
-- Name: inspection_result inspection_result_uom_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.inspection_result
    ADD CONSTRAINT inspection_result_uom_id_fkey FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: nonconformance nonconformance_action_owner_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.nonconformance
    ADD CONSTRAINT nonconformance_action_owner_id_fkey FOREIGN KEY (action_owner_id) REFERENCES app.app_user(app_user_id);


--
-- Name: nonconformance nonconformance_inspection_result_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.nonconformance
    ADD CONSTRAINT nonconformance_inspection_result_id_fkey FOREIGN KEY (inspection_result_id) REFERENCES quality.inspection_result(inspection_result_id);


--
-- Name: nonconformance nonconformance_item_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.nonconformance
    ADD CONSTRAINT nonconformance_item_id_fkey FOREIGN KEY (item_id) REFERENCES mdm.item(item_id);


--
-- Name: nonconformance_lot nonconformance_lot_lot_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.nonconformance_lot
    ADD CONSTRAINT nonconformance_lot_lot_id_fkey FOREIGN KEY (lot_id) REFERENCES trace.lot(lot_id);


--
-- Name: nonconformance_lot nonconformance_lot_nonconformance_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.nonconformance_lot
    ADD CONSTRAINT nonconformance_lot_nonconformance_id_fkey FOREIGN KEY (nonconformance_id) REFERENCES quality.nonconformance(nonconformance_id);


--
-- Name: nonconformance_lot nonconformance_lot_uom_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.nonconformance_lot
    ADD CONSTRAINT nonconformance_lot_uom_id_fkey FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: nonconformance nonconformance_responsible_department_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.nonconformance
    ADD CONSTRAINT nonconformance_responsible_department_id_fkey FOREIGN KEY (responsible_department_id) REFERENCES mdm.department(department_id);


--
-- Name: nonconformance nonconformance_work_order_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.nonconformance
    ADD CONSTRAINT nonconformance_work_order_id_fkey FOREIGN KEY (work_order_id) REFERENCES production.work_order(work_order_id);


--
-- Name: repair_result repair_result_defect_record_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.repair_result
    ADD CONSTRAINT repair_result_defect_record_id_fkey FOREIGN KEY (defect_record_id) REFERENCES quality.defect_record(defect_record_id);


--
-- Name: repair_result repair_result_lot_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.repair_result
    ADD CONSTRAINT repair_result_lot_id_fkey FOREIGN KEY (lot_id) REFERENCES trace.lot(lot_id);


--
-- Name: repair_result repair_result_repaired_by_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.repair_result
    ADD CONSTRAINT repair_result_repaired_by_fkey FOREIGN KEY (repaired_by) REFERENCES mdm.worker(worker_id);


--
-- Name: repair_result repair_result_uom_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.repair_result
    ADD CONSTRAINT repair_result_uom_id_fkey FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: repair_result repair_result_work_order_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.repair_result
    ADD CONSTRAINT repair_result_work_order_id_fkey FOREIGN KEY (work_order_id) REFERENCES production.work_order(work_order_id);


--
-- Name: sorting_result sorting_result_defect_lot_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.sorting_result
    ADD CONSTRAINT sorting_result_defect_lot_id_fkey FOREIGN KEY (defect_lot_id) REFERENCES trace.lot(lot_id);


--
-- Name: sorting_result sorting_result_disposition_decision_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.sorting_result
    ADD CONSTRAINT sorting_result_disposition_decision_id_fkey FOREIGN KEY (disposition_decision_id) REFERENCES quality.disposition_decision(disposition_decision_id);


--
-- Name: sorting_result sorting_result_good_lot_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.sorting_result
    ADD CONSTRAINT sorting_result_good_lot_id_fkey FOREIGN KEY (good_lot_id) REFERENCES trace.lot(lot_id);


--
-- Name: sorting_result sorting_result_uom_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.sorting_result
    ADD CONSTRAINT sorting_result_uom_id_fkey FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: sorting_result sorting_result_worker_id_fkey; Type: FK CONSTRAINT; Schema: quality; Owner: -
--

ALTER TABLE ONLY quality.sorting_result
    ADD CONSTRAINT sorting_result_worker_id_fkey FOREIGN KEY (worker_id) REFERENCES mdm.worker(worker_id);


--
-- Name: impact_analysis impact_analysis_analyzed_by_fkey; Type: FK CONSTRAINT; Schema: trace; Owner: -
--

ALTER TABLE ONLY trace.impact_analysis
    ADD CONSTRAINT impact_analysis_analyzed_by_fkey FOREIGN KEY (analyzed_by) REFERENCES app.app_user(app_user_id);


--
-- Name: impact_analysis impact_analysis_source_lot_id_fkey; Type: FK CONSTRAINT; Schema: trace; Owner: -
--

ALTER TABLE ONLY trace.impact_analysis
    ADD CONSTRAINT impact_analysis_source_lot_id_fkey FOREIGN KEY (source_lot_id) REFERENCES trace.lot(lot_id);


--
-- Name: lot lot_bom_id_fkey; Type: FK CONSTRAINT; Schema: trace; Owner: -
--

ALTER TABLE ONLY trace.lot
    ADD CONSTRAINT lot_bom_id_fkey FOREIGN KEY (bom_id) REFERENCES planning.bom(bom_id);


--
-- Name: lot_external_identifier lot_external_identifier_lot_id_fkey; Type: FK CONSTRAINT; Schema: trace; Owner: -
--

ALTER TABLE ONLY trace.lot_external_identifier
    ADD CONSTRAINT lot_external_identifier_lot_id_fkey FOREIGN KEY (lot_id) REFERENCES trace.lot(lot_id);


--
-- Name: lot_external_identifier lot_external_identifier_partner_id_fkey; Type: FK CONSTRAINT; Schema: trace; Owner: -
--

ALTER TABLE ONLY trace.lot_external_identifier
    ADD CONSTRAINT lot_external_identifier_partner_id_fkey FOREIGN KEY (partner_id) REFERENCES mdm.partner(partner_id);


--
-- Name: lot_hold lot_hold_held_by_fkey; Type: FK CONSTRAINT; Schema: trace; Owner: -
--

ALTER TABLE ONLY trace.lot_hold
    ADD CONSTRAINT lot_hold_held_by_fkey FOREIGN KEY (held_by) REFERENCES app.app_user(app_user_id);


--
-- Name: lot_hold lot_hold_lot_id_fkey; Type: FK CONSTRAINT; Schema: trace; Owner: -
--

ALTER TABLE ONLY trace.lot_hold
    ADD CONSTRAINT lot_hold_lot_id_fkey FOREIGN KEY (lot_id) REFERENCES trace.lot(lot_id);


--
-- Name: lot_hold lot_hold_released_by_fkey; Type: FK CONSTRAINT; Schema: trace; Owner: -
--

ALTER TABLE ONLY trace.lot_hold
    ADD CONSTRAINT lot_hold_released_by_fkey FOREIGN KEY (released_by) REFERENCES app.app_user(app_user_id);


--
-- Name: lot_hold lot_hold_uom_id_fkey; Type: FK CONSTRAINT; Schema: trace; Owner: -
--

ALTER TABLE ONLY trace.lot_hold
    ADD CONSTRAINT lot_hold_uom_id_fkey FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: lot lot_item_id_fkey; Type: FK CONSTRAINT; Schema: trace; Owner: -
--

ALTER TABLE ONLY trace.lot
    ADD CONSTRAINT lot_item_id_fkey FOREIGN KEY (item_id) REFERENCES mdm.item(item_id);


--
-- Name: lot lot_parent_lot_id_fkey; Type: FK CONSTRAINT; Schema: trace; Owner: -
--

ALTER TABLE ONLY trace.lot
    ADD CONSTRAINT lot_parent_lot_id_fkey FOREIGN KEY (parent_lot_id) REFERENCES trace.lot(lot_id);


--
-- Name: lot lot_plant_id_fkey; Type: FK CONSTRAINT; Schema: trace; Owner: -
--

ALTER TABLE ONLY trace.lot
    ADD CONSTRAINT lot_plant_id_fkey FOREIGN KEY (plant_id) REFERENCES mdm.plant(plant_id);


--
-- Name: lot_relation lot_relation_source_lot_id_fkey; Type: FK CONSTRAINT; Schema: trace; Owner: -
--

ALTER TABLE ONLY trace.lot_relation
    ADD CONSTRAINT lot_relation_source_lot_id_fkey FOREIGN KEY (source_lot_id) REFERENCES trace.lot(lot_id);


--
-- Name: lot_relation lot_relation_target_lot_id_fkey; Type: FK CONSTRAINT; Schema: trace; Owner: -
--

ALTER TABLE ONLY trace.lot_relation
    ADD CONSTRAINT lot_relation_target_lot_id_fkey FOREIGN KEY (target_lot_id) REFERENCES trace.lot(lot_id);


--
-- Name: lot_relation lot_relation_uom_id_fkey; Type: FK CONSTRAINT; Schema: trace; Owner: -
--

ALTER TABLE ONLY trace.lot_relation
    ADD CONSTRAINT lot_relation_uom_id_fkey FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: lot_status_event lot_status_event_changed_by_fkey; Type: FK CONSTRAINT; Schema: trace; Owner: -
--

ALTER TABLE ONLY trace.lot_status_event
    ADD CONSTRAINT lot_status_event_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES app.app_user(app_user_id);


--
-- Name: lot_status_event lot_status_event_location_id_fkey; Type: FK CONSTRAINT; Schema: trace; Owner: -
--

ALTER TABLE ONLY trace.lot_status_event
    ADD CONSTRAINT lot_status_event_location_id_fkey FOREIGN KEY (location_id) REFERENCES mdm.location(location_id);


--
-- Name: lot_status_event lot_status_event_lot_id_fkey; Type: FK CONSTRAINT; Schema: trace; Owner: -
--

ALTER TABLE ONLY trace.lot_status_event
    ADD CONSTRAINT lot_status_event_lot_id_fkey FOREIGN KEY (lot_id) REFERENCES trace.lot(lot_id);


--
-- Name: lot lot_uom_id_fkey; Type: FK CONSTRAINT; Schema: trace; Owner: -
--

ALTER TABLE ONLY trace.lot
    ADD CONSTRAINT lot_uom_id_fkey FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id);


--
-- Name: serial_component_relation serial_component_relation_component_serial_number_id_fkey; Type: FK CONSTRAINT; Schema: trace; Owner: -
--

ALTER TABLE ONLY trace.serial_component_relation
    ADD CONSTRAINT serial_component_relation_component_serial_number_id_fkey FOREIGN KEY (component_serial_number_id) REFERENCES trace.serial_number(serial_number_id);


--
-- Name: serial_component_relation serial_component_relation_parent_serial_number_id_fkey; Type: FK CONSTRAINT; Schema: trace; Owner: -
--

ALTER TABLE ONLY trace.serial_component_relation
    ADD CONSTRAINT serial_component_relation_parent_serial_number_id_fkey FOREIGN KEY (parent_serial_number_id) REFERENCES trace.serial_number(serial_number_id);


--
-- Name: serial_component_relation serial_component_relation_work_order_id_fkey; Type: FK CONSTRAINT; Schema: trace; Owner: -
--

ALTER TABLE ONLY trace.serial_component_relation
    ADD CONSTRAINT serial_component_relation_work_order_id_fkey FOREIGN KEY (work_order_id) REFERENCES production.work_order(work_order_id);


--
-- Name: serial_number serial_number_item_id_fkey; Type: FK CONSTRAINT; Schema: trace; Owner: -
--

ALTER TABLE ONLY trace.serial_number
    ADD CONSTRAINT serial_number_item_id_fkey FOREIGN KEY (item_id) REFERENCES mdm.item(item_id);


--
-- Name: serial_number serial_number_lot_id_fkey; Type: FK CONSTRAINT; Schema: trace; Owner: -
--

ALTER TABLE ONLY trace.serial_number
    ADD CONSTRAINT serial_number_lot_id_fkey FOREIGN KEY (lot_id) REFERENCES trace.lot(lot_id);


--
-- PostgreSQL database dump complete
--

\unrestrict S18Cp2LuhfUrg19m1fWC6aO47R0wFK81GLCjxnN80NfDX29bWzNKFbUwIqghSt4

