-- PQC 생략 허용 기준으로 생략된 W/O 의 생산LOT 전이 코드(omf-all-around#119 · 2026-10-20 결정 · 장부 P-82).
-- ⭐ 시드가 아니라 마이그인 이유 — 배포는 migrate deploy 만 돌고 시드를 안 돌린다(089 §1). seed.ts 에도 같은 줄이 있다.
-- ⚠ C25 는 #84(특채)가 쓴다 — PQC 생략은 C26 이다. 값만 더하므로 옛 코드와 함께 살 수 있다.
-- ⚠ 이름의 시각은 main 의 마지막 마이그(20261021110000) 뒤다 — 처음 만든 이름은 20261020150000_pqc_skip_transition_code 이었고 확인용 DB 는 옛 이름으로 이미
--   적용했다. ON CONFLICT DO NOTHING 이라 새 이름으로 한 번 더 돌아도 바뀌는 것이 없다.
INSERT INTO mdm.code_value (code_group_id, code, code_name, display_order)
SELECT cg.code_group_id, 'C26', 'PQC 생략 → 정상', 190
FROM mdm.code_group cg
WHERE cg.group_code = 'LOT_STATUS_TRANSITION'
ON CONFLICT (code_group_id, code) DO NOTHING;
