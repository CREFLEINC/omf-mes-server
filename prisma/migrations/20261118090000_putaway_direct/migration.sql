-- 피처 009 적치 지시 없는 구매 입고 적치(omf-all-around#294) — 칸 둘·코드 그룹 하나·인계 알림 수신 설정 복사.

-- ① 입고 라인의 적치 방식 — PDA 지시 없는 적치로 생긴 입고만 채운다(DESIGNATED · UNDESIGNATED · TEMPORARY).
--    옛 입고·제품·반품·생산·직행 입고는 NULL 이다. 기존 행은 채우지 않는다.
ALTER TABLE logistics.goods_receipt_line ADD COLUMN putaway_mode_code varchar(30);
COMMENT ON COLUMN logistics.goods_receipt_line.putaway_mode_code IS
  'PDA 지시 없는 적치의 적치 방식(공통코드 GOODS_RECEIPT_PUTAWAY_MODE). 그 밖의 입고는 NULL(omf-all-around#294)';

-- ② 위치 「지정 품목만 받기」 — 켠 위치만 모든 재고 기록 경로에서 지정 밖 품목을 거절한다. 꺼져 있으면 품목 지정은 안내다.
--    ⚠ 배포 때 모든 위치가 꺼진다(사용자 결정 2026-11-18) — 지금 지정된 위치의 강제가 풀린다.
ALTER TABLE mdm.location ADD COLUMN item_restricted boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN mdm.location.item_restricted IS
  '지정 품목만 받기 — true 면 지정(location_item) 밖 품목의 재고 기록을 거절한다. false 면 지정은 안내(omf-all-around#294)';

-- ③ 적치 방식 코드 그룹. ⭐ 배포는 migrate deploy 만 돈다 — seed.ts 에도 같은 값이 있다. 시스템 소유(서버가 값을 정한다).
INSERT INTO mdm.code_group (group_code, group_name, is_system_owned)
VALUES ('GOODS_RECEIPT_PUTAWAY_MODE', '입고 적치 방식', true)
ON CONFLICT (group_code) DO NOTHING;

INSERT INTO mdm.code_value (code_group_id, code, code_name, display_order, name_ko, name_vi)
SELECT cg.code_group_id, v.code, v.code_name, v.display_order, v.code_name, v.name_vi
  FROM mdm.code_group cg
  JOIN (VALUES
    ('DESIGNATED', '지정 위치', 10, 'Vị trí chỉ định'),
    ('UNDESIGNATED', '미지정 위치 적치', 20, 'Xếp vào vị trí chưa chỉ định'),
    ('TEMPORARY', '임시 적치', 30, 'Xếp kho tạm')
  ) AS v(code, code_name, display_order, name_vi) ON cg.group_code = 'GOODS_RECEIPT_PUTAWAY_MODE'
ON CONFLICT (code_group_id, code) DO NOTHING;

-- ④ 새 인계 알림 「적치 대기」(PUTAWAY_PENDING)의 수신 설정 — 같은 공장의 「적치」(PUTAWAY_REQUESTED) 설정을 복사해
--    배포 첫날부터 알림이 끊기지 않게 한다. Zalo 는 알림 종류마다 템플릿을 따로 매겨야 하므로 끈 채로 시작한다.
INSERT INTO app.handover_alert_setting (plant_id, alert_type_code, is_enabled, zalo_enabled)
SELECT s.plant_id, 'PUTAWAY_PENDING', s.is_enabled, false
  FROM app.handover_alert_setting s
 WHERE s.alert_type_code = 'PUTAWAY_REQUESTED'
ON CONFLICT (plant_id, alert_type_code) DO NOTHING;

INSERT INTO app.handover_alert_recipient (handover_alert_setting_id, app_user_id)
SELECT pending.handover_alert_setting_id, r.app_user_id
  FROM app.handover_alert_setting src
  JOIN app.handover_alert_recipient r ON r.handover_alert_setting_id = src.handover_alert_setting_id
  JOIN app.handover_alert_setting pending
    ON pending.plant_id = src.plant_id AND pending.alert_type_code = 'PUTAWAY_PENDING'
 WHERE src.alert_type_code = 'PUTAWAY_REQUESTED'
ON CONFLICT (handover_alert_setting_id, app_user_id) DO NOTHING;
