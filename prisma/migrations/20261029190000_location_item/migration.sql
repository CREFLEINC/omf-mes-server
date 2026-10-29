-- 위치 품목 제한(사용자 결정 2026-10-29) — 위치마다 지정 품목. 줄이 없으면 제한 없음.
-- 걸어 둔 그 위치에만 적용한다(상위에 걸어도 밑으로 내려가지 않는다). 위치를 지우면 제한도 함께 지운다.
CREATE TABLE mdm.location_item (
    location_id bigint NOT NULL REFERENCES mdm.location(location_id) ON DELETE CASCADE,
    item_id     bigint NOT NULL REFERENCES mdm.item(item_id),
    created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by  bigint,
    CONSTRAINT pk_location_item PRIMARY KEY (location_id, item_id)
);

CREATE INDEX ix_location_item_item ON mdm.location_item (item_id);
