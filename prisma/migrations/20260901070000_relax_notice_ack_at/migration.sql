-- app.notice_acknowledgement.acknowledged_at 을 nullable 로 내린다.
--
-- 요청: 설계 회신 2026-09-01 E-6
-- 계약: app-공통.json 의 NoticeAcknowledgement
--
-- 20260901040000 에서 이 컬럼을 NOT NULL 로 «두었다». 계약 설명이 「이 시각은 «닫기»로
-- 남은 행에도 찍힌다 · 행이 없음 = 미확인」이라 행이 있으면 항상 시각이 있다고 읽었고,
-- 완화하면 어느 상태에도 속하지 않는 행이 들어올 수 있다고 보았다.
--
-- 그 판단을 되돌린다. 두 가지가 근거다.
--
--   계약 스키마가 required 에서 뺐다. required 는 userId·userName·acknowledged 셋이고
--   acknowledgedAt 은 선택이다 — 계약이 없는 경우를 «허용»한다. 설명이 좁게 읽히더라도
--   스키마가 넓으면 넓은 쪽이 계약이다.
--
--   설계 회신 E-6 이 완화를 명시적으로 답했다. 계약과 화면은 설계 산출물이고 백엔드는
--   그 요구를 준수해 모델을 맞춘다.
--
-- 물리를 계약보다 «좁게» 잡으면 계약이 허용하는 경우가 DB 에서 막힌다. 「뜻 없는 행」을
-- 막는 것은 서버가 할 일이지 컬럼 제약이 할 일이 아니다.

ALTER TABLE app.notice_acknowledgement
    ALTER COLUMN acknowledged_at DROP NOT NULL;

COMMENT ON COLUMN app.notice_acknowledgement.acknowledged_at IS
    '확인 또는 닫기가 일어난 시각. 계약이 선택 필드라 비어 있을 수 있다 — 확인=참·시각 있음은 확인, 확인=거짓·시각 있음은 열람(닫기)이며, 행이 아예 없으면 미확인이다.';
