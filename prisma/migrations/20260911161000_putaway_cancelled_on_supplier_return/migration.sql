-- A full supplier return closes a pending putaway task because no stock remains to move.
INSERT INTO mdm.code_value (
  code_group_id,
  code,
  code_name,
  display_order,
  is_active
)
SELECT
  code_group_id,
  'CANCELLED',
  '전량 반품으로 적치 취소',
  40,
  true
FROM mdm.code_group
WHERE group_code = 'PUTAWAY_TASK_STATUS'
ON CONFLICT (code_group_id, code) DO UPDATE
SET code_name = EXCLUDED.code_name,
    display_order = EXCLUDED.display_order,
    is_active = true,
    updated_at = clock_timestamp(),
    version_no = mdm.code_value.version_no + 1;
