-- OMF-MES data model v4
--
-- The Raw/Wiki/OpenAPI contract published on 2026-08-25 is newer than the v3
-- physical model.  This migration closes the confirmed gaps without deleting
-- legacy columns or tables.  Broader state transitions are expressed by
-- relaxing constraints; legacy relations remain readable during rollout.

CREATE SCHEMA IF NOT EXISTS maintenance;

-- ---------------------------------------------------------------------------
-- Existing aggregate extensions
-- ---------------------------------------------------------------------------

ALTER TABLE app.user_data_scope
    ADD COLUMN legal_entity_id bigint REFERENCES mdm.legal_entity(legal_entity_id);

ALTER TABLE app.user_data_scope
    DROP CONSTRAINT ck_user_data_scope_target,
    ADD CONSTRAINT ck_user_data_scope_target
        CHECK (legal_entity_id IS NOT NULL OR business_unit_id IS NOT NULL OR plant_id IS NOT NULL);

DROP INDEX app.uq_user_data_scope;
CREATE UNIQUE INDEX uq_user_data_scope
ON app.user_data_scope (
    app_user_id,
    COALESCE(legal_entity_id, 0),
    COALESCE(business_unit_id, 0),
    COALESCE(plant_id, 0)
);

ALTER TABLE app.approval_request
    ADD COLUMN target_summary jsonb,
    ADD COLUMN decided_at timestamptz,
    ADD COLUMN decided_by bigint REFERENCES app.app_user(app_user_id);

ALTER TABLE mdm.item
    ADD COLUMN lot_storage_uom_id bigint REFERENCES mdm.uom(uom_id),
    ADD COLUMN default_lot_size app.qty_t,
    ADD COLUMN is_development_item boolean NOT NULL DEFAULT false,
    ADD COLUMN recycle_type_code app.code_t,
    ADD CONSTRAINT ck_item_default_lot_size
        CHECK (default_lot_size IS NULL OR default_lot_size > 0);

ALTER TABLE mdm.equipment
    ADD COLUMN location_id bigint REFERENCES mdm.location(location_id);

ALTER TABLE planning.routing
    ADD COLUMN is_default boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX uq_routing_default
ON planning.routing (item_id)
WHERE is_default AND status_code = 'ACTIVE';

ALTER TABLE planning.routing_operation
    ADD COLUMN is_subcontract boolean NOT NULL DEFAULT false;

ALTER TABLE quality.inspection_plan
    ADD COLUMN pqc_skip_allowed boolean NOT NULL DEFAULT false,
    ADD COLUMN skip_reason_code app.code_t,
    ADD COLUMN simple_judgment_allowed boolean NOT NULL DEFAULT false;

ALTER TABLE quality.inspection_plan_version
    ADD COLUMN sampling_ratio numeric(9, 6),
    ADD CONSTRAINT ck_inspection_plan_sampling_ratio
        CHECK (sampling_ratio IS NULL OR sampling_ratio BETWEEN 0 AND 1);

ALTER TABLE quality.defect_code
    ADD COLUMN disposition_type_code app.code_t;

ALTER TABLE production.work_order
    ALTER COLUMN production_plan_id DROP NOT NULL,
    ADD COLUMN close_disposition_code app.code_t,
    ADD COLUMN cancellation_reason_code app.code_t;

ALTER TABLE trace.lot
    ADD COLUMN bom_id bigint REFERENCES planning.bom(bom_id),
    ADD COLUMN bom_version integer,
    ADD COLUMN work_order_lot_seq integer,
    DROP CONSTRAINT lot_initial_qty_check,
    ADD CONSTRAINT ck_lot_initial_qty
        CHECK (initial_qty > 0 OR (initial_qty = 0 AND lot_type_code = 'PREISSUED')),
    ADD CONSTRAINT ck_lot_bom_snapshot
        CHECK ((bom_id IS NULL) = (bom_version IS NULL)),
    ADD CONSTRAINT ck_lot_work_order_seq
        CHECK (work_order_lot_seq IS NULL OR work_order_lot_seq > 0);

ALTER TABLE trace.lot_hold
    ADD COLUMN release_reason_code app.code_t;

ALTER TABLE logistics.stock_transfer
    DROP CONSTRAINT ck_stock_transfer_warehouses;

ALTER TABLE logistics.stock_transfer_line
    ADD CONSTRAINT ck_stock_transfer_locations
        CHECK (from_location_id <> to_location_id);

ALTER TABLE logistics.putaway_task
    ADD COLUMN reason_code app.code_t;

ALTER TABLE logistics.material_issue_request
    ADD COLUMN reason_code app.code_t;

ALTER TABLE logistics.goods_issue
    ADD COLUMN approval_request_id bigint REFERENCES app.approval_request(approval_request_id),
    ADD COLUMN cancelled_at timestamptz,
    ADD COLUMN cancelled_by bigint REFERENCES app.app_user(app_user_id),
    ADD COLUMN cancellation_reason_code app.code_t;

ALTER TABLE logistics.goods_receipt_line
    ADD COLUMN expected_qty app.qty_t,
    ADD COLUMN variance_reason_code app.code_t,
    ADD COLUMN variance_note text;

ALTER TABLE logistics.shipment_request
    ADD COLUMN ship_time_slot_start time,
    ADD COLUMN ship_time_slot_end time,
    ADD CONSTRAINT ck_shipment_request_time_slot
        CHECK (ship_time_slot_end IS NULL OR ship_time_slot_start IS NULL
               OR ship_time_slot_end > ship_time_slot_start);

ALTER TABLE logistics.shipment
    ADD COLUMN confirmed_at timestamptz,
    ADD COLUMN confirmed_by bigint REFERENCES app.app_user(app_user_id),
    ADD COLUMN cancelled_at timestamptz,
    ADD COLUMN cancelled_by bigint REFERENCES app.app_user(app_user_id),
    ADD COLUMN cancellation_reason_code app.code_t;

ALTER TABLE logistics.subcontract_issue
    ADD COLUMN status_code app.code_t NOT NULL DEFAULT 'COMPLETED',
    ADD COLUMN version_no integer NOT NULL DEFAULT 1 CHECK (version_no > 0);

ALTER TABLE logistics.subcontract_receipt
    ADD COLUMN status_code app.code_t NOT NULL DEFAULT 'COMPLETED',
    ADD COLUMN version_no integer NOT NULL DEFAULT 1 CHECK (version_no > 0);

ALTER TABLE quality.defect_record
    ALTER COLUMN work_order_id DROP NOT NULL,
    ADD COLUMN source_type_code app.code_t,
    ADD COLUMN source_document_id bigint,
    ADD COLUMN updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    ADD COLUMN updated_by bigint,
    ADD COLUMN version_no integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    DROP CONSTRAINT ck_defect_source,
    ADD CONSTRAINT ck_defect_source CHECK (
        production_result_id IS NOT NULL
        OR inspection_result_id IS NOT NULL
        OR (source_type_code IS NOT NULL AND source_document_id IS NOT NULL)
    );

-- ---------------------------------------------------------------------------
-- Cross-cutting application contract
-- ---------------------------------------------------------------------------

CREATE TABLE app.entity_type_registry (
    entity_type_code       app.code_t PRIMARY KEY,
    schema_name            varchar(63) NOT NULL,
    table_name             varchar(63) NOT NULL,
    id_column_name         varchar(63) NOT NULL,
    is_active              boolean NOT NULL DEFAULT true,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    CONSTRAINT uq_entity_type_table UNIQUE (schema_name, table_name)
);

CREATE TABLE app.localized_text (
    localized_text_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entity_type_code       app.code_t NOT NULL REFERENCES app.entity_type_registry(entity_type_code),
    entity_id              bigint NOT NULL,
    field_code             app.code_t NOT NULL,
    language_code          varchar(10) NOT NULL,
    localized_value        text NOT NULL,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    updated_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by             bigint,
    version_no             integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT uq_localized_text UNIQUE (entity_type_code, entity_id, field_code, language_code)
);

CREATE TABLE app.printer (
    printer_id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    plant_id               bigint NOT NULL REFERENCES mdm.plant(plant_id),
    printer_code           app.code_t NOT NULL,
    printer_name           app.name_t NOT NULL,
    printer_type_code      app.code_t NOT NULL,
    connection_uri         text NOT NULL,
    dpi                    integer CHECK (dpi IS NULL OR dpi > 0),
    is_active              boolean NOT NULL DEFAULT true,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    updated_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by             bigint,
    version_no             integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT uq_printer UNIQUE (plant_id, printer_code)
);

CREATE TABLE app.notification_event (
    notification_event_id  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_type_code        app.code_t NOT NULL,
    aggregate_type_code    app.code_t NOT NULL,
    aggregate_id           bigint NOT NULL,
    occurred_at            timestamptz NOT NULL,
    payload                jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_notification_event UNIQUE (event_type_code, aggregate_type_code, aggregate_id, occurred_at)
);

CREATE TABLE app.notification (
    notification_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    notification_event_id  bigint NOT NULL REFERENCES app.notification_event(notification_event_id),
    recipient_user_id      bigint NOT NULL REFERENCES app.app_user(app_user_id),
    title                  varchar(300) NOT NULL,
    message                text NOT NULL,
    read_at                timestamptz,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_notification_recipient UNIQUE (notification_event_id, recipient_user_id)
);

CREATE INDEX ix_notification_unread
ON app.notification (recipient_user_id, created_at DESC)
WHERE read_at IS NULL;

CREATE TABLE app.notification_subscription (
    notification_subscription_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    app_user_id          bigint NOT NULL REFERENCES app.app_user(app_user_id),
    event_type_code      app.code_t NOT NULL,
    channel_code         app.code_t NOT NULL,
    is_enabled           boolean NOT NULL DEFAULT true,
    created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
    version_no           integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT uq_notification_subscription UNIQUE (app_user_id, event_type_code, channel_code)
);

CREATE TABLE app.notice (
    notice_id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    notice_no             app.business_no_t NOT NULL UNIQUE,
    title                 varchar(300) NOT NULL,
    content               text NOT NULL,
    audience_scope        jsonb NOT NULL DEFAULT '{}'::jsonb,
    status_code           app.code_t NOT NULL DEFAULT 'DRAFT',
    published_at          timestamptz,
    published_by          bigint REFERENCES app.app_user(app_user_id),
    closed_at             timestamptz,
    closed_by             bigint REFERENCES app.app_user(app_user_id),
    created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by            bigint,
    updated_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by            bigint,
    version_no            integer NOT NULL DEFAULT 1 CHECK (version_no > 0)
);

CREATE TABLE app.notice_acknowledgement (
    notice_acknowledgement_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    notice_id              bigint NOT NULL REFERENCES app.notice(notice_id),
    app_user_id            bigint NOT NULL REFERENCES app.app_user(app_user_id),
    acknowledged_at        timestamptz NOT NULL,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_notice_acknowledgement UNIQUE (notice_id, app_user_id)
);

CREATE TABLE app.document_cancellation (
    document_cancellation_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    document_type_code       app.code_t NOT NULL,
    document_id              bigint NOT NULL,
    previous_status_code     app.code_t,
    reason_code              app.code_t NOT NULL,
    reason_detail            text,
    cancelled_at             timestamptz NOT NULL,
    cancelled_by             bigint NOT NULL REFERENCES app.app_user(app_user_id),
    created_at               timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX ix_document_cancellation_target
ON app.document_cancellation (document_type_code, document_id, cancelled_at DESC);

CREATE TABLE app.worker_lease (
    worker_lease_id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    resource_type_code      app.code_t NOT NULL,
    resource_id             bigint NOT NULL,
    owner_user_id           bigint NOT NULL REFERENCES app.app_user(app_user_id),
    lease_token             uuid NOT NULL UNIQUE,
    acquired_at             timestamptz NOT NULL,
    expires_at              timestamptz NOT NULL,
    released_at             timestamptz,
    CONSTRAINT ck_worker_lease_window CHECK (expires_at > acquired_at)
);

CREATE UNIQUE INDEX uq_worker_lease_active
ON app.worker_lease (resource_type_code, resource_id)
WHERE released_at IS NULL;

-- ---------------------------------------------------------------------------
-- Master data and integration configuration
-- ---------------------------------------------------------------------------

CREATE TABLE mdm.warehouse_layout (
    warehouse_layout_id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    warehouse_id           bigint NOT NULL REFERENCES mdm.warehouse(warehouse_id),
    layout_version         integer NOT NULL CHECK (layout_version > 0),
    layout_data            jsonb NOT NULL,
    status_code            app.code_t NOT NULL DEFAULT 'DRAFT',
    effective_from         timestamptz,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    updated_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by             bigint,
    version_no             integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT uq_warehouse_layout UNIQUE (warehouse_id, layout_version)
);

CREATE UNIQUE INDEX uq_warehouse_layout_active
ON mdm.warehouse_layout (warehouse_id)
WHERE status_code = 'ACTIVE';

CREATE TABLE mdm.equipment_group (
    equipment_group_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    plant_id               bigint NOT NULL REFERENCES mdm.plant(plant_id),
    equipment_group_code   app.code_t NOT NULL,
    equipment_group_name   app.name_t NOT NULL,
    is_active              boolean NOT NULL DEFAULT true,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    updated_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by             bigint,
    version_no             integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT uq_equipment_group UNIQUE (plant_id, equipment_group_code)
);

CREATE TABLE mdm.equipment_group_member (
    equipment_group_member_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    equipment_group_id     bigint NOT NULL REFERENCES mdm.equipment_group(equipment_group_id),
    equipment_id           bigint NOT NULL REFERENCES mdm.equipment(equipment_id),
    effective_from         date NOT NULL,
    effective_to           date,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    CONSTRAINT uq_equipment_group_member UNIQUE (equipment_group_id, equipment_id, effective_from),
    CONSTRAINT ck_equipment_group_member_dates CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE TABLE mdm.equipment_inspection_item (
    equipment_inspection_item_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    inspection_item_code  app.code_t NOT NULL UNIQUE,
    inspection_item_name  app.name_t NOT NULL,
    data_type_code        app.code_t NOT NULL,
    uom_id                bigint REFERENCES mdm.uom(uom_id),
    lower_limit           numeric(20, 6),
    upper_limit           numeric(20, 6),
    is_required           boolean NOT NULL DEFAULT true,
    is_active             boolean NOT NULL DEFAULT true,
    created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by            bigint,
    updated_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by            bigint,
    version_no            integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT ck_equipment_inspection_limits
        CHECK (lower_limit IS NULL OR upper_limit IS NULL OR lower_limit <= upper_limit)
);

CREATE TABLE mdm.equipment_group_inspection_item (
    equipment_group_inspection_item_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    equipment_group_id     bigint NOT NULL REFERENCES mdm.equipment_group(equipment_group_id),
    equipment_inspection_item_id bigint NOT NULL REFERENCES mdm.equipment_inspection_item(equipment_inspection_item_id),
    display_order          integer NOT NULL DEFAULT 100,
    is_required_override   boolean,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    CONSTRAINT uq_equipment_group_inspection_item
        UNIQUE (equipment_group_id, equipment_inspection_item_id)
);

CREATE TABLE mdm.equipment_inspection_item_assignment (
    equipment_inspection_item_assignment_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    equipment_id           bigint NOT NULL REFERENCES mdm.equipment(equipment_id),
    equipment_inspection_item_id bigint NOT NULL REFERENCES mdm.equipment_inspection_item(equipment_inspection_item_id),
    display_order          integer NOT NULL DEFAULT 100,
    is_required_override   boolean,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    CONSTRAINT uq_equipment_inspection_item_assignment
        UNIQUE (equipment_id, equipment_inspection_item_id)
);

CREATE TABLE mdm.spare_part (
    spare_part_id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    spare_part_code        app.code_t NOT NULL UNIQUE,
    spare_part_name        app.name_t NOT NULL,
    item_id                bigint REFERENCES mdm.item(item_id),
    base_uom_id            bigint NOT NULL REFERENCES mdm.uom(uom_id),
    minimum_stock_qty      app.qty_t,
    is_active              boolean NOT NULL DEFAULT true,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    updated_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by             bigint,
    version_no             integer NOT NULL DEFAULT 1 CHECK (version_no > 0)
);

CREATE TABLE mdm.spare_part_equipment (
    spare_part_equipment_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    spare_part_id          bigint NOT NULL REFERENCES mdm.spare_part(spare_part_id),
    equipment_id           bigint NOT NULL REFERENCES mdm.equipment(equipment_id),
    recommended_qty        app.qty_t,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    CONSTRAINT uq_spare_part_equipment UNIQUE (spare_part_id, equipment_id)
);

CREATE TABLE mdm.work_calendar (
    work_calendar_id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    plant_id               bigint NOT NULL REFERENCES mdm.plant(plant_id),
    calendar_code          app.code_t NOT NULL,
    calendar_name          app.name_t NOT NULL,
    timezone_name          varchar(100) NOT NULL,
    is_active              boolean NOT NULL DEFAULT true,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    updated_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by             bigint,
    version_no             integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT uq_work_calendar UNIQUE (plant_id, calendar_code)
);

CREATE TABLE mdm.work_calendar_day (
    work_calendar_day_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    work_calendar_id       bigint NOT NULL REFERENCES mdm.work_calendar(work_calendar_id),
    calendar_date          date NOT NULL,
    day_type_code          app.code_t NOT NULL,
    work_start_time        time,
    work_end_time          time,
    remarks                text,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    CONSTRAINT uq_work_calendar_day UNIQUE (work_calendar_id, calendar_date)
);

CREATE TABLE mdm.work_calendar_application (
    work_calendar_application_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    work_calendar_id       bigint NOT NULL REFERENCES mdm.work_calendar(work_calendar_id),
    target_type_code       app.code_t NOT NULL,
    target_id              bigint NOT NULL,
    effective_from         date NOT NULL,
    effective_to           date,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    CONSTRAINT uq_work_calendar_application
        UNIQUE (work_calendar_id, target_type_code, target_id, effective_from),
    CONSTRAINT ck_work_calendar_application_dates
        CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE TABLE integration.interface_definition (
    interface_definition_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    interface_code         app.code_t NOT NULL UNIQUE,
    interface_name         app.name_t NOT NULL,
    direction_code        app.code_t NOT NULL,
    transport_code        app.code_t NOT NULL,
    endpoint_uri          text,
    message_schema        jsonb,
    retry_policy          jsonb NOT NULL DEFAULT '{}'::jsonb,
    is_active             boolean NOT NULL DEFAULT true,
    created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by            bigint,
    updated_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by            bigint,
    version_no            integer NOT NULL DEFAULT 1 CHECK (version_no > 0)
);

CREATE TABLE integration.outbound_item_setting (
    outbound_item_setting_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    interface_definition_id bigint NOT NULL REFERENCES integration.interface_definition(interface_definition_id),
    item_id                bigint NOT NULL REFERENCES mdm.item(item_id),
    is_enabled             boolean NOT NULL DEFAULT true,
    effective_from        timestamptz NOT NULL DEFAULT clock_timestamp(),
    effective_to          timestamptz,
    created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by            bigint,
    CONSTRAINT uq_outbound_item_setting
        UNIQUE (interface_definition_id, item_id, effective_from),
    CONSTRAINT ck_outbound_item_setting_dates
        CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE TABLE integration.record_provenance (
    record_provenance_id  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entity_type_code      app.code_t NOT NULL REFERENCES app.entity_type_registry(entity_type_code),
    entity_id             bigint NOT NULL,
    source_system_code    app.code_t NOT NULL,
    source_record_key     varchar(300),
    received_at           timestamptz NOT NULL,
    integration_message_id bigint REFERENCES integration.integration_message(integration_message_id),
    attributes            jsonb NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT uq_record_provenance
        UNIQUE (entity_type_code, entity_id, source_system_code)
);

-- ---------------------------------------------------------------------------
-- Execution, inventory, quality and trace extensions
-- ---------------------------------------------------------------------------

CREATE TABLE inventory.inventory_adjustment_line (
    inventory_adjustment_line_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    inventory_adjustment_id bigint NOT NULL REFERENCES inventory.inventory_adjustment(inventory_adjustment_id),
    line_no                integer NOT NULL CHECK (line_no > 0),
    location_id            bigint NOT NULL REFERENCES mdm.location(location_id),
    item_id                bigint NOT NULL REFERENCES mdm.item(item_id),
    lot_id                 bigint REFERENCES trace.lot(lot_id),
    quality_status_code    app.code_t NOT NULL,
    inventory_status_code  app.code_t NOT NULL,
    adjustment_qty        app.signed_qty_t NOT NULL CHECK (adjustment_qty <> 0),
    uom_id                 bigint NOT NULL REFERENCES mdm.uom(uom_id),
    reason_code            app.code_t NOT NULL,
    inventory_transaction_line_id bigint REFERENCES inventory.inventory_transaction_line(inventory_transaction_line_id),
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    CONSTRAINT uq_inventory_adjustment_line UNIQUE (inventory_adjustment_id, line_no)
);

CREATE TABLE inventory.handling_unit_reconfiguration (
    handling_unit_reconfiguration_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    reconfiguration_no   app.business_no_t NOT NULL UNIQUE,
    reconfiguration_type_code app.code_t NOT NULL,
    source_handling_unit_id bigint NOT NULL REFERENCES inventory.handling_unit(handling_unit_id),
    target_handling_unit_id bigint NOT NULL REFERENCES inventory.handling_unit(handling_unit_id),
    reason_code           app.code_t NOT NULL,
    performed_at          timestamptz NOT NULL,
    performed_by          bigint REFERENCES app.app_user(app_user_id),
    created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT ck_handling_unit_reconfiguration_distinct
        CHECK (source_handling_unit_id <> target_handling_unit_id)
);

CREATE TABLE inventory.handling_unit_reconfiguration_line (
    handling_unit_reconfiguration_line_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    handling_unit_reconfiguration_id bigint NOT NULL
        REFERENCES inventory.handling_unit_reconfiguration(handling_unit_reconfiguration_id),
    line_no                integer NOT NULL CHECK (line_no > 0),
    item_id                bigint NOT NULL REFERENCES mdm.item(item_id),
    lot_id                 bigint NOT NULL REFERENCES trace.lot(lot_id),
    moved_qty              app.qty_t NOT NULL CHECK (moved_qty > 0),
    uom_id                 bigint NOT NULL REFERENCES mdm.uom(uom_id),
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_handling_unit_reconfiguration_line
        UNIQUE (handling_unit_reconfiguration_id, line_no)
);

CREATE TABLE production.work_order_resource_assignment (
    work_order_resource_assignment_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    work_order_id          bigint NOT NULL REFERENCES production.work_order(work_order_id),
    resource_type_code     app.code_t NOT NULL,
    equipment_id           bigint REFERENCES mdm.equipment(equipment_id),
    mold_id                bigint REFERENCES mdm.mold(mold_id),
    worker_id              bigint REFERENCES mdm.worker(worker_id),
    shift_id               bigint REFERENCES mdm.shift(shift_id),
    planned_start_at       timestamptz,
    planned_end_at         timestamptz,
    assignment_status_code app.code_t NOT NULL DEFAULT 'PLANNED',
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    updated_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by             bigint,
    version_no             integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT ck_work_order_resource_target
        CHECK (num_nonnulls(equipment_id, mold_id, worker_id, shift_id) = 1),
    CONSTRAINT ck_work_order_resource_window
        CHECK (planned_end_at IS NULL OR planned_start_at IS NULL OR planned_end_at >= planned_start_at)
);

CREATE INDEX ix_work_order_resource_assignment
ON production.work_order_resource_assignment (work_order_id, resource_type_code);

CREATE TABLE production.production_order_acknowledgement (
    production_order_acknowledgement_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    production_order_id    bigint NOT NULL REFERENCES planning.production_order(production_order_id),
    acknowledgement_type_code app.code_t NOT NULL,
    upstream_version       varchar(100),
    received_at            timestamptz NOT NULL,
    acknowledged_at        timestamptz,
    status_code            app.code_t NOT NULL,
    details                jsonb NOT NULL DEFAULT '{}'::jsonb,
    integration_message_id bigint REFERENCES integration.integration_message(integration_message_id),
    CONSTRAINT uq_production_order_ack
        UNIQUE (production_order_id, acknowledgement_type_code, received_at)
);

CREATE TABLE quality.defect_code_process (
    defect_code_process_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    defect_code_id         bigint NOT NULL REFERENCES quality.defect_code(defect_code_id),
    process_id             bigint NOT NULL REFERENCES mdm.process(process_id),
    is_primary             boolean NOT NULL DEFAULT false,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    CONSTRAINT uq_defect_code_process UNIQUE (defect_code_id, process_id)
);

CREATE UNIQUE INDEX uq_defect_code_primary_process
ON quality.defect_code_process (defect_code_id)
WHERE is_primary;

CREATE TABLE quality.repair_result (
    repair_result_id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    repair_result_no       app.business_no_t NOT NULL UNIQUE,
    defect_record_id       bigint NOT NULL REFERENCES quality.defect_record(defect_record_id),
    work_order_id          bigint REFERENCES production.work_order(work_order_id),
    lot_id                 bigint REFERENCES trace.lot(lot_id),
    repair_type_code       app.code_t NOT NULL,
    repair_qty             app.qty_t NOT NULL CHECK (repair_qty > 0),
    uom_id                 bigint NOT NULL REFERENCES mdm.uom(uom_id),
    result_code            app.code_t NOT NULL,
    repaired_at            timestamptz NOT NULL,
    repaired_by            bigint REFERENCES mdm.worker(worker_id),
    remarks                text,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    updated_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by             bigint,
    version_no             integer NOT NULL DEFAULT 1 CHECK (version_no > 0)
);

CREATE TABLE trace.lot_status_event (
    lot_status_event_id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    lot_id                 bigint NOT NULL REFERENCES trace.lot(lot_id),
    location_id            bigint REFERENCES mdm.location(location_id),
    quality_status_code    app.code_t,
    inventory_status_code  app.code_t,
    previous_status_code   app.code_t,
    new_status_code        app.code_t NOT NULL,
    reason_code            app.code_t,
    source_document_type_code app.code_t NOT NULL,
    source_document_id     bigint NOT NULL,
    changed_at             timestamptz NOT NULL,
    changed_by             bigint REFERENCES app.app_user(app_user_id),
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX ix_lot_status_event_lot
ON trace.lot_status_event (lot_id, changed_at DESC);

CREATE TABLE logistics.recycle_entry (
    recycle_entry_id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    recycle_entry_no       app.business_no_t NOT NULL UNIQUE,
    plant_id               bigint NOT NULL REFERENCES mdm.plant(plant_id),
    item_id                bigint NOT NULL REFERENCES mdm.item(item_id),
    lot_id                 bigint REFERENCES trace.lot(lot_id),
    source_document_type_code app.code_t NOT NULL,
    source_document_id     bigint NOT NULL,
    recycle_type_code      app.code_t NOT NULL,
    recycle_qty            app.qty_t NOT NULL CHECK (recycle_qty > 0),
    uom_id                 bigint NOT NULL REFERENCES mdm.uom(uom_id),
    destination_location_id bigint REFERENCES mdm.location(location_id),
    status_code            app.code_t NOT NULL,
    processed_at           timestamptz,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    updated_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by             bigint,
    version_no             integer NOT NULL DEFAULT 1 CHECK (version_no > 0)
);

-- ---------------------------------------------------------------------------
-- Equipment maintenance execution
-- ---------------------------------------------------------------------------

CREATE TABLE maintenance.equipment_inspection (
    equipment_inspection_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    inspection_no          app.business_no_t NOT NULL UNIQUE,
    equipment_id           bigint NOT NULL REFERENCES mdm.equipment(equipment_id),
    inspection_type_code   app.code_t NOT NULL,
    scheduled_at           timestamptz,
    inspected_at           timestamptz,
    inspected_by           bigint REFERENCES mdm.worker(worker_id),
    judgment_code          app.code_t,
    status_code            app.code_t NOT NULL,
    remarks                text,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    updated_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by             bigint,
    version_no             integer NOT NULL DEFAULT 1 CHECK (version_no > 0)
);

CREATE TABLE maintenance.equipment_inspection_result (
    equipment_inspection_result_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    equipment_inspection_id bigint NOT NULL REFERENCES maintenance.equipment_inspection(equipment_inspection_id),
    equipment_inspection_item_id bigint NOT NULL REFERENCES mdm.equipment_inspection_item(equipment_inspection_item_id),
    numeric_value          numeric(20, 6),
    text_value             text,
    boolean_value          boolean,
    judgment_code          app.code_t NOT NULL,
    remarks                text,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    CONSTRAINT uq_equipment_inspection_result
        UNIQUE (equipment_inspection_id, equipment_inspection_item_id),
    CONSTRAINT ck_equipment_inspection_result_value
        CHECK (num_nonnulls(numeric_value, text_value, boolean_value) <= 1)
);

CREATE TABLE maintenance.breakdown (
    breakdown_id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    breakdown_no           app.business_no_t NOT NULL UNIQUE,
    equipment_id           bigint NOT NULL REFERENCES mdm.equipment(equipment_id),
    reported_at            timestamptz NOT NULL,
    reported_by            bigint REFERENCES app.app_user(app_user_id),
    symptom_code           app.code_t,
    description            text NOT NULL,
    severity_code          app.code_t NOT NULL,
    status_code            app.code_t NOT NULL,
    started_at             timestamptz,
    completed_at           timestamptz,
    root_cause             text,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    updated_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by             bigint,
    version_no             integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT ck_breakdown_window CHECK (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at)
);

CREATE TABLE maintenance.maintenance_order (
    maintenance_order_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    maintenance_order_no   app.business_no_t NOT NULL UNIQUE,
    equipment_id           bigint NOT NULL REFERENCES mdm.equipment(equipment_id),
    breakdown_id           bigint REFERENCES maintenance.breakdown(breakdown_id),
    order_type_code        app.code_t NOT NULL,
    priority_code          app.code_t NOT NULL,
    scheduled_start_at     timestamptz,
    scheduled_end_at       timestamptz,
    assigned_worker_id     bigint REFERENCES mdm.worker(worker_id),
    status_code            app.code_t NOT NULL,
    cancellation_reason_code app.code_t,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    updated_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by             bigint,
    version_no             integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT ck_maintenance_order_window
        CHECK (scheduled_end_at IS NULL OR scheduled_start_at IS NULL OR scheduled_end_at >= scheduled_start_at)
);

CREATE TABLE maintenance.maintenance_result (
    maintenance_result_id  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    maintenance_order_id   bigint NOT NULL REFERENCES maintenance.maintenance_order(maintenance_order_id),
    result_seq             integer NOT NULL CHECK (result_seq > 0),
    action_code            app.code_t NOT NULL,
    action_description     text NOT NULL,
    started_at             timestamptz NOT NULL,
    completed_at           timestamptz NOT NULL,
    performed_by           bigint REFERENCES mdm.worker(worker_id),
    result_code            app.code_t NOT NULL,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    CONSTRAINT uq_maintenance_result UNIQUE (maintenance_order_id, result_seq),
    CONSTRAINT ck_maintenance_result_window CHECK (completed_at >= started_at)
);

CREATE TABLE maintenance.equipment_downtime (
    equipment_downtime_id  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    equipment_id           bigint NOT NULL REFERENCES mdm.equipment(equipment_id),
    breakdown_id           bigint REFERENCES maintenance.breakdown(breakdown_id),
    downtime_type_code     app.code_t NOT NULL,
    started_at             timestamptz NOT NULL,
    ended_at               timestamptz,
    reason_code            app.code_t,
    closed_by              bigint REFERENCES app.app_user(app_user_id),
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    CONSTRAINT ck_equipment_downtime_window CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE INDEX ix_equipment_downtime_open
ON maintenance.equipment_downtime (equipment_id, started_at DESC)
WHERE ended_at IS NULL;

CREATE TABLE maintenance.planned_stop (
    planned_stop_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    equipment_id           bigint REFERENCES mdm.equipment(equipment_id),
    production_line_id     bigint REFERENCES mdm.production_line(production_line_id),
    stop_type_code         app.code_t NOT NULL,
    planned_start_at       timestamptz NOT NULL,
    planned_end_at         timestamptz NOT NULL,
    reason                 text,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    updated_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by             bigint,
    version_no             integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT ck_planned_stop_target CHECK (num_nonnulls(equipment_id, production_line_id) = 1),
    CONSTRAINT ck_planned_stop_window CHECK (planned_end_at > planned_start_at)
);

CREATE TABLE maintenance.tool_usage (
    tool_usage_id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    mold_id                bigint NOT NULL REFERENCES mdm.mold(mold_id),
    equipment_id           bigint REFERENCES mdm.equipment(equipment_id),
    work_order_id          bigint REFERENCES production.work_order(work_order_id),
    usage_type_code        app.code_t NOT NULL,
    shot_count             bigint CHECK (shot_count IS NULL OR shot_count >= 0),
    used_from              timestamptz NOT NULL,
    used_to                timestamptz,
    recorded_by            bigint REFERENCES mdm.worker(worker_id),
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT ck_tool_usage_window CHECK (used_to IS NULL OR used_to >= used_from)
);

CREATE TABLE maintenance.collection_channel (
    collection_channel_id  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    equipment_id           bigint NOT NULL REFERENCES mdm.equipment(equipment_id),
    channel_code           app.code_t NOT NULL,
    channel_name           app.name_t NOT NULL,
    data_type_code         app.code_t NOT NULL,
    uom_id                 bigint REFERENCES mdm.uom(uom_id),
    collection_interval_sec integer CHECK (collection_interval_sec IS NULL OR collection_interval_sec > 0),
    lower_limit            numeric(20, 6),
    upper_limit            numeric(20, 6),
    is_active              boolean NOT NULL DEFAULT true,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by             bigint,
    updated_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by             bigint,
    version_no             integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT uq_collection_channel UNIQUE (equipment_id, channel_code),
    CONSTRAINT ck_collection_channel_limits CHECK (lower_limit IS NULL OR upper_limit IS NULL OR lower_limit <= upper_limit)
);

CREATE TABLE maintenance.collection_observation (
    collection_observation_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    collection_channel_id bigint NOT NULL REFERENCES maintenance.collection_channel(collection_channel_id),
    observed_at            timestamptz NOT NULL,
    numeric_value          numeric(20, 6),
    text_value             text,
    boolean_value          boolean,
    quality_code           app.code_t,
    source_message_id      varchar(200),
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_collection_observation UNIQUE (collection_channel_id, observed_at, source_message_id),
    CONSTRAINT ck_collection_observation_value
        CHECK (num_nonnulls(numeric_value, text_value, boolean_value) = 1)
);

CREATE INDEX ix_collection_observation_channel_time
ON maintenance.collection_observation (collection_channel_id, observed_at DESC);

-- Indexes for newly introduced foreign-key access paths.
CREATE INDEX ix_user_data_scope_legal_entity ON app.user_data_scope (legal_entity_id);
CREATE INDEX ix_equipment_location ON mdm.equipment (location_id);
CREATE INDEX ix_lot_bom ON trace.lot (bom_id);
CREATE INDEX ix_goods_issue_approval_request ON logistics.goods_issue (approval_request_id);
CREATE INDEX ix_record_provenance_message ON integration.record_provenance (integration_message_id);
CREATE INDEX ix_inventory_adjustment_line_header ON inventory.inventory_adjustment_line (inventory_adjustment_id);
CREATE INDEX ix_repair_result_defect ON quality.repair_result (defect_record_id);
CREATE INDEX ix_recycle_entry_source ON logistics.recycle_entry (source_document_type_code, source_document_id);
