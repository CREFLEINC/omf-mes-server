-- 피처 011 적치 기록(omf-all-around#325) — 배포 전 적치의 작업자·단말을 감사 기록에서 채운다.
-- ⭐ 마이그레이션 20261119090000_putaway_actor 가 이 두 문장을 글자 그대로 담는다(시험이 대조한다).
--    대상마다 가장 이른 감사 행 하나. 이미 채워진 행·없어진 작업자·단말은 건드리지 않는다(다시 돌려도 같다).
UPDATE logistics.goods_receipt r
   SET putaway_worker_id = a.worker_id, putaway_terminal_id = a.terminal_id
  FROM (
    SELECT DISTINCT ON (e.target_id) e.target_id, e.terminal_id, (e.after_value->>'workerId')::bigint AS worker_id
      FROM audit.audit_event e
     WHERE e.target_type_code = 'GOODS_RECEIPT' AND e.event_type_code = 'CREATE' AND e.terminal_id IS NOT NULL
       AND e.after_value->>'operationKey' LIKE 'POST /logistics/putaway-pending-lots/%'
     ORDER BY e.target_id, e.occurred_at, e.audit_event_id
  ) a
  JOIN mdm.worker w ON w.worker_id = a.worker_id
  JOIN mdm.terminal t ON t.terminal_id = a.terminal_id
 WHERE r.goods_receipt_id = a.target_id AND r.putaway_worker_id IS NULL AND r.putaway_terminal_id IS NULL;

UPDATE logistics.putaway_task p
   SET completed_worker_id = a.worker_id, completed_terminal_id = a.terminal_id
  FROM (
    SELECT DISTINCT ON (e.target_id) e.target_id, e.terminal_id, (e.after_value->>'workerId')::bigint AS worker_id
      FROM audit.audit_event e
     WHERE e.target_type_code = 'PUTAWAY_TASK' AND e.event_type_code IN ('COMPLETE', 'COMPLETE_TEMPORARY') AND e.terminal_id IS NOT NULL
     ORDER BY e.target_id, e.occurred_at, e.audit_event_id
  ) a
  JOIN mdm.worker w ON w.worker_id = a.worker_id
  JOIN mdm.terminal t ON t.terminal_id = a.terminal_id
 WHERE p.putaway_task_id = a.target_id AND p.completed_worker_id IS NULL AND p.completed_terminal_id IS NULL;
