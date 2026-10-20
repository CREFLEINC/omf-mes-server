-- 특채 적용의 LOT 전이 코드와 보류 해제 사유(omf-all-around#84 · 2026-10-16 결정 · 장부 P-79).
-- ⭐ 시드가 아니라 마이그인 이유 — 배포는 migrate deploy 만 돌고 시드를 안 돌린다(089 §1). seed.ts 에도 같은 줄이 있다.
-- ⚠ C21~C24 는 #105·#108 이 쓴다 — 특채는 C25 다.
-- ⚠ 이름의 시각은 main 의 마지막 마이그(20261021090000) 뒤다 — 처음 만든 이름은 20261016160000·20261020130000 이었고 verify DB 는
--   옛 이름으로 이미 적용했다. 두 줄 모두 ON CONFLICT DO NOTHING 이라 새 이름으로 한 번 더 돌아도 바뀌는 것이 없다.
INSERT INTO mdm.code_value (code_group_id, code, code_name, display_order)
SELECT cg.code_group_id, 'C25', '특채 승인 → 정상(조건부 사용)', 180
FROM mdm.code_group cg
WHERE cg.group_code = 'LOT_STATUS_TRANSITION'
ON CONFLICT (code_group_id, code) DO NOTHING;

INSERT INTO mdm.code_value (code_group_id, code, code_name, display_order)
SELECT cg.code_group_id, 'CONCESSION_APPROVED', '특채 승인', 70
FROM mdm.code_group cg
WHERE cg.group_code = 'LOT_HOLD_RELEASE_REASON'
ON CONFLICT (code_group_id, code) DO NOTHING;
