-- 피처 019 반납 입고(omf-all-around#367) — 적치 대기로 받은 반납 줄(POP 반납 전부·PDA 에서 위치를 건너뛴 줄)마다 PENDING 적치 지시를
-- 만든다(생산창고 입고 M-01-09 와 같은 모양 · 2026-11-28 사용자 결정). 지시가 어느 반납 줄에서 생겼는지 가리키는 원천 칸을 더하고,
-- 원천이 정확히 하나라는 제약을 셋으로 넓힌다.
-- ⭐ forward-only — 칸·제약을 더하기만 한다. 옛 지시는 구매 입고 줄 또는 보충 수령 줄 하나만 있어 새 제약을 그대로 지킨다.

ALTER TABLE logistics.putaway_task
    ADD COLUMN material_return_line_id bigint REFERENCES production.material_return_line(material_return_line_id),
    DROP CONSTRAINT ck_putaway_task_origin,
    ADD CONSTRAINT ck_putaway_task_origin CHECK (num_nonnulls(goods_receipt_line_id, shopfloor_receipt_line_id, material_return_line_id) = 1);

COMMENT ON COLUMN logistics.putaway_task.material_return_line_id IS
  '적치 대기로 받은 반납 입고 줄에서 생긴 적치 지시(피처 019). goods_receipt_line_id · shopfloor_receipt_line_id 와 정확히 하나만 있다.';
CREATE INDEX ix_putaway_task_material_return_line ON logistics.putaway_task (material_return_line_id);
