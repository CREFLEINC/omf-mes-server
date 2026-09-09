ALTER TABLE app.notification_subscription
  ALTER COLUMN app_user_id DROP NOT NULL,
  ALTER COLUMN channel_code DROP NOT NULL,
  ADD COLUMN zalo_enabled boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT ck_notification_subscription_scope CHECK (
    (app_user_id IS NULL AND channel_code IS NULL)
    OR (app_user_id IS NOT NULL AND channel_code IS NOT NULL)
  );

CREATE UNIQUE INDEX uq_notification_subscription_event_setting
  ON app.notification_subscription (event_type_code)
  WHERE app_user_id IS NULL AND channel_code IS NULL;

CREATE TABLE app.notification_subscription_recipient (
  notification_subscription_recipient_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  notification_subscription_id bigint NOT NULL
    REFERENCES app.notification_subscription(notification_subscription_id),
  recipient_type_code app.code_t NOT NULL,
  business_unit_id bigint REFERENCES mdm.business_unit(business_unit_id),
  role_id bigint REFERENCES app.role(role_id),
  app_user_id bigint REFERENCES app.app_user(app_user_id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ck_notification_subscription_recipient_shape CHECK (
    (recipient_type_code = 'ROLE' AND business_unit_id IS NOT NULL
      AND role_id IS NOT NULL AND app_user_id IS NULL)
    OR (recipient_type_code = 'USER' AND business_unit_id IS NULL
      AND role_id IS NULL AND app_user_id IS NOT NULL)
  )
);

CREATE INDEX ix_notification_subscription_recipient_parent
  ON app.notification_subscription_recipient (notification_subscription_id);

CREATE UNIQUE INDEX uq_notification_subscription_recipient_role
  ON app.notification_subscription_recipient
    (notification_subscription_id, business_unit_id, role_id)
  WHERE recipient_type_code = 'ROLE';

CREATE UNIQUE INDEX uq_notification_subscription_recipient_user
  ON app.notification_subscription_recipient
    (notification_subscription_id, app_user_id)
  WHERE recipient_type_code = 'USER';

COMMENT ON COLUMN app.notification_subscription.app_user_id IS
  '기존 사용자별 구독은 사용자 ID를 보존. 신규 이벤트 헤더는 app_user_id와 channel_code 모두 NULL.';
COMMENT ON COLUMN app.notification_subscription.channel_code IS
  '기존 채널 구독 값 보존. 신규 이벤트 헤더에서는 NULL이며 Zalo 설정은 zalo_enabled에 저장.';
COMMENT ON COLUMN app.notification_subscription.zalo_enabled IS
  '이벤트 헤더의 Zalo 추가 전달 설정. 기본 끔. 실제 전송·전화번호 수집은 별도 미정.';
COMMENT ON TABLE app.notification_subscription_recipient IS
  '이벤트 헤더의 수신자 규칙. ROLE=사업부+역할, USER=개인. 발생 기록이나 전개된 사람 목록이 아니다.';
