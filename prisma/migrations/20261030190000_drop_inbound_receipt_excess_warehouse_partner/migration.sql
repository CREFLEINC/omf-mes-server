-- ⛔ 사용을 뗀 판(옛 초과분 경로·쓰기 · 창고 partner_id 의 Prisma 모델)이 배포된 «다음» 릴리스에만 싣는다 —
--    블루-그린 전환 중 옛 판이 이 스키마를 보고, 칸을 아는 Prisma 클라이언트는 창고를 읽을 때마다 그 칸을 고른다.

-- 옛 초과분(장부 P-100) — 배정 표(inbound_receipt_po_allocation · P-115)가 대신한다. 이어진 초과분은 배정 몫으로 옮겨 적혀 있다.
DROP TABLE logistics.inbound_receipt_excess;

-- 창고의 거래처(#928) — FK warehouse_partner_id_fkey 는 칸과 함께 지워진다. is_external 은 남긴다(사용자 결정 2026-10-30).
ALTER TABLE mdm.warehouse DROP COLUMN partner_id;
