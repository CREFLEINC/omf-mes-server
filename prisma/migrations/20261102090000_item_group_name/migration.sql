-- ERP 품목그룹 이름(ITEM_GROUP_NM) — 생산계획 목록이 코드만으로는 알아보기 어려워 이름을 함께 보인다.
-- 기본값 없는 NULL 칸이라 배포 중 옛 코드와 함께 돈다. 이미 받은 품목은 ERP 가 다시 보낼 때 채워진다.
ALTER TABLE mdm.item ADD COLUMN erp_item_group_name VARCHAR(200);
