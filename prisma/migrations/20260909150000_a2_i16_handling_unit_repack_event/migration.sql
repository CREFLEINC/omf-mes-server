-- I-16 · 계약 `GET /inventory/handling-units/{handlingUnitId}/repack-events` 의
-- HandlingUnitRepackEvent(+Line) 을 담는다. 계약 «세 곳»이 「저장 테이블은 데이터 모델
-- 담당에게 통지 — 기다리지 않는다」라 적었고, 물리에 그 모양의 표가 없다. 통보 140.
-- ⛔ inventory.handling_unit_reconfiguration 은 이름만 비슷하다 — 라인이 계약 필수 6칸 중
--    4칸(handling_unit_id·role_code·qty_before·qty_after)을 잃고, 헤더
--    ck_handling_unit_reconfiguration_distinct(source <> target) 가 계약의 대표 경로
--    (한 HU 의 PUT …/contents = source ≡ target)를 «구조적으로» 막는다.
--    그 표는 손대지 않는다 — 0행이고 src/·test/ 참조 0건이라 삭제도 완화도 없다.
-- ⇒ 추가만. 완화 0 · 삭제 0 · 백필 0 · 순서 의존 0 (lanes.md §1-2 · CLAUDE.md forward-only).
--
-- 사전 대조(적용 «전» · 읽기만 · 이 마이그가 아무것도 덮지 않음을 확인한다):
--   SELECT to_regclass('inventory.handling_unit_repack_event');       -- NULL 이어야 한다
--   SELECT to_regclass('inventory.handling_unit_repack_event_line');  -- NULL 이어야 한다
--   SELECT count(*) FROM inventory.handling_unit_reconfiguration;     -- 0 (손대지 않는다)

CREATE TABLE inventory.handling_unit_repack_event (
    handling_unit_repack_event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- 계약 enum 3값(MERGE·SPLIT·RECONFIGURE · x-code-key CD-REPACK-TYPE).
    -- ⛔ CHECK 를 걸지 않는다 — mdm.code_group 에 CD-REPACK-TYPE 이 0건이고 «요청 본문에
    --    입력 자리가 아예 없어» 서버가 'RECONFIGURE' 로 고정한다.
    repack_type_code    app.code_t  NOT NULL,
    -- 계약 required. 주체는 계정 세션이다(plan.md §5 규칙 9) — X-Worker-No 는 mdm.worker
    -- 축이라 이 칸에 못 들어간다. 403 선언이 있어 세션 부재 경로가 없으므로 NOT NULL 이다.
    performed_by        bigint      NOT NULL REFERENCES app.app_user(app_user_id),
    -- ⛔ DEFAULT 를 주지 않는다 — 계약 required 이자 정렬 1차 축이라 서버가 명시로 싣는다.
    occurred_at         timestamptz NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE inventory.handling_unit_repack_event_line (
    handling_unit_repack_event_line_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    handling_unit_repack_event_id bigint NOT NULL
        REFERENCES inventory.handling_unit_repack_event(handling_unit_repack_event_id),
    -- 계약에 없는 칸. 계약이 lines 배열의 «순서»를 응답에 담는데 정렬 축이 없으면
    -- Prisma 가 순서를 약속하지 않는다(I-24 R-7). 저장소의 모든 _line 표와 같은 모양.
    line_no             integer     NOT NULL CHECK (line_no > 0),
    handling_unit_id    bigint      NOT NULL REFERENCES inventory.handling_unit(handling_unit_id),
    -- 계약 enum 2값(SOURCE·RESULT · x-code-key CD-ROLE). CHECK 없음 — 위와 같은 이유.
    role_code           app.code_t  NOT NULL,
    item_id             bigint      NOT NULL REFERENCES mdm.item(item_id),
    lot_id              bigint      NOT NULL REFERENCES trace.lot(lot_id),
    -- app.qty_t 는 CHECK (VALUE >= 0) 라 0 이 담긴다 — 새로 생긴 줄의 qty_before 와 빠진
    -- 줄의 qty_after 가 0 이다. ⛔ handling_unit_content.qty 의 CHECK (qty > 0) 와 «다른»
    --    규칙인 것이 의도다(이쪽은 «이력»이라 0 이 사실이다).
    qty_before          app.qty_t   NOT NULL,
    qty_after           app.qty_t   NOT NULL,
    -- ⭐ 계약 라인에 uomId 가 «없는데»(HandlingUnitRepackEventLine.required 6칸) 요청은
    --    HandlingUnitContentUpsert.required 로 uomId 를 «받는다». 그래서 같은
    --    (item, lot) 의 단위만 바뀌는 치환이 실제로 들어오는데 — uq_handling_unit_content
    --    가 (handling_unit_id, item_id, lot_id) 라 그 치환이 허용된다 — 이력에는
    --    qty_before == qty_after 로만 남아 「변화 없음」으로 보인다.
    --    ⛔ 지금 안 만들면 forward-only 라 «그 사이 기록된 이력은 영구 복구 불가»다.
    --    응답에는 싣지 않는다(계약 라인에 칸이 없다) — 서버가 채우고 서버만 읽는다. 통보 165.
    uom_id_before       bigint      NULL REFERENCES mdm.uom(uom_id),
    uom_id_after        bigint      NULL REFERENCES mdm.uom(uom_id),
    created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_handling_unit_repack_event_line
        UNIQUE (handling_unit_repack_event_id, line_no)
);

-- GET …/{handlingUnitId}/repack-events 의 «유일한» 축이자 커버링 인덱스.
-- 헤더에 handling_unit_id 를 두지 않은 이유: MERGE 는 원본이 여럿이라 헤더 한 칸으로
-- 못 가리키고, 라인이 이미 전건을 담는다(계약 라인 handlingUnitId required).
CREATE INDEX ix_handling_unit_repack_event_line_hu
    ON inventory.handling_unit_repack_event_line (handling_unit_id, handling_unit_repack_event_id);
