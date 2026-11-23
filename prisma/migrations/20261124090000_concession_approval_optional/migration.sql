-- 특채 결재 요청을 비울 수 있게(omf-all-around#352) — 특채는 결재 없이 바로 적용하고 결재 요청을 남기지 않는다.
-- NOT NULL 을 푸는 것뿐이라 옛 코드와 함께 돌아도 된다(블루-그린).
ALTER TABLE quality.concession ALTER COLUMN approval_request_id DROP NOT NULL;
