-- trace.lot 생명주기 축 신설 · 완료 시각 신설 · 죽은 제약 둘 정리.
--
-- 요청: 이슈 #50 · #63 「신규 컬럼」 · 설계 회신 2026-09-01 D-2
-- 계약: logistics-01자재창고.json 의 Lot.lifecycleStatusCode(x-source-column 확정) ·
--       Lot.completedAt(대응 컬럼 신설 통지 대상)
--
-- ── 축이 셋이 된다 ────────────────────────────────────────────────────────────
--
--   status_code            품질 판정 — 정상·불량·검사 대기·폐기 (LOT_STATUS)
--   lifecycle_status_code  생명주기 — 대기·활성·폐번 (LOT_LIFECYCLE_STATUS)  ← 신설
--   completed_at           완료 여부 — 시각이 있고 없고로 갈린다              ← 신설
--
-- 계약이 셋을 섞지 말라고 못박았다. 「완료」·「미달 마감」·「폐번」은 품질 축의 값이
-- 아니고, 「완료」는 생명주기 축의 값도 아니다. 화면 스펙(W-03-01)에서 품질 축과
-- 생명주기 축을 헷갈린 사고가 실제로 있었다.
--
-- 완료를 상태값이 아니라 «시각»으로 두는 이유는 계약에 적혀 있다 — 상태 코드 문자열을
-- 몰라도 완료 여부가 판정된다. 그리고 Lot 에 두 번째 판정값을 두지 않는다는 결정이
-- 있다(완료/미달 배지의 판정값은 W/O 진행 스키마가 한 곳에서만 낸다).
--
-- 둘 다 nullable 이다. 생산LOT 선발행(W-02-04)에서만 쓰고 자재·제품 LOT 은 null 이다.
-- 「생산LOT 일 때만 값이 있다」를 CHECK 로 걸지 못하는 것은 lot_type_code 의 값 목록이
-- 아직 확정 전이라서다(계약: 「확정된 값 목록이 아직 없다」). 값이 오면 그때 건다.
--
-- ⚠ 값 집합을 CHECK 로 박지 않는다. 대기·활성·폐번은 확정됐지만(설계 회신 2026-08-31
--   #50 — WAITING·ACTIVE·VOIDED) 다른 코드 컬럼과 같이 mdm.code_value 로 푼다. 아래
--   ck_lot_initial_qty 가 값을 CHECK 에 박았다가 어떻게 됐는지가 바로 그 이유다.

ALTER TABLE trace.lot
    ADD COLUMN lifecycle_status_code app.code_t,
    ADD COLUMN completed_at timestamp with time zone;

COMMENT ON COLUMN trace.lot.lifecycle_status_code IS
    '생명주기 축(대기·활성·폐번 — LOT_LIFECYCLE_STATUS). 품질 판정 축인 status_code 와 다른 축이며 한 이력에 섞지 않는다. 생산LOT 선발행에서만 쓰고 자재·제품 LOT 은 null 이다. 근거: 이슈 #50 · 02-SW설계사양서 §4.6.';

COMMENT ON COLUMN trace.lot.completed_at IS
    '생산 LOT 완료 처리가 찍는 시각. 비어 있으면 아직 완료되지 않았다 — 완료 여부는 상태 문자열이 아니라 이 시각의 유무로 갈린다. 「완료」·「미달 마감」을 status_code 에도 lifecycle_status_code 에도 값으로 넣지 않는 이유다. 근거: 공유계약 §I-32·§I-49.';

-- ── 죽은 제약 정리 ───────────────────────────────────────────────────────────
--
-- ck_lot_initial_qty 가 lot_type_code = 'PREISSUED' 일 때 수량 0 을 허용했다. 선발행
-- LOT(번호 슬롯만 잡고 실물이 아직 없는 것)을 담으려던 자리인데, 그 개념은 이제
-- lifecycle_status_code = 대기 가 담는다.
--
-- 그리고 이 'PREISSUED' 는 «어디에도 없는 문자열»이다 — 저장소 전수 확인 결과
-- 이 CHECK 한 줄이 유일한 등장이다. 코드값 시드에도, 계약 7벌에도, 화면에도 없다
-- (계약의 lotTypeCode 예시는 MATERIAL 이고 「확정된 값 목록이 아직 없다」고 적혀 있다).
-- 값 집합을 코드값이 아니라 CHECK 에 박으면 이렇게 조용히 죽는다.
--
-- 설계 회신이 단순형을 확정했다. 선발행 슬롯도 계획 수량을 갖는다 — 「실물 미귀속」은
-- 수량이 0 이라는 뜻이 아니라 아직 실적이 붙지 않았다는 뜻이고, 그것은 생명주기 축이
-- 말한다.

ALTER TABLE trace.lot DROP CONSTRAINT ck_lot_initial_qty;
ALTER TABLE trace.lot
    ADD CONSTRAINT ck_lot_initial_qty CHECK (initial_qty > 0);

-- status_code 의 DEFAULT 'ACTIVE' 를 없앤다.
--
-- 이 컬럼은 품질 판정 축이고 그 값 집합은 정상·불량·검사 대기·폐기다(공유계약 G-2).
-- 'ACTIVE' 는 그 넷 중 어느 것도 아니다 — 생명주기 축의 어휘가 품질 축의 기본값으로
-- 들어가 있었다. 값을 안 주고 LOT 을 만들면 어느 축에도 속하지 않는 판정이 붙는다.
--
-- 다른 값으로 바꾸지 않고 없앤다. 입하 LOT 은 보류로 생기고(M-01-01 §5-4) 생산 LOT 은
-- 흐름에 따라 다르므로 「모든 LOT 의 초기 품질 판정」이라 할 만한 값이 없다. 부르는
-- 쪽이 정하게 두는 편이 조용히 틀린 값을 다는 것보다 낫다.

ALTER TABLE trace.lot ALTER COLUMN status_code DROP DEFAULT;

COMMENT ON COLUMN trace.lot.status_code IS
    '품질 판정 축(정상·불량·검사 대기·폐기 — LOT_STATUS). 생명주기 축인 lifecycle_status_code 와 다른 축이다. 기본값을 두지 않는다 — LOT 이 생기는 흐름마다 초기 판정이 달라 부르는 쪽이 정한다. 근거: 공유계약 G-2 · §I-32.';
