-- ERP 회신 읽기는 ERP 가 거절한 행(REJECTED)도 계속 본다 — ERP 쪽에서 원인을 고치면 같은 행을 다시 처리해 반영한다.
-- 그 행까지 담도록 회신 대기 인덱스의 조건을 넓힌다.
DROP INDEX integration.ix_erp_outbound_row_waiting;
CREATE INDEX ix_erp_outbound_row_waiting ON integration.erp_outbound_row (relay_table_name)
  WHERE status_code IN ('INSERTED', 'REJECTED');
