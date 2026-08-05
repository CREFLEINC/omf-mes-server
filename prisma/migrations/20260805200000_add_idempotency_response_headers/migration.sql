-- 멱등 재생이 응답 헤더를 잃지 않게 한다.
--
-- ⚠ 이 컬럼은 OMF-MES 구현 측 추가분이다. 모델링 정본 SQL에 역반영이 필요하다.
--
-- 왜 필요한가:
--   지금 저장하는 것은 {status, body} 뿐이다. POST 는 계약이 헤더를 요구하지 않아
--   무해했으나, PUT 은 ETag 를 요구한다(공유계약 B-1).
--
--   PUT 재전송이 ETag 없이 200 을 받으면 클라이언트는 다음 쓰기의 If-Match 를 채울 수
--   없다 — 멱등이 살린 흐름을 헤더 누락이 다시 끊는다.
--
-- 왜 본문에 싸 넣지 않는가:
--   {__headers, body} 같은 포장은 마이그레이션을 아끼지만, 저장된 것을 사람이 봐도
--   응답 본문인지 포장인지 바로 알 수 없고 다른 도구가 이 테이블을 읽을 때 혼란스럽다.

ALTER TABLE app.idempotency_record
    ADD COLUMN response_headers jsonb;

COMMENT ON COLUMN app.idempotency_record.response_headers IS
    '재생 시 되돌려줄 응답 헤더. PUT 의 ETag 가 여기 담긴다.';
