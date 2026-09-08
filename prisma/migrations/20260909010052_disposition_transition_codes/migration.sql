-- 처분 판정 3전이의 코드 C17·C18·C19 를 LOT_STATUS_TRANSITION 그룹에 더한다 (I-21 PR ④).
--
-- ⭐ 결정 — 통보 089 §1. 계약은 «도착 상태»를 직접 적었고(quality-03품질.json:2460 —
--    「재작업 → INSPECTION_PENDING · 폐기 → SCRAPPED · 정상 → NORMAL」) 없던 것은 그 전이를
--    가리키는 «코드»뿐이다. 시드 9값(C4~C15) 중 to = SCRAPPED 인 것이 0개라 기존 코드로
--    접히지 않고, 도식이 C1~C16 을 이미 써(W-03-02 §5-5) 빈 첫 번호가 C17 이다.
-- ⭐ 시드가 아니라 마이그인 이유 — 배포는 `migrate deploy` 만 돌고 시드를 안 돌린다
--    (deploy/RELEASE.md). seed.ts 만 고치면 기존 DB 에 영영 안 들어간다. 베이스라인 밖에서
--    code_value 를 INSERT 하는 첫 사례라 통보 089 에 운영 통지를 함께 실었다.
-- ⚠ 그룹 자체는 seed.ts 가 세우므로 아직 없는 DB 에서는 0행을 넣고 지나간다 — 그때는 시드가
--    세 값을 함께 만든다. 새 DB 는 시드가, 기존 DB 는 이 마이그가 채우고 결과가 같다.
-- ✅ 추가만 · 삭제 0 · 백필 0 · 순서 의존 0 (lanes.md §1-2). 값이 바뀌면
--    trace.lot_status_event.transition_code 를 UPDATE 한 문장으로 갈아 끼운다 — 그 표에
--    불변 트리거가 없다(전 마이그레이션 CREATE TRIGGER 6개 전수 실측).

INSERT INTO mdm.code_value (code_group_id, code, code_name, display_order)
SELECT cg.code_group_id, v.code, v.code_name, v.ord
FROM mdm.code_group cg,
     (VALUES
        ('C17', '처분 재작업 → 검사 대기', 100),
        ('C18', '처분 폐기 → 폐기', 110),
        ('C19', '처분 정상 → 정상', 120)
     ) AS v(code, code_name, ord)
WHERE cg.group_code = 'LOT_STATUS_TRANSITION'
ON CONFLICT (code_group_id, code) DO NOTHING;
