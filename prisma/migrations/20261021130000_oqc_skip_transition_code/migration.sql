-- 승인된 OQC 생략 실행이 출하작업지시가 집은 LOT 에 남기는 이력 코드(omf-all-around#119 · 2026-10-20 결정 D6-A · 장부 P-83).
-- ⭐ 시드가 아니라 마이그인 이유 — 배포는 migrate deploy 만 돌고 시드를 안 돌린다(089 §1). seed.ts 에도 같은 줄이 있다.
-- OQC 는 헤더 대상이라 LOT 은 이미 정상이다 — 정상 → 정상 이력만 남는다. 값만 더하므로 옛 코드와 함께 살 수 있다.
-- ⚠ 이름의 시각은 main 의 마지막 마이그(20261021110000) 뒤다 — 처음 만든 이름은 20261020160000_oqc_skip_transition_code 이었고 확인용 DB 는 옛 이름으로 이미
--   적용했다. ON CONFLICT DO NOTHING 이라 새 이름으로 한 번 더 돌아도 바뀌는 것이 없다.
INSERT INTO mdm.code_value (code_group_id, code, code_name, display_order)
SELECT cg.code_group_id, 'C27', 'OQC 생략 → 정상', 200
FROM mdm.code_group cg
WHERE cg.group_code = 'LOT_STATUS_TRANSITION'
ON CONFLICT (code_group_id, code) DO NOTHING;
