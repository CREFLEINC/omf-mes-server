-- POP 작업지시 마감·관리웹 작업 세션 강제 종료(장부 P-105). 칸·값을 더하기만 해 옛 코드와 함께 산다.

-- 단말 공정 매핑의 「작업지시 마감」 권한. 기본 열림(사용자 결정 2026-10-22) — 기존 매핑 행도 DEFAULT 로 켜진다.
ALTER TABLE mdm.terminal_process
    ADD COLUMN can_close_work_order boolean NOT NULL DEFAULT true;

-- POP 마감의 주체 작업자. 관리웹 마감은 계정(updated_by)이 남아 비운다.
ALTER TABLE production.work_order
    ADD COLUMN closed_worker_id bigint REFERENCES mdm.worker(worker_id);

-- 관리웹 강제 종료의 사유 — 누가(performed_by)·언제(occurred_at)와 함께 사건에 남긴다.
ALTER TABLE production.work_session_event
    ADD COLUMN remarks text;

-- ⭐ 시드가 아니라 마이그인 이유 — 배포는 migrate deploy 만 돌고 시드를 안 돌린다. seed.ts 에도 같은 줄을 둔다.
INSERT INTO mdm.code_value (code_group_id, code, code_name, display_order)
SELECT cg.code_group_id, 'FORCE_END', '강제 종료', 60
FROM mdm.code_group cg
WHERE cg.group_code = 'WORK_SESSION_EVENT_TYPE'
ON CONFLICT (code_group_id, code) DO NOTHING;

-- 마감 시점 판정 — 조회의 progress 판정은 마감 뒤 지연 실적으로 바뀔 수 있어 마감 결과로 따로 남긴다.
ALTER TABLE production.work_order
    ADD COLUMN close_judgment_code varchar(10)
        CONSTRAINT ck_work_order_close_judgment CHECK (close_judgment_code IN ('UNDER', 'NORMAL', 'OVER'));

-- 이미 마감된 W/O 는 마감이 적재한 ERP 실적 메시지의 판정으로 채운다(없으면 비운다).
-- ⚠ 마감 W/O 의 UPDATE 를 막는 트리거와 updated_at 을 찍는 트리거를 이 채움 동안만 끈다 — 마감 행의 수정 시각이
--    바뀌면 「마감 뒤 수정됐다」로 읽힌다. 같은 트랜잭션 안이라 다른 쓰기가 끼지 않는다.
ALTER TABLE production.work_order DISABLE TRIGGER trg_work_order_closed_immutable;
ALTER TABLE production.work_order DISABLE TRIGGER trg_work_order_set_updated_at;
UPDATE production.work_order wo
   SET close_judgment_code = m.payload -> 'header' ->> 'completionJudgmentCode'
  FROM integration.integration_message m
 WHERE wo.closed_at IS NOT NULL
   AND m.interface_code = 'IF-WO-CLOSE-SEND'
   AND m.target_type_code = 'WORK_ORDER'
   AND m.target_id = wo.work_order_id
   AND m.payload -> 'header' ->> 'completionJudgmentCode' IN ('UNDER', 'NORMAL', 'OVER');
ALTER TABLE production.work_order ENABLE TRIGGER trg_work_order_set_updated_at;
ALTER TABLE production.work_order ENABLE TRIGGER trg_work_order_closed_immutable;
