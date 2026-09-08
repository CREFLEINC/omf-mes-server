COMMENT ON COLUMN maintenance.breakdown.cause_code IS
  '통보 090 서버 결정. 활성 EQUIPMENT_BREAKDOWN_CAUSE 코드 그룹의 mdm.code_value.code 자연키. quality.cause_code 대체 금지; 과거 저장값 조회에는 현재 활성 검증을 소급하지 않는다.';
