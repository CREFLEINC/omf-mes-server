-- 작업 세션 멱등 키.
--
-- ⚠ 이 컬럼은 OMF-MES 구현 측 추가분이다. 모델링 정본 SQL에 역반영이 필요하다.
--
-- 왜 필요한가:
--   기술스택-배포모델 결정서 §160이 「전 쓰기 API `Idempotency-Key`(클라이언트 UUID)
--   필수 — 계약 표준 헤더」로 확정했고, 설계검토 §138은 재전송 중복을 DB UNIQUE로 막고
--   앱이 P2002를 200으로 변환한다고 규정한다. 그 규정대로 production_result·
--   material_consumption·inspection_result·inventory_transaction 4개 테이블은 정본에
--   idempotency_key를 갖는데, work_session에는 없다 — 정본 설계 시점에 「작업 시작」이
--   쓰기 API로 헤아려지지 않은 결과다.
--
--   POP은 오프라인 버퍼링(결정 17 시나리오 ① W/O 선배포로 생산 계속) 때문에 재전송이
--   실제로 일어난다. 같은 「작업 시작」이 두 번 들어가면 한 작업지시에 세션이 둘 열리고,
--   그 뒤의 실적이 어느 세션에 붙었느냐로 갈려 생산량 집계가 어긋난다.
--
--   기존 「이미 진행 중」 409로도 중복 세션은 막힌다. 그러나 그건 거부지 멱등이 아니다 —
--   오프라인에서 돌아온 단말은 자기 요청이 이미 반영됐는지 모른 채 409를 실패로 읽는다.
--   멱등 키가 있어야 「그때 만든 그 세션」을 그대로 돌려줄 수 있다.
--
-- NOT NULL로 두는 이유:
--   정본의 production_result.idempotency_key와 같은 강도를 유지한다. nullable로 두면
--   키 없는 쓰기가 조용히 허용돼 계약이 문서에만 남는다.
--
-- 기존 행 처리:
--   운영 배포 전이라 실제로는 빈 테이블이지만, 개발 DB에 남은 행이 있어도 마이그레이션이
--   실패하지 않도록 합성 키로 채운 뒤 NOT NULL을 건다. 'legacy-' 접두어라 클라이언트가
--   보내는 UUID와 겹치지 않는다.

ALTER TABLE production.work_session
    ADD COLUMN idempotency_key varchar(150);

UPDATE production.work_session
   SET idempotency_key = 'legacy-' || work_session_id::text
 WHERE idempotency_key IS NULL;

ALTER TABLE production.work_session
    ALTER COLUMN idempotency_key SET NOT NULL;

ALTER TABLE production.work_session
    ADD CONSTRAINT uq_work_session_idempotency_key UNIQUE (idempotency_key);

COMMENT ON COLUMN production.work_session.idempotency_key IS
    '클라이언트 재전송 식별자(Idempotency-Key 헤더). 같은 키의 재요청은 새 세션을 만들지 않고 기존 세션을 돌려준다. 정본 모델 미포함 — OMF-MES 구현 측 추가분(2026-07-28).';
