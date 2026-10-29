-- ERP 창고의 이름은 ERP 를 따르고 MES 에서 고치지 않는다 — 현장이 부르는 이름은 MES 별칭에 둔다(사용자 결정 2026-10-29).
ALTER TABLE mdm.warehouse ADD COLUMN alias_name varchar(200);
