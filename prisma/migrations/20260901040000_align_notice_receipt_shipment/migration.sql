-- 전표 계열 셋을 계약에 맞춘다 — 공지 · 입고 원천 · 출하 시간대.
--
-- 요청: 설계 회신 2026-09-01 E-4·E-6(공지) · E-2(입고 원천) · A-3(출하 시간대)
-- 계약: app-공통.json 의 Notice·NoticeCreate·NoticeAcknowledgement ·
--       logistics-01자재창고.json 의 GoodsReceipt · shipment-04제품출하.json

-- ═══ 1. app.notice — 게시 기간·대상 범위 ═════════════════════════════════════
--
-- 설계팀 문서 세 곳이 「공지 표가 물리에 없다」고 적고 있었는데 실재한다. 그것을
-- 확인해 주자 답이 「표 2개 신설」이 아니라 「컬럼 신설」로 정해졌다(회신 E-4).
--
-- 다섯 칸이다. #63 은 셋(scope_code·target_work_order_id/no)만 들었으나, statusCode 를
-- 게시 기간으로 파생하려면(#64-4) 기간 칸이 있어야 하고 계약에도 있다.
--
-- date 다 — 계약이 format: date 이고 시각을 담지 않는다. 서버가 공장 로컬 날짜로
-- 읽는다. business_date 처럼 timestamptz 에서 캐스팅해 얻는 값이 아니다.

ALTER TABLE app.notice
    ADD COLUMN start_date date,
    ADD COLUMN end_date date,
    ADD COLUMN scope_code app.code_t,
    ADD COLUMN target_work_order_id bigint REFERENCES production.work_order(work_order_id),
    ADD COLUMN acknowledge_required boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN app.notice.start_date IS
    '게시 시작일. status_code 를 파생으로 옮기면 이 값과 end_date 가 DRAFT/SCHEDULED/PUBLISHED/CLOSED 를 가른다. 「내려버리기」는 end_date 를 오늘로 당기는 것이지 상태를 직접 쓰는 것이 아니다.';

COMMENT ON COLUMN app.notice.scope_code IS
    '공지 대상 범위(5값 enum — 1차는 COMPANY·WORK_ORDER 둘만 유효). WORK_ORDER 이면 target_work_order_id 가 필수이고, 짝이 어긋나면 서버가 400(code=PAIR)으로 막는다 — 값 문자열을 CHECK 에 박지 않는다.';

COMMENT ON COLUMN app.notice.acknowledge_required IS
    '참이면 읽은 사람이 확인을 눌러야 한다. 이 값이 켜진 공지는 :dismiss(확인 없이 닫기)가 400 이다.';

-- ⚠ 신설 셋을 NOT NULL 로 올리지 않는다. 계약은 startDate·scopeCode 를 required 로
--   두지만 기존 행에 채울 값이 없다 — 「언제부터 게시했나」는 데이터에 없다.
--   서버 구현이 값을 채우기 시작한 뒤 두 번째 릴리스에서 올린다.
--
-- ⚠ targetWorkOrderNo 는 컬럼을 만들지 않는다. 표시용이라 production.work_order 를
--   조인해 파생한다 — 저장하면 작업지시 번호가 바뀔 때 어긋난다.
--   acknowledgedCount·targetCount 도 같다(집계 파생).
--
-- ⚠ status_code 는 남겨 둔다. 계약이 파생값이라 했으나(#64-4) 서버가 파생 계산을
--   시작한 뒤라야 「사용 제거」 단계가 성립한다. 컬럼 삭제는 그다음 릴리스다.
--
-- ⚠ 계약의 body 는 우리 content 다. 이름만 맞추자고 컬럼을 갈면 두 릴리스가 필요해
--   두고, 계약 쪽에 대응 표기를 달아 달라고 요청한다.

-- ═══ 2. app.notice_acknowledgement — 확인과 열람을 가른다 ════════════════════
--
-- 지금은 시각 하나뿐이라 「확인했다」와 「보기만 했다」가 구분되지 않는다. 계약이
-- 셋을 가른다 — 확인=참·시각 있음 / 확인=거짓·시각 있음(열람) / 행이 없음(미확인).
-- :dismiss 오퍼레이션이 가운데를 만든다.

ALTER TABLE app.notice_acknowledgement
    ADD COLUMN acknowledged boolean NOT NULL DEFAULT false,
    ADD COLUMN worker_no app.business_no_t,
    ADD COLUMN worker_name app.name_t;

ALTER TABLE app.notice_acknowledgement
    ADD CONSTRAINT ck_notice_acknowledgement_worker
        CHECK ((worker_no IS NULL) = (worker_name IS NULL));

COMMENT ON COLUMN app.notice_acknowledgement.acknowledged IS
    '참이면 확인, 거짓이면 열람(닫기)이다. 행이 아예 없으면 미확인 — 셋을 같은 모양으로 그리지 않는다.';

COMMENT ON COLUMN app.notice_acknowledgement.worker_no IS
    '현장 단말에서 확인했으면 사번이 온다. FK 가 아니라 스냅샷 문자열인 것은 현장 작업자가 계정을 갖지 않기 때문이다 — 서버가 인증 토큰의 종류로 가른다. worker_name 과 짝이다.';

-- ⚠ acknowledged_at 은 NOT NULL 로 둔다. 회신 E-6 이 완화에 동의했으나 계약 원문이
--   더 좁다 — 「이 시각은 «닫기»로 남은 행에도 찍힌다 · 행이 없음 = 미확인」이다.
--   행이 있다는 것 자체가 누군가 보았다는 뜻이라 시각 없는 행은 뜻이 없다.
--   완화하면 그런 행이 들어올 수 있다. 이 판단을 설계팀에 알린다.

-- ═══ 3. logistics.goods_receipt — 원천 문서를 비울 수 있게 ═══════════════════
--
-- 출하가 끝난 뒤 되돌아오는 반품 입고처럼 가리킬 원천 문서가 없는 갈래가 성립한다
-- (2026-08-31 사용자 확정 · omf-mes#302). 계약이 둘 다 nullable 로 바꾸고 required
-- 에서도 뺐다.
--
-- 「없음(NONE)」을 값으로 두지 않는다 — 가리킬 대상이 없는 값을 다형 참조 판별자에
-- 섞지 않는 것이 공유계약 A-10 이다. 대신 짝으로 묶어 한쪽만 채운 행을 막는다.
--
-- ⚠ goods_issue 의 같은 두 칸은 건드리지 않는다. 계약이 여전히 required 이고, 설계팀이
--   예비품 출고의 네 번째 원천(보전 지시)을 정리해 회신하겠다고 했다 — 그때까지 둔다.

ALTER TABLE logistics.goods_receipt
    ALTER COLUMN source_document_type_code DROP NOT NULL,
    ALTER COLUMN source_document_id DROP NOT NULL;

ALTER TABLE logistics.goods_receipt
    ADD CONSTRAINT ck_goods_receipt_source
        CHECK ((source_document_type_code IS NULL) = (source_document_id IS NULL));

-- ═══ 4. logistics.shipment_request — 시각 범위를 코드값으로 ══════════════════
--
-- 우리가 #41 회신을 기다리는 동안 시각 범위 2칸으로 만들어 두었던 자리다. 설계가
-- 코드값 3종(SHIPMENT_TIME_SLOT — 오전·오후·야간)으로 확정했다.
--
-- 시각 경계는 담지 않는다. 코드값은 슬롯을 가리키는 이름일 뿐이고 시각을 요구하는
-- 자리가 계약·화면 어디에도 없음을 설계팀이 전수 확인했다(회신 A-3).
--
-- 기존 CHECK 가 end > start 라 자정을 넘기는 야간 슬롯을 담지 못했다 — 코드값 전환이
-- 그 결함까지 함께 없앤다.
--
-- 여기서는 새 칸만 세운다. 옛 두 칸과 CHECK 제거는 「사용 제거 배포 → 다음 릴리스에서
-- 삭제」의 첫 단계로, 쓰는 코드가 아직 없으므로 이 릴리스가 곧 사용 제거 단계다.
-- 삭제는 다음 릴리스에서 한다.

ALTER TABLE logistics.shipment_request
    ADD COLUMN ship_time_slot_code app.code_t;

COMMENT ON COLUMN logistics.shipment_request.ship_time_slot_code IS
    '출하 시간대(SHIPMENT_TIME_SLOT — MORNING·AFTERNOON·NIGHT). 시각 경계를 담지 않는다 — 슬롯을 가리키는 이름이다. ship_time_slot_start/end 를 대체하며 그 둘은 다음 릴리스에서 삭제한다.';

COMMENT ON COLUMN logistics.shipment_request.ship_time_slot_start IS
    '[사용 중지] ship_time_slot_code 로 대체됐다. 다음 릴리스에서 삭제한다 — 자정을 넘기는 야간 슬롯을 담지 못하는 결함이 있었다.';

COMMENT ON COLUMN logistics.shipment_request.ship_time_slot_end IS
    '[사용 중지] ship_time_slot_code 로 대체됐다. 다음 릴리스에서 삭제한다.';
