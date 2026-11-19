-- 피처 011 PDA 적치 기록(omf-all-around#325) — 적치한 작업자·단말을 업무 행에 남긴다(D-2·D-3). 칸 넷·부분 색인 넷·기존 행 채우기.
-- 지금까지 작업자·단말은 감사 기록(audit.audit_event)의 JSON 에만 있어 「내 기록 / 이 단말」로 하루치를 빠르게 거를 수 없었다.

-- ① 입고 전표 — PDA 지시 없는 적치(:putaway · :putaway-temporary)로 만든 전표만 채운다. 관리웹·기타 입고는 NULL.
ALTER TABLE logistics.goods_receipt
  ADD COLUMN putaway_worker_id bigint REFERENCES mdm.worker (worker_id),
  ADD COLUMN putaway_terminal_id bigint REFERENCES mdm.terminal (terminal_id);
COMMENT ON COLUMN logistics.goods_receipt.putaway_worker_id IS
  'PDA 지시 없는 적치로 만든 전표의 작업자. 관리웹·기타 입고는 NULL(omf-all-around#325)';
COMMENT ON COLUMN logistics.goods_receipt.putaway_terminal_id IS
  'PDA 지시 없는 적치로 만든 전표의 단말. 관리웹·기타 입고는 NULL(omf-all-around#325)';

-- ② 적치 지시 — 단말이 :complete · :complete-temporary 할 때 채운다. 관리웹(세션) 완료는 NULL.
--    assigned_worker_id(배정 축)와 다른 칸이다 — 배정은 쓰지 않는다(omf-all-around#26).
ALTER TABLE logistics.putaway_task
  ADD COLUMN completed_worker_id bigint REFERENCES mdm.worker (worker_id),
  ADD COLUMN completed_terminal_id bigint REFERENCES mdm.terminal (terminal_id);
COMMENT ON COLUMN logistics.putaway_task.completed_worker_id IS
  '단말이 적치 완료·임시 완료한 작업자. 세션 완료는 NULL(omf-all-around#325)';
COMMENT ON COLUMN logistics.putaway_task.completed_terminal_id IS
  '단말이 적치 완료·임시 완료한 단말. 세션 완료는 NULL(omf-all-around#325)';

-- ③ 「내 기록 / 이 단말」 하루치 조회용 부분 색인 — 칸이 채워진 행만 싣는다.
CREATE INDEX ix_goods_receipt_putaway_worker ON logistics.goods_receipt (putaway_worker_id, receipt_datetime DESC)
  WHERE putaway_worker_id IS NOT NULL;
CREATE INDEX ix_goods_receipt_putaway_terminal ON logistics.goods_receipt (putaway_terminal_id, receipt_datetime DESC)
  WHERE putaway_terminal_id IS NOT NULL;
CREATE INDEX ix_putaway_task_completed_worker ON logistics.putaway_task (completed_worker_id, completed_at DESC)
  WHERE completed_worker_id IS NOT NULL;
CREATE INDEX ix_putaway_task_completed_terminal ON logistics.putaway_task (completed_terminal_id, completed_at DESC)
  WHERE completed_terminal_id IS NOT NULL;

-- ④ 기존 행 채우기 — prisma/sql/putaway-actor-backfill.sql 과 같은 문장이다.
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
