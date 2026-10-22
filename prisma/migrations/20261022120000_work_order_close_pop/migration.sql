-- POP 작업지시 마감·관리웹 작업 세션 강제 종료(omf-all-around#96 · 장부 P-104). 칸·값을 더하기만 해 옛 코드와 함께 산다.

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
