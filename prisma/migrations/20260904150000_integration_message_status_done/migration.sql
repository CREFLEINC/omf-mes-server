-- 연계 메시지 완료 상태 문자열을 코드 사전(6d03a44 · CD-INTEGRATION-MESSAGE-STATUS)에 맞춘다.
-- 서버 상수가 계약이 값 목록을 세우기 전에 COMPLETED 를 골랐고(되돌림 §X-4), 계약이 DONE 으로
-- 확정했다. 재처리(:retry) 판정은 FAILED 만 보므로 이 UPDATE 로 동작이 바뀌지는 않는다 — 화면
-- 필터(statusCode=DONE)와 코드 그룹의 이름 표시가 맞아지는 것이다. 이 표에 쓰는 워커가 아직 없어
-- 0행이 정상이고, 재실행해도 0행이다.
UPDATE integration.integration_message
   SET status_code = 'DONE'
 WHERE status_code = 'COMPLETED';
