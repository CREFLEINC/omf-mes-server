-- 생산라인 기본 위치 — 계획 확정으로 W/O 를 만들 때와 4M 에서 라인을 고를 때 W/O 의 기본 위치로 복사한다.
-- 셋 다 NULL 허용(하위 호환) — 비어 있으면 4M 에서 직접 고른다.
ALTER TABLE mdm.production_line
    ADD COLUMN default_wip_location_id   bigint,
    ADD COLUMN default_fg_location_id    bigint,
    ADD COLUMN default_scrap_location_id bigint;

ALTER TABLE mdm.production_line
    ADD CONSTRAINT production_line_default_wip_location_id_fkey
        FOREIGN KEY (default_wip_location_id) REFERENCES mdm.location(location_id),
    ADD CONSTRAINT production_line_default_fg_location_id_fkey
        FOREIGN KEY (default_fg_location_id) REFERENCES mdm.location(location_id),
    ADD CONSTRAINT production_line_default_scrap_location_id_fkey
        FOREIGN KEY (default_scrap_location_id) REFERENCES mdm.location(location_id);
