-- 품목을 어느 설비·금형으로 만드는가 — 계획 확정 때 W/O 설비·금형 자동 배정과 4M 추천의 근거다.
-- 공정을 비우면 그 품목의 모든 공정에 쓴다. 설비·금형 중 하나는 있어야 한다.
CREATE TABLE mdm.item_resource_map (
    item_resource_map_id bigserial PRIMARY KEY,
    plant_id             bigint  NOT NULL REFERENCES mdm.plant(plant_id),
    item_id              bigint  NOT NULL REFERENCES mdm.item(item_id),
    process_id           bigint  REFERENCES mdm.process(process_id),
    equipment_id         bigint  REFERENCES mdm.equipment(equipment_id),
    mold_id              bigint  REFERENCES mdm.mold(mold_id),
    is_default           boolean NOT NULL DEFAULT false,
    priority_no          integer NOT NULL DEFAULT 100 CHECK (priority_no >= 0),
    is_active            boolean NOT NULL DEFAULT true,
    remarks              text,
    created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by           bigint REFERENCES app.app_user(app_user_id),
    updated_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by           bigint REFERENCES app.app_user(app_user_id),
    version_no           integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT ck_item_resource_map_target CHECK (equipment_id IS NOT NULL OR mold_id IS NOT NULL)
);

-- 같은 품목·공정·설비·금형 조합은 한 줄이다(공정·설비·금형이 비어도 같은 조합으로 본다).
CREATE UNIQUE INDEX uq_item_resource_map
    ON mdm.item_resource_map (plant_id, item_id, process_id, equipment_id, mold_id) NULLS NOT DISTINCT;

-- 자동 배정이 고를 «기본»은 품목·공정마다 하나다.
CREATE UNIQUE INDEX uq_item_resource_map_default
    ON mdm.item_resource_map (plant_id, item_id, process_id) NULLS NOT DISTINCT
    WHERE is_default AND is_active;

CREATE INDEX ix_item_resource_map_item ON mdm.item_resource_map (item_id);
CREATE INDEX ix_item_resource_map_equipment ON mdm.item_resource_map (equipment_id);
CREATE INDEX ix_item_resource_map_mold ON mdm.item_resource_map (mold_id);
