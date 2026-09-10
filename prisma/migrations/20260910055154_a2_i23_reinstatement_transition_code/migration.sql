-- 재등록 LOT 전이 코드 C20 (결정 — 통보 218).
-- ⭐ 근거는 통보 089 `:69-70` 이다. ⛔ 「시드의 빈 첫 번호」가 «아니다» — 실측이
--    C11·C12·C13·C16 을 비워 두고 있어 그 논리는 거짓이었다(I-23 R-11).
-- ⭐ 시드가 아니라 마이그인 이유 — 배포는 migrate deploy 만 돌고 시드를 안 돌린다(089 §1).
--    seed.ts 에도 같은 한 줄을 둔다(새로 만드는 DB 의 동등성).
INSERT INTO mdm.code_value (code_group_id, code, code_name, display_order)
SELECT cg.code_group_id, 'C20', '재등록 → 정상', 130
FROM mdm.code_group cg
WHERE cg.group_code = 'LOT_STATUS_TRANSITION'
ON CONFLICT (code_group_id, code) DO NOTHING;
