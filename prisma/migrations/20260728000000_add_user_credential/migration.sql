-- 관리 화면 로그인 자격증명.
--
-- 정본 물리 모델(2026-07-23-데이터모델링)에는 자격증명 저장소가 없다. app.app_user는
-- login_id·이름·부서·이메일·상태만 갖는다 — 요구사항 1-2 '사용자·권한 관리'가 권한만
-- 다루고 로그인 수단을 언급하지 않아 인증이 설계에서 빠진 결과다.
-- 고객 확인 결과 자체 비밀번호 인증으로 결정(2026-07-28)하여 여기서 보완한다.
--
-- ⚠ 이 테이블은 OMF-MES 구현 측 추가분이다. 모델링 정본 SQL에 역반영이 필요하다.
--
-- app_user에 컬럼을 더하지 않고 별도 테이블로 둔 이유:
--   · 자격증명은 수명주기(변경일·잠금·실패횟수)가 계정 정보와 다르다
--   · 정본 테이블의 형태를 건드리지 않아 모델링 측 갱신과 충돌이 적다
--   · 추후 LDAP/AD로 전환하면 이 테이블만 걷어내면 된다

CREATE TABLE app.user_credential (
    app_user_id          bigint PRIMARY KEY
                         REFERENCES app.app_user(app_user_id) ON DELETE CASCADE,
    -- 알고리즘·파라미터·salt를 해시 문자열에 함께 담는다(자기서술적). 형식은 password.service.ts 참조.
    password_hash        text NOT NULL,
    password_algo        app.code_t NOT NULL DEFAULT 'SCRYPT',
    password_changed_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
    -- 관리자가 초기 비밀번호를 발급한 직후 등, 다음 로그인에서 변경을 강제한다.
    must_change_password boolean NOT NULL DEFAULT false,
    failed_attempt_count integer NOT NULL DEFAULT 0 CHECK (failed_attempt_count >= 0),
    locked_until         timestamptz,
    last_login_at        timestamptz,
    created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by           bigint,
    updated_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by           bigint,
    version_no           integer NOT NULL DEFAULT 1 CHECK (version_no > 0)
);

COMMENT ON TABLE app.user_credential IS
    '관리 화면 로그인 자격증명. 정본 모델 미포함 — OMF-MES 구현 측 추가분(2026-07-28).';
