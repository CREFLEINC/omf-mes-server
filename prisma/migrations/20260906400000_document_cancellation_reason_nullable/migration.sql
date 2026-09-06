-- I-5 선행 커밋 · R-1 · app.document_cancellation.reason_code 의 NOT NULL 해제
--
-- 추가 0 · 완화 1 · 삭제 0 — 두 릴리스 규칙 미해당. 백필 0(완화는 이미 든 값을 바꾸지 않는다).
--
-- 계약 `POST …/{documentTypeCode}/{documentId}:cancel` 에 requestBody 자체가 없어 취소
-- «사유 코드»를 아무도 안 보낸다. 계약 전체에 그 칸이 없고, 시드에도 물류 취소 사유 코드
-- 그룹이 없다(`WORK_ORDER_CANCEL_REASON` 하나뿐 — 작업지시 축이라 다르다).
-- ⇒ 상수를 박으면 「그 값으로 판정하지 않는다」는 주석을 영원히 달아야 하고, 나중에 사유
--    축이 서면 상수 행과 진짜 행이 섞인다. README §5 ⌜물리와 계약이 다르면 물리를 고친다⌝ ·
--    I-3 이 `inbound_variance.reason_code` 에서 같은 판정을 냈다(20260906300000 · R-9).
-- 사유 원문은 `reason_detail` 이 진다 — 취소 승인 요청의 `reason` 을 그대로 싣는다.
ALTER TABLE app.document_cancellation
    ALTER COLUMN reason_code DROP NOT NULL;

COMMENT ON COLUMN app.document_cancellation.reason_code IS
    '취소 사유 코드. 물류 다형 취소(:cancel)는 계약이 사유 코드를 안 보내 비운다 — 사유 원문은 reason_detail 이 진다(I-5.md R-1).';
