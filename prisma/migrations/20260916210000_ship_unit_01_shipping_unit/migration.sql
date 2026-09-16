-- SHIP-UNIT-01 — 출하 단위(Shipping Unit) 신설.
--
-- 납품 라벨의 주인을 출하 LOT 배분에서 「출하 단위(상자 1개 이상 묶음)」로 옮긴다. 현행은
-- 배분(제품 LOT × 출하 라인)이 주인이라 **상자 하나에 납품 라벨이 여러 장** 나왔다.
--
-- ⭐ 취급 단위 계층(상위 HU)이 아니라 **별도 개체**다(사용자 결정 2026-09-16). 파렛트를
--    「이동 그룹핑」으로 쓰는 QA #16 과 축이 달라, 계층 깊이를 늘리는 대신 표를 나눈다.
-- ⛔ 이 마이그레이션은 표만 세운다 — 채번 접두어·코드 그룹 값은 뒤 커밋이다.

CREATE TABLE logistics.shipping_unit (
    shipping_unit_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- 납품 라벨 번호로 그대로 쓴다 — 별도 번호를 두지 않는다(배분 `delivery_label_no` 폐기).
    shipping_unit_no        app.business_no_t NOT NULL UNIQUE,
    shipment_id             bigint NOT NULL REFERENCES logistics.shipment(shipment_id),
    shipping_unit_type_code app.code_t NOT NULL,
    -- 편도 OPEN → CLOSED. ⛔ 값 CHECK 를 걸지 않는다 — `handling_unit`·`shipment` 와 같은
    --    관례이고, 그 둘도 코드가 강제한다. 상태축(`transitions.ts`)에도 올리지 않는다
    --    (단순 편도라 `handling_unit.status_code` 가 이미 그 선례다).
    status_code             app.code_t NOT NULL,
    -- ⭐ 「누가 마감했나」는 행위자라 FK 를 건다 — `shipment.confirmed_by` 와 같은 자리다.
    --    `created_by`·`updated_by` 는 감사 칸이라 관례대로 FK 를 걸지 않는다.
    closed_at               timestamptz,
    closed_by               bigint REFERENCES app.app_user(app_user_id),
    created_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by              bigint,
    updated_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by              bigint,
    version_no              integer NOT NULL DEFAULT 1 CHECK (version_no > 0)
);

-- 「그 출하의 출하 단위」가 이 표의 유일한 목록 축이다(화면도 출하를 먼저 고른다).
CREATE INDEX ix_shipping_unit_shipment ON logistics.shipping_unit (shipment_id);

CREATE TABLE logistics.shipping_unit_handling_unit (
    -- ⭐ 상자는 **한 출하 단위에만** 들어간다 — 그 규칙이 곧 PK 다(따로 UNIQUE 를 두지 않는다).
    handling_unit_id bigint PRIMARY KEY REFERENCES inventory.handling_unit(handling_unit_id),
    shipping_unit_id bigint NOT NULL REFERENCES logistics.shipping_unit(shipping_unit_id),
    -- 스캔 순서. 빼기 뒤 재부여하지 않는다 — 재부여하면 화면에 찍힌 번호가 흔들린다.
    seq              integer NOT NULL,
    added_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
    added_by         bigint REFERENCES app.app_user(app_user_id)
);

-- 한 출하 단위의 상자를 스캔 순서로 읽는다(상세 응답·납품 라벨 본문이 이 순서다).
CREATE INDEX ix_shipping_unit_handling_unit_unit
    ON logistics.shipping_unit_handling_unit (shipping_unit_id, seq);
