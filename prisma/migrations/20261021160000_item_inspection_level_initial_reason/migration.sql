-- omf-all-around#64 · 장부 P-85 — 품목을 처음 지정할 때는 사유를 선택 입력으로 한다(담당자 결정 2026-10-21).
-- 수동(MANUAL) 이력 중 최초 지정(이전 수준 없음)만 사유를 비워 둘 수 있다. 수준 변경은 지금처럼 사유 필수.
ALTER TABLE quality.item_inspection_level_history
    DROP CONSTRAINT ck_item_inspection_level_history_reason,
    ADD CONSTRAINT ck_item_inspection_level_history_reason
        CHECK (change_type_code = 'AUTO'
            OR from_level_code IS NULL
            OR (reason IS NOT NULL AND btrim(reason) <> ''));
