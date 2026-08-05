-- 범용 멱등 저장소.
--
-- ⚠ 이 테이블은 OMF-MES 구현 측 추가분이다. 모델링 정본 SQL에 역반영이 필요하다.
--
-- 왜 필요한가:
--   계약(mdm-기준정보.json)이 mdm 쓰기 20개 전부에 Idempotency-Key 를 필수로 요구한다
--   (근거: 02-SW설계사양서 §3.3). 정본은 멱등을 전표 테이블의 컬럼으로 푼다 —
--   work_session.idempotency_key UNIQUE, inventory_transaction 은 (키, business_date) UNIQUE.
--
--   그 방식이 마스터에는 통하지 않는다. 20개 중 15개가 기존 행을 고치는 쓰기
--   (PUT · :deactivate)라 새로 만드는 행이 없고, 따라서 유니크 제약을 얹을 자리가 없다.
--
-- 무엇을 막는가:
--   저장 요청이 서버에 도착해 처리됐는데 응답이 유실되면 사용자는 다시 저장을 누른다.
--
--   등록(POST): 코드 유니크 제약이 두 건 생성을 막지만, 사용자는 자기가 방금 성공시킨
--   것에 대해 409 「이미 존재합니다」를 본다.
--
--   수정(PUT): 이쪽이 더 나쁘다. 1차에서 version_no 가 3→4 로 올랐는데 클라이언트는
--   새 ETag 를 받지 못해 여전히 If-Match: 3 을 들고 재전송한다. 서버는 409 를 주고,
--   계약의 conflictCause 는 'user'(= 다른 사용자)다 — 다른 사용자는 없었고 자기
--   재전송이었는데 「다른 사용자가 먼저 수정했습니다」라고 안내하게 된다.
--
--   멱등 검사가 If-Match 검사보다 앞에 있으면(인터셉터 → 핸들러 → 서비스) 재전송은
--   저장된 응답을 그대로 받고 버전 검사에 닿지도 않는다.
--
-- 키 범위:
--   전역이다(PK = 키 하나). app_user_id 는 조회 조건이 아니라 누가 보냈는지 기록용이며,
--   키 오용을 추적할 때 쓴다.
--
-- 보관:
--   24시간. 재전송은 몇 초~몇 분 안에 일어나고, 오프라인 버퍼링을 감안해도 넉넉하다.
--   지우는 주체는 인터셉터다(PR-I) — 쓰기 한 번당 만료분을 소량 삭제한다. 스케줄러
--   의존성을 새로 들이지 않고, 「나중에 정리 붙이기」를 잊을 여지도 없앤다.

CREATE TABLE app.idempotency_record (
    idempotency_key      uuid        PRIMARY KEY,

    -- 메서드 + 경로 + 본문 해시. 키는 같은데 지문이 다르면 클라이언트가 키를 재사용한
    -- 것이므로 400 으로 거부한다 — 저장된 응답을 엉뚱한 요청에 돌려주는 것보다 안전하다.
    request_fingerprint  text        NOT NULL,

    -- IN_PROGRESS: 첫 요청이 아직 처리 중. 같은 키가 또 오면 409.
    -- COMPLETED:   응답이 저장됨. 같은 키가 또 오면 그 응답을 재생.
    status               text        NOT NULL,
    CONSTRAINT ck_idempotency_status CHECK (status IN ('IN_PROGRESS', 'COMPLETED')),

    response_status      integer,
    response_body        jsonb,
    CONSTRAINT ck_idempotency_completed CHECK (
        status <> 'COMPLETED' OR (response_status IS NOT NULL AND completed_at IS NOT NULL)
    ),

    app_user_id          bigint      REFERENCES app.app_user(app_user_id),
    created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
    completed_at         timestamptz,
    expires_at           timestamptz NOT NULL
);

-- 만료분 삭제가 이 인덱스를 탄다. 없으면 정리할 때마다 전체를 훑는다.
CREATE INDEX ix_idempotency_expires ON app.idempotency_record (expires_at);

COMMENT ON TABLE app.idempotency_record IS
    '범용 멱등 저장소. 정본 모델 미포함 — OMF-MES 구현 측 추가분(2026-08-05).';
