-- omf-all-around#133 · 장부 P-105 — 수준 수동 변경의 사유도 선택 입력으로 한다(담당자 결정 2026-10-22).
-- 사유는 비워 둘 수 있다(NULL). 적었다면 공백만인 값은 막는다. 예전 줄은 모두 이 조건을 만족한다.
ALTER TABLE quality.item_inspection_level_history
    DROP CONSTRAINT ck_item_inspection_level_history_reason,
    ADD CONSTRAINT ck_item_inspection_level_history_reason
        CHECK (reason IS NULL OR btrim(reason) <> '');
