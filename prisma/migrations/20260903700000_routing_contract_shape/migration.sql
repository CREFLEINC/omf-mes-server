-- Routing 헤더를 계약(결정 07)에 맞춘다. 두 자리다.
--
-- 1. effective_from 을 nullable 로.
--
--    계약 `Routing.effectiveFrom` 은 required 가 아니고, 스키마 주석이 그 근거를 적었다 —
--    「✓설계확정 결정 07 이 「선택」이라 했고 «그것이 정본이다». 앞서 「모델이 NOT NULL 이니
--    하류를 따른다」로 필수로 두었던 것을 2026-08-18 되돌렸다 — 물리 모델은 설계 결정을
--    앞설 수 없다」.
--
--    ⛔ 서버가 임의 날짜로 채우는 길은 두지 않는다. 「시작 제한이 없다」와 「오늘부터」는
--    다른 뜻이고, 유효기간이 겹치는 Rev 를 고르는 판정(:set-default)이 그 차이를 읽는다.
--
--    ck_routing_dates 는 그대로 둔다 — effective_to 가 NULL 이면 통과하고, effective_from
--    이 NULL 이면 비교식이 NULL 이라 CHECK 는 통과다(SQL 3값 논리). 즉 「시작이 없는데
--    종료만 있는」 행이 통과한다. 그 짝은 서버가 본다(계약도 짝 제약으로만 적었다).
--
-- 2. uq_routing_default 의 술어에서 status_code 를 뺀다.
--
--    지금은 ON (item_id) WHERE (is_default AND status_code = 'ACTIVE') 다. 계약은
--    ON (item_id) WHERE is_default 이고 「Bom.isDefault 와 같은 형태」라 적었는데, 실제로
--    uq_bom_default 는 술어가 WHERE is_default 뿐이다 — 같은 뜻의 두 인덱스가 서로 다르다.
--
--    지금 술어면 작성중 Rev 와 확정 Rev 가 «둘 다» 기본이 될 수 있다. 「기본 Rev 가
--    무엇인가」에 답이 둘이 되고, 그 둘 중 무엇을 쓸지는 아무 데도 안 적혀 있다.
--
--    ⛔ 상태 문자열을 인덱스 술어에 박아 둔 것 자체도 문제다 — 계약이 'ACTIVE' 라는
--    이름을 「결정 07 이 확정한 뜻(작성중·확정·폐기) 중 어느 것도 아니다」로 되돌리라
--    적어 두었다(공유계약 G-32). 이름이 바뀌면 인덱스까지 함께 고쳐야 한다.

ALTER TABLE planning.routing
    ALTER COLUMN effective_from DROP NOT NULL;

DROP INDEX planning.uq_routing_default;
CREATE UNIQUE INDEX uq_routing_default
    ON planning.routing (item_id)
    WHERE is_default;

COMMENT ON COLUMN planning.routing.effective_from IS
  '유효 시작일. 비면 시작 제한이 없다 (결정 07 — 선택).';
