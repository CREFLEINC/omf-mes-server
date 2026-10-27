-- 피킹 반납 사유(장부 P-126) — 출하하지 않은 피킹분을 가용 재고로 되돌릴 때 고른다. 「기타」면 비고가 필수다(서버가 본다).
-- 추가만 한다 — 옛 코드는 이 그룹을 읽지 않는다.
INSERT INTO mdm.code_group (group_code, group_name, is_system_owned)
VALUES ('PICK_RETURN_REASON', '피킹 반납 사유', false)
ON CONFLICT (group_code) DO NOTHING;

INSERT INTO mdm.code_value (code_group_id, code, code_name, display_order)
SELECT cg.code_group_id, v.code, v.code_name, v.display_order
FROM mdm.code_group cg
CROSS JOIN (VALUES ('QTY_EXCESS', '수량 과다', 10), ('WRONG_LOT', 'LOT 착오', 20), ('PACK_CORRECTION', '포장 정정 잔량', 30), ('OTHER', '기타', 40))
    AS v(code, code_name, display_order)
WHERE cg.group_code = 'PICK_RETURN_REASON'
ON CONFLICT (code_group_id, code) DO NOTHING;
