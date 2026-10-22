-- ERP 보내기 실행기가 10초마다 보낼 차례인 메시지를 잡는다. 받기 기록(INBOUND)은 중계 행마다 한 줄씩 쌓여
-- 표가 커지지만(개발 DB 4만 줄), 이 인덱스는 보낼 차례인 줄만 담는다.
CREATE INDEX ix_integration_message_outbound_pending
  ON integration.integration_message (available_at, integration_message_id)
  WHERE direction_code = 'OUTBOUND' AND status_code = 'PENDING';
