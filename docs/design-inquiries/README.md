# 설계 검토 요청서 — 단건 모음

커버리지 100 루틴(`../coverage-100/README.md`) 중 발생 시점마다 **한 건 한 파일**로 쓴다.
번호는 이미 보낸 1~15번(`~/omf-design-requests/설계-문의-2026-09-0*.md`)에 이어 **16번부터**.
루틴이 끝나면 한 파일로 묶어 사용자를 통해 설계팀에 전달한다(직접 소통 금지).

파일 이름: `NNN-짧은-제목.md`. 각 파일 머리에 아래 표를 채운다.

| 칸 | 뜻 |
|---|---|
| 걸리는 오퍼레이션 | `METHOD path` |
| 구현 상태 | 구현함(권고안대로) · 구현함(§2 절차 n-m) · 건너뜀 |
| 판정 | `coverage-100/README.md` §2 의 어느 단계·기준으로 골랐나 |
| 되돌릴 때 | 회신이 반대로 오면 무엇을 고치나 |

| # | 제목 | 상태 |
|:-:|---|---|
| 16 | 입고 라인의 소유 구분 칸 | 구현함(`OWNED` 고정) |
| 17 | 적치 규칙 `capacityQty` 의 쓰임 | 구현함(한도 미적용) |
| 18 | 결재선 `inProgressCount` 연결 칸 없음 | 구현 예정(I-1 · 유형 축 근사) |
| 19 | `IQC_SKIP` 승인 화면 · `screenId` 규칙 걸리는 유형 없음 | 구현 예정(I-1 · `openable=false`) |
| 21 | 승인 유형·대상 유형 표시명 원천 없음 | 구현 예정(I-1 · `"{type} #{id}"`) |
| 22 | 폐기 품의 결재선 `businessUnitId` 파생 매핑 없음 | 구현 예정(I-1 시그니처 · I-4 사용 · 8자리 null) |
| 23 | P/O 상태 축과 상신 뒤 잠금 — `REGISTERED` 밖으로 가는 오퍼레이션이 없다 | 구현 예정(I-2 · 계약 문자 그대로 · 전이 0) |
| 25 | 등록한 P/O 를 다시 여는 화면이 없다 | 구현 예정(I-2 · 7건 전건 열어 둔다) |
| 26 | 입고가 소비한 입하를 «전기 완료»로 옮기는 주체가 없고, 다시 여는 화면도 없다 | 구현함(I-3 · 전이 0 · §7-4 임시 자물쇠) |
| 27 | 입하 오류를 여는 화면·필터가 없다 | 구현함(I-3 · 등록·조회만 · 필터 없음) |
| 28 | 입하 사전부착 라인의 `supplierLotNo` 누락 — 계약이 안 막은 조합 | 구현함(I-3 · 400 `PAIR` · §2 2단계 기준 2) |
| 29 | 한 물리 공급사 LOT 이 정량분·초과분으로 갈릴 때 — `uq_lot` 이 `W-01-03` 대표 시나리오를 막는다 | 구현함(I-3 · `:split` 겹침 400 `INVALID` · §2 2단계 기준 2) |
| 30 | 폐기 출고의 승인 게이트를 걸 축이 데이터에 없다 — 화면은 「전건 차단」으로 읽었고 서버는 상신한 전표만 막는다 | 구현함(I-4 · 상신 흔적으로 가른다 · §2 2단계 기준 5) |
| 31 | 출고 라인이 잔액 차원 두 칸(`qualityStatusCode`·`inventoryStatusCode`)을 안 싣는다 | 구현함(I-4 · 2행 이상 400 `INVALID` · §2 2단계 기준 2) |
| 32 | 취소 실행이 역트랜잭션의 영업일·시각·번호를 아무것도 안 받는다 — 04 `ShipmentCancel` 은 `businessDate`·`occurredAt` 필수 | 구현함(I-5 · 영업일 = 원 트랜잭션 · `{원 번호}-R` · §2 0단계·기준 4) |
| 33 | 취소 승인이 반려되면 `CANCEL_REQUESTED` 를 되돌릴 경로가 없다 — `W-CO-09` §5-5·J-6 은 재상신을 전제 | 구현함(I-5 · 계약 문자 그대로 · 되돌리는 전이 0) |
| 34 | 후속 판정 축이 계약 문자와 화면에서 어긋난다 — ① `INVENTORY_TRANSACTION` 문서 하류/LOT 축 ② 출고 「사용」 축 없음 ③ P/O 후속 enum 없음 | 구현함(I-5 · LOT 축 · enum 그대로 · §2 0단계) |
| 35 | `:hold`/`:resume` 을 부르는 화면이 0건인데 W/O 층 「작업 중단」이 셋을 함께 잃는다 — ⓐ 사유 값 0건 ⓑ 구간 표 없음(`held` 는 상태 문자열 근사) ⓒ `RELEASED`→홀드→재개가 세션 없는 `IN_PROGRESS` | 구현함(I-6 · 계약 문자 그대로 · 셋 미저장 · §2 2단계 기준 3) |
| 36 | 선발행 슬롯의 `lot.sourceTypeCode` 값이 `LOT_SOURCE_TYPE` 2값에 없다 — `GET /trace/lots?workOrderId=` 은 그 값을 전제 | 구현함(I-6 · 시드 `WORK_ORDER` 1행 · §2 0단계) |
| 37 | `:release` 의 BOM 소요량 자동 산정 규칙이 어디에도 없다 — ⓐ `bom_component` 공정 칸 둘 중 어느 축 ⓑ `scrap_rate` 곱하나 | 구현함(I-6 · `routing_operation_id` 축 · 스크랩률 미적용 · §2 2단계 기준 1·4) |
| 38 | `:cancel` 이 이미 발행된 자재 출고요청을 어떻게 하는지 아무 문서도 적지 않았다 — 덤으로 `W-02-06` 에 `reasonCode` 고르는 칸 없음 | 구현함(I-6 · 요청 안 건드림 · §2 2단계 기준 1 · I-8 인계) |
| 39 | 마감 전 게이트 셋(POP 버퍼·미종료 홀드·실적 완결성)을 서버가 판정할 수단이 없다 — 계약 자인 | 구현함(I-6 · 게이트 0 · `OPEN_SESSION_EXISTS` 만 · §2 1단계 본길·계약 침묵) |
| 40 | 긴급 발행(계획 없는 `POST`)이 만들 내부 P/O 의 공장·사업부를 풀 값이 어디에도 없다 — `W-02-07` §8 미결 1 ①안 불성립 | 구현함(I-6 · 400 `REQUIRED` · `internal-plan.ts` 보류 · §2 2단계 기준 2) |
| 41 | 실적 정정 상신이 등급을 판정할 입력을 받지 않는다 — 「B급이라 승인이 필요 없다」 400 을 낼 축이 없고, 승인 한 건이 정정 몇 건을 여는지도 없다 | 구현함(I-7 · 그 400 갈래 미생성 · `APPROVED` 하나면 통과(소진 미계수) · R-21 로 실효 「행당 정정 1」 · §2 2단계 기준 3) |
| 42 | 병합된 I-6 코드가 정정 누계를 «합»으로 확정해 두었는데 I-7 이 «잎만»으로 뒤집는다 — `:close` 3분류·ERP 전송값의 정본 | 구현함(I-7 · 잎만(`ACTIVE_RESULT_WHERE`) · I-6 주석 둘 교체 · R-21 「이미 정정된 원본 400 `STATE_LOCKED`」 · §2 0단계 `W-02-05` §5-4) |
| 43 | 생산 LOT 완료의 미달 사유를 담을 칸이 LOT 쪽에 없다 — `work_order` 한 칸을 슬롯 여럿이 덮어쓴다(계약 x-internal-note ⌜B-13 미충족⌝) | 구현함(I-7 · W/O 한 칸 덮어쓰기 · 마감된 W/O 의 미달 완료는 400 `STATE_LOCKED` · §2 0단계 `P-02-06` §5-5) |
| 44 | 정정이 실적-LOT 배분을 고칠 길이 없다 — `:correct` 본문에 배분 칸이 없어 LOT 축 누계·`:complete` 판정이 정정을 못 따라간다 | 구현함(I-7 · 배분 미생성·미복사 · LOT 축은 원본 배분 그대로(리뷰 #242 Minor ①) · §2 2단계 기준 1·4) |
| 45 | 피킹 지시(`picking_order`/`picking_line`)를 만드는 오퍼레이션이 계약에 0건이고 예약을 «거는» 자리도 없다 — 배정 축 3겹(출발 창고·예약 차원·선출 규칙) 부재 · `GET /inventory/reservations` 는 언제나 빈 목록 | 구현함(I-8 · 조회 2·`:pick`·예약 목록은 계약대로 · 지시 생성·예약 생성·LOT 선출은 지어내지 않음 · 코어 `reserve()` 보류 · §2 2단계 기준 4 · `plan-uiux.md:579`) |
| 46 | `material_issue_request_line.issued_qty`(required · readOnly) 를 올리는 오퍼레이션이 계약에 없어 같은 «기출고»가 두 벌(칸 ↔ `goods_issue` 합계)이 되고 `ck_material_issue_line_qty` 가 무의미해진다 | 구현함(I-8 · 상세는 그 칸을 언제나 0 으로 · `shortage.issuedQty` 는 `goods_issue_line` 축으로 따로 셈 · 출고가 요청 라인을 되짚는 축 없음 · §2 2단계 기준 1·4) |
| 47 | 자재 출고요청 응답(`MaterialIssueRequest`·`…Line`·`…ShortageLine`)에 표시 라벨 칸(`itemCode`·`itemName`·`workOrderNo`·도착 위치 코드/명)이 0 — 같은 계약의 `PickingLine` 은 파생 9칸을 준다 · `W-02-10` 첫 열 「품목」·L-2 와 충돌 | 구현함(I-8 · `x-source-column` 1:1 · 라벨 칸을 지어 넣지 않음 · §2 2단계 기준 4) |
| 48 | 생산창고 입고 전표가 영원히 `REGISTERED` 이고(옮기는 오퍼레이션 0 · `DocumentProgress.documentTypeCode` 9값에 없음), 수령 전표가 선 `POSTED` 출고를 취소 판정(`cancel-eligibility`)이 못 본다 — `M-01-09` §8 #1 이 정정을 그 출고 취소로 돌렸으므로 본길 | 구현함(I-9 · 상수 `REGISTERED` · `transitions.ts` 키 없음 · 취소 판정은 I-5 코어라 안 고침 — 후속 프로브 1줄 · §2 0단계 선례 + 기준 1) |
| 49 | `ShopfloorReceiptLineCreate.issuedQty` 를 클라이언트가 보내는데 서버가 이미 아는 값(`goods_issue_line.issue_qty`)이고 `variance_qty` 의 GENERATED 분모가 된다 — 다를 때 무엇을 할지 계약이 침묵 | 구현함(I-9 · 대조해 다르면 400 `INVALID` · 덮어쓰지 않음 · §2 2단계 기준 2·4) |
| 50 | `POST /production/material-returns` 의 소유 화면이 없어 403 게이트에 넣을 근거를 서버가 지어내야 한다 | 구현함(I-10 · `manual-permissions.ts` 에 `P-02-03` 임시 등록 · §2 0단계 선례 넷째) |
| 51 | 자재 반출이 재고를 옮기는데 원장을 지날 수단이 계약에 하나도 없다 — 날짜 3칸·목적 «위치»·판별자·도착 오퍼레이션이 전부 0 | 구현함(I-10 · 전기 ✕ · `inventory_transaction_line_id` 영원히 NULL · `requested_at` 서버 시각 · §2 1단계 본길 → 기준 1·2·4) |
| 52 | ⭐ 「계보가 시작되는 지점」이라 적었는데 서버가 «어느 생산 LOT» 인지 가릴 축이 없다 — `material_usage_allocation` 도 주인이 사라진다 | 구현함(I-10 · `lot_relation`·`material_usage_allocation` 둘 다 0행 · 투입 상한 ✕ · §2 1단계 본길 + A-21) |
| 53 | 값 목록 없는 NOT NULL 코드가 여섯인데 계약이 「서버가 정한다」로만 적었다 — 판정 확인 요청(값 목록 요청이 아니다) | 구현함(I-10 · 상수 셋 `NORMAL`·`RECORDED`·`REQUESTED` · `return_quality_status_code` 는 NOT NULL 완화 · §2 0단계 + 기준 3·4) |
| 54 | ⭐ 단말 토큰을 정의만 하고 어느 오퍼레이션에도 걸지 않아 인증 축이 화면과 서버에서 갈렸다 — 단말 인증을 언제 세우나 | 구현함(I-10 · `terminal_id` NOT NULL 완화 + 키 생략) · 구현함(I-11 · `Authorization: Bearer` 로 읽고 세션 열기만 부재 시 403 · §2 1단계 본길 + F-6) |
| 55 | 자재 투입에 정정(`:correct`)이 없다 — 읽기 스키마에는 `correctsConsumptionId` 가 있는데 쓰기에 없다 | 구현함(I-10 · `corrects_consumption_id` 영원히 NULL · 삭제·취소 0건 · §2 1단계 본길 → 기준 5) |
| 56 | `work_session_worker.worker_role_code` 의 기본값 `'OPERATOR'` 가 `WORK_SESSION_WORKER_ROLE` 2값에 없다 | 구현함(I-11 · 물리 default 를 그대로 탄다 · 마이그 0 · 시드 무변경 · §2 1단계 본길 → 기준 3·4) |
| 57 | ⭐ 세션의 작업자 귀속이 오늘 0건으로 선다 — REQ-PR-0023 이 화면·계약 어디에도 착지하지 못했다 | 구현함(I-11 · `X-Worker-No` 읽고 버림 · 참여자 자동 등록 ✕ · 참여·이탈 `P-02-01` 임시 등록 · §2 기준 4 + 0단계 선례) |
| 58 | 세션 `:end` 가 참여 중인 작업자를 어떻게 하는지 아무 문서도 적지 않았다 | 구현함(I-11 · `left_at` 자동 ✕ · 종료 세션에서도 `:leave` 허용 · §2 1단계 본길 → 기준 4) |
| 59 | ⭐⭐ 적치 원장의 판별자가 `STOCK_TRANSFER` 인데 그 표는 적치를 모른다 — 되돌릴 수 없는 행이 오늘부터 쌓인다 · **I-13 착수 «전»에 답** | 구현함(I-12 · `(STOCK_TRANSFER, putaway_task_id)` · `transactionNo = putaway_task_no` · §2 1단계 본길 → 후보 넷 중 가장 덜 어긋나는 것) |
| 60 | 임시 적치가 dead end 다 — 정위치로 되돌릴 오퍼레이션이 0건이고, 되돌릴 때 볼 사유·원장도 응답에 없다 | 구현함(I-12 · `COMPLETED_TEMPORARY` 종단 · 응답에 사유·비고·원장 3칸 없음 · §2 1단계 본길 → 기준 4) |
| 61 | 취소된 입고의 적치 지시가 `PENDING` 인 채 영원히 남는다 — 닫을 값도 오퍼레이션도 없다 | 구현함(I-12 · 완료를 400 `STATE_LOCKED` 로 막기만 · 다형 취소 무변경 · §2 0단계 선례 I-5 §6-4) |
| 62 | 적치를 «누가» 했는지 남을 칸이 0 이다 — `X-Worker-No` 를 존재만 확인하고 버린다 | 구현함(I-12 · `assigned_worker_id` 에 안 쓴다 · §2 0단계 선례 057) |
| 90 | 설비 고장 원인 마스터 원천과 완료 본길 | I-30 complete1건 보류, PUT의 원인 nonnull만 명시 거부 예정 |
| 91 | 점검·고장 저장 결손과 과거 필수값 | A15 nullable8추가·2완화 계획, 과거 required/enum 환경은 별도 배포 판정 |
| 92 | 고장 보고 성공과 알림·사진 미지원 | 알림 의사만 저장 예정, 발생·전송·첨부 제외 및 인증/CORS 한계 |
| 93 | 고장 start400 문언과 ETag 재조회 | 상태잠금400·숫자 토큰은 상세 재조회, 구현 전 |
| 94 | 점검·고장 기간의 공장 로컬 날짜 | Intl 경계 준비 PR 분리, SQL 타임존 캐스팅·저장 날짜 변경0 |
| 95 | 고장 복수 지시와 소수 분 null 의미 | 복수 연결ID/소수 분 null, 목록count0은 상세 집계의 대체가 아님 |
| 96 | 설비 멱등 주체와 업무 트랜잭션 | 로컬 지문·전달 tx 계획 확정, 공용 runner 변경0 |
| 97 | 오프라인 점검 판정 책임과 측정 정밀도 | 단말 필수/자동 판정, 서버의 미검증 범위와 Decimal20,6 무손실 검증 계획 |
| 98 | EQI·MLF 채번 날짜와 트랜잭션 경계 | UTC 번호 날짜·tx 밖 선채번·결번 허용 계획, 기존 문의14 연계 |
| 99 | 알림 eventCode 정본 부재 | I-28 이벤트/구독3건 보류, 조회2건 #295 병합·읽음/preview3건 후속 |
| 100 | 이벤트별 구독 헤더와 미설정 ETag | 조건부 계획 확정·현재 마이그0 |
| 101 | 알림 규칙 수·비활성 표시·실제 수신 인원 | 구현 예정·users 전원/totalCount 활성 |
| 102 | 알림 대상 화면·위치와 enum 밖 과거값 | 구현 예정·openable=false/optional 생략, 읽음 가능 |
| 103 | 알림 멱등 주체 격리와 공통 오류 | 구현 예정·로컬 지문/전달tx, 공용 수정0 |
| 104 | 제품 개체 최초 필수 상태의 값/위임 원천 | I-26 POST1 본길 유보, 기존 개체 GET1은 별도 진행 |
| 105 | LOT 배분 단위와 개체 개수 대응 | 정상 허용 수량 집합의 근거가 POST 재개 조건, I-7·정정044 무변경 |
| 106 | 시리얼 번호 연속성과 선택 If-Match 원천 | 서버 채번 권고·결번/연속 구분, 헤더 제공 건은 재개 전 R 확정 |
| 107 | 발번 귀속과 단계별 멱등 보존 | 실제 계정/사번/단말 축, N targets·단계별 키·기록 삭제 후 복구 책임 |

090~107은 B의 I-30/I-28/I-26 요청서로 작성됐다. 번호 대역은 `coverage-100/lanes.md` §1-1을 따른다. 계획 확정과 구현 완료는 각 행의 상태로 구분한다.

번호 20 은 결번 — 「`INBOUND_LOT` 대응 표 없음」으로 세웠다가 계약 안에 답이 있어(19 각주) 철회.
번호 24 도 결번 — 「`erp_purchase_order_no` 유일 제약」으로 세웠다가 `W-01-11` §8 #3(「강제는 서버·DB 몫」 · 계약 반영 완료 · 이슈 재발행)과 §8 #4(「도메인 02 스펙 작성 시 함께 본다」)가 물음도 일정도 이미 세워 둔 것을 확인해 철회(I-2 재수립 R-9). 우리가 부분 유일을 걸었다는 사실은 아래 「알려둘 것」에 남긴다.

**알려둘 것**(번호 없음 · 다음 전달분 말미)
- (I-1) `PUT /app/approval-routes/{id}/steps` 200 에 ETag 를 내린다(계약 미선언 · 자식 치환 선례) · `GET /app/approval-requests?requestedByMe` 와 M-01-13 「내가 올린 요청」은 계정 세션이 있어야 한다(단말 토큰 부재 → 401).
- (I-2) `…:request-approval` 은 `purchase_order.approval_request_id` 를 쓰면서 `version_no` 를 올리지 않는다(202 에 ETag 가 없다) — 같은 판정이 나머지 8 상신자에 복사된다 · 대상이 있는 P/O 쓰기 3건이 전부 404 미선언인데 우리는 404 를 낸다 · `W-01-11` §5-6 의 `approver_type_code = DEPARTMENT` 는 계약이 「USER 외 400」이라 1차 결재선을 사람으로 심는다 · **`uq_purchase_order_erp_no` 부분 유일을 걸었다 — 02 P/O 수신 I/F 는 이 제약을 전제로 삼아 달라**(중복 수신은 400) · 문의 14 의 표에 `purchase_order_no` 한 행을 더한다.
- (I-3) `slices/I-3.md` §7-5 ⓐ~ⓗ · R-11 ⓘ~ⓡ 18건이 정본이다. 그 위에 구현·리뷰가 더한 것: **`:split` 은 한 요청이 채번을 둘 소모하고 트랜잭션이 깨지면 둘 다 결번**(§4-3) · `lot.manufactured_at` 을 채우지 않아 제조일이 LOT 쪽엔 없다(§7-5 ⓖ) · 무발주 `exceptionTypeCode` 필수가 등록에는 서고 `:split` 에는 안 선다(R-7 ②) · `:split` 에 `If-Match` 가 없고 `:split`·`…/variances` 는 409 미선언인데 멱등 409 를 낸다 · `…/variances` 404 는 계약 미선언 · `SplitPart` 에 `vehicleNo` 가 없어 초과 분리 도착의 차량번호가 유실된다(실려 오면 서버는 저장한다) · 등록이 계약에 없는 `remarks` 를 받아 저장한다 · LOT 이 붙은 부착 라인의 수량·품목을 치환으로 바꿀 수 있어 `lot.initial_qty` 와 어긋날 수 있다(026 갈래 ③ 의 입고 없는 판) · `PUT …/{id}` 헤더 FK 오류 문구가 등록 경로와 다르다(공용 그물) · 조회 4건에 403 이 없다(계약 미선언) · 입하일 필터는 UTC 하루다(하노이 06:00 도착이 전날에 잡힌다 · 입고 선례) · 목록 정렬은 `receipt_datetime` desc + PK(계약 침묵 · P/O 선례) · `labelIssued` 는 `document_issue_log.lot_id` 가 채워져야 산다 — 라벨 발행(`P-01-01`)이 `lot_id` 를 반드시 채워야 한다 · `document_issue_log(lot_id)` 인덱스가 없다(후속 마이그) · LOT 코어는 없는 `sourceId` 를 400 으로 거절한다 · 문의 14 의 표에 `inbound_receipt_no` 한 행을 더한다.
- (I-4) `slices/I-4.md` §8-3 ⓐ~ⓘ · R-9 ⓙ~ⓝ · §8-4 ⓞ~ⓡ **18건**이 정본이다. 요지: M-c 마이그는 이미 적용돼 계약 노트 둘이 낡았다(ⓐ) · `:post`·`PUT …/lines` 200 에 ETag 없음, `:request-approval` 은 `version_no` 도 안 올림(ⓑ) · 404·400 미선언인데 낸다(ⓒ·ⓡ) · 출고일 필터 UTC 하루(ⓓ) · `erpMessageQueued=false` 고정(ⓕ) · 문의 022 권고안 ②의 `item.business_unit_id` 는 없는 칸(ⓗ) · `PUT …/lines` 를 부르는 화면 0건(ⓙ) · **승인 뒤 전기 전 라인 치환을 `STATE_LOCKED` 로 막는다 — 계약 밖 자물쇠**(ⓞ) · `AP-` 채번 기간키 UTC(ⓠ).
- (I-5) `slices/I-5.md` §9-3 ⓐ~ⓛ · R-12 ⓜ~ⓤ **21건**이 정본이다. 요지: 취소 흔적의 정본은 `app.document_cancellation` 한 표(`goods_issue` 3칸 영구 널) · 역행 번호 `{원 번호}-R` · `screenId` 영구 생략 · `SUCCESSOR_EXISTS` 400 에 후속 목록 없음 · 반려로 잠긴 문서는 DB 직접 수정뿐.
- (I-6) `slices/I-6.md` §9-3 ⓐ~ⓩ **25건** + §11-2 ⓐ~ⓘ(구현·리뷰가 더한 9건)이 정본이다. 요지: 다섯 액션·`PUT` 200 에 ETag 없음(본문 `versionNo` 로 다음 If-Match) · `handoverNote`·`WorkOrderCancel.note`·`dueDate`(계획 있을 때) 를 받아서 버린다 · `resource-plans` 3건과 목록·상세 GET 은 403 미선언 · `ix_work_order_dispatch` 가 죽은 상태값을 문다 · `:release` 실패 시 `MIR-` 결번 · 4M 유일은 식 유일 인덱스라 `schema.prisma` 밖 · 마감 뒤 UPDATE 는 DB 트리거가 500 으로 막을 수 있다 · `W-02-08` 「달성률」 정렬 400 · **문의 14 의 표에 `work_order_no`·`issue_request_no` 두 행을 더한다**(`WO-{YYYYMMDD}-{SEQ4}` · `MIR-{YYYYMMDD}-{SEQ4}` — `plan_no`·`production_order_no` 는 040 답 뒤). 구현이 더한 것: `:hold` 의 `reasonCode` 공백은 400 · `:hold`/`:resume` 403 e2e 없음 · `WO-`·`MIR-` 번호의 날짜가 UTC 라 하노이 새벽 발행이 전날 번호를 받는다 · 계획 없는 `POST` 는 400 `REQUIRED`(040 답 전까지) · `:cancel` 은 `note` 를 버리고 `remarks` 를 안 건드린다 · `LotLifecycleService.moveWithin()` 이 LOT 의 `version_no` 를 올린다(선발행 LOT 을 든 화면의 If-Match 가 확정배포 뒤 낡는다) · `:close`/`:cancel` 의 If-Match 400/409 와 멱등 재전송의 아웃박스 단일 적재는 e2e 가 없다(후속).
- (I-7) `slices/I-7.md` §9-3 ⓐ~ⓩ **26건** + §11-2(구현·리뷰가 더한 것)이 정본이다. 요지: `resultSourceCode` 는 셸이 보내는 값(서버 도출 없음) · 계약 제약 이름 오기(`ck_production_result_qty` → 실제 `ck_production_result_nonzero`) · D1 뒤 `shiftId` 필터 영원히 0건 · `terminal_id` 영원히 NULL(단말 토큰 없음 · 게이팅 2플래그 미검사) · `PR-{YYMMDD}` 가 UTC 날짜 · `note`↔`remarks` · 「B급 400」 도달 불가(041) · `lot-lifecycle-events` 쪽 나눔 없음 · 단건 GET·`lot-lifecycle-events` 권한 표 미등재(403 미선언) · `:complete` 의 `X-Worker-No` 는 받아서 버린다 · D2 `correct_reason_code` 는 우리가 만들었다(📨 데이터모델) · `CLOSED` W/O 에도 실적·정정이 들어간다(마감 뒤 ERP 전송값과 조회값이 갈린다 — 재송신 축 없음) · `production_result.version_no` 는 안 올린다 · 멱등 72h 뒤 재전송은 도메인 UNIQUE 가 400 `UNIQUE_VIOLATION` · I-6 L2 `sourceDocumentTypeCode` 를 `WORK_ORDER_CLOSING` 으로 고쳤다 · 재완료 400 `STATE_LOCKED` · `PRODUCTION_RESULT_CORRECT_REASON`·`LATE_ENTRY_REASON` 값 0건(대조 안 걺 · 드롭다운이 빈다 · 시드 요청) · `:complete` 200 에 ETag 없음(완료 뒤 `GET` 재조회) · 목록에 `lotId` 질의 없음 · `completed=` 질의가 처음 살아난다. 구현·리뷰가 더한 것: Express 가 미선언 자리에도 약한 ETag `W/"…"` 를 붙인다(If-Match 에 되쓰면 NaN) · `ProductionResult` 23칸 · `POST` 실적의 404 미선언인데 404 · DB-C18 배분 상한이 계약에 없다(화면이 안 막으면 400) · `ROUTE_AMBIGUOUS` 도달 불가 · **이미 정정된 원본은 400 `STATE_LOCKED`**(R-21 — 화면은 정정 이력의 «잎»을 골라야 한다) · 승인받은 원본을 B급으로 정정하면 그 승인이 잠긴다 · **LOT 축 진척(`Lot.progress`·`:complete` 판정)은 실적 정정을 반영하지 않는다**(정정본이 배분을 안 만든다 — W/O 축과 갈린다 · 044) · 비생산 LOT 의 `withProgress=true` 는 늘 `UNDER` · `achievementRate` 는 `initialQty=0` 이면 키 생략 · 미달 기록이 `work_order.version_no` 를 안 올린다 · 마감된 W/O 의 미달 완료 400 `STATE_LOCKED`(정상·초과는 통과) · 원천 W/O 부재 400 `INVALID`.
- (I-8) `slices/I-8.md` §10-3 ⓐ~ⓞ **13건**(ⓕ→045 · ⓗ→047 흡수) + §11-3(구현·리뷰가 더한 것)이 정본이다. 요지: 8건 전건 ETag 없음(`plan-uiux.md` U11 표와 어긋남) · `:pick` 의 `X-Worker-No` 를 담을 칸이 없어 피킹 행위자가 안 남는다(필수 판정만) · 출고 취소 뒤 같은 피킹으로 재출고하면 출고 확정이 400(`reverse()` 가 `picked_qty` 를 안 되돌림 · 되돌릴 화면 없음) · 계획의 BOM 이 바뀌면(`ProductionPlanUpdate.bomId` 실재) `shortage` 가 선발행 슬롯 스냅샷과 갈린다 · `:release` 요청 0건이 실패인지 정상 0건인지 가를 칸 없음(정상 사유 셋) · 피킹 목록에 `sourceDocumentTypeCode` 질의가 없어 자재·제품 피킹이 섞인다(I-22 뒤) · 같은 품목이 `bom_component` 두 줄이면 `shortage` 가 품목으로 합치고 `bomComponentId` 생략 · `:pick` 이 `picking_order.status_code` 를 안 옮긴다(`LOGISTICS_DOCUMENT_STATUS` 에 「완료」 없음) · `plan.md` 106 의 e2e 감지는 설 수 없다(정적 가드로 대신) · `POST /logistics/material-issue-requests` 404 미선언인데 없는 W/O·위치에 400 `INVALID` · `:pick` 으로 피킹을 0 으로 되돌릴 수 없다(`exclusiveMinimum: 0` · `:unpick` 0건) · `PickingLine.held` 는 `lot_hold` 파생뿐이라 `blocks_picking` 만 참인 라인은 활성으로 그려지고 스캔 뒤 400(오늘 통제표 0행) · 보류가 겹친 LOT 은 `holdReasonCode` 하나만. 구현·리뷰가 더한 것: 요청 발행의 `lines: []` 는 `LINE_REQUIRED` 가 아니라 계약 가드의 **`RANGE`**(`minItems`) · W/O 존재·상태 판정이 tx 밖이라 판정~INSERT 사이 취소된 W/O 에 `REGISTERED` 요청 1행이 남을 수 있다(문의 038 이 허용한 형상 · 500 아님) · 피킹 조회 2건 403 미검사(계약 미선언) · `pickSequenceRank` 는 정렬 키가 널이면 널 · 피킹 소진의 축은 출고 **헤더** `sourceDocumentTypeCode='PICKING_ORDER'`(라인 `pickingLineId` 는 되짚기용 선택 칸 — 화면이 비워도 소진된다) · 다른 위치에서 피킹한 분을 이 위치에서 소진하면 400 `NEGATIVE_BALANCE`.
- (I-9) `slices/I-9.md` §8-3 ⓐ~ⓙ + R-19 ⓚ~ⓠ **17건** + §11-3(구현·리뷰가 더한 것)이 정본이다. 요지: 3건 전건 ETag 없음(`plan-uiux.md` U13 과 어긋남) · 같은 계약 안에서 라벨 칸의 결이 갈린다(`ShopfloorReceiptLine` 3칸 ↔ `MaterialIssueRequestLine` 0칸 · 047) · 수령의 `work_order_id` 가 출고 원천 W/O 와 같은지 서버가 대조하지 않는다(045 의 다형 2홉) · `destinationLocationId` 가 «생산창고» 인지 검사하지 않는다(`LOCATION_TYPE` 에 그 축 없음) · `assertWorkerNo` 셋째 사본 · `(goods_issue_id)` UNIQUE 없음 — 「한 출고 = 수령 하나」는 `FOR UPDATE` 애플리케이션 잠금뿐 · 목록 FK 두 칸에 인덱스 없음(후속 마이그) · `SR-` 번호 날짜는 클라이언트 `businessDate`(I-6 의 UTC 축과 갈린다) · 상세 `lines` 두 벌 · `POST` 404 미선언인데 없는 출고·W/O·위치에 400 `INVALID` · 조회 2 는 403 미선언 · **화면 `M-01-09:103·238` 「§C 어디에도 없다」 문장이 C-10 뒤로 낡았다** · 수령자=세션 계정이라 단말 공용 계정이면 받지 않은 사람이 남고 `receivedByName` 류 표시 칸 0 · `M-01-09` §6 예외표에 400 행 셋(전기 전·취소·이미 수령) 부재 · W/O 상태를 안 본다(물건이 이미 떠났다) · 목록 정렬 PK 역순 ≠ `received_at` 순(오프라인 재전송) · 계약 `varianceReasonCode` 설명에 «차이 0 이면 보내지 않는다» 한 줄이 없어 서버가 400 으로 닫았다 · `M-01-09` §5-5 「여러 W/O 면 수령을 나눈다」 예고를 헤더 축 400 이 닫는다(라인 전건 필수 · R-1).
- (I-10) `slices/I-10.md` §8-3 ⓐ~ⓤ **21건**(R-14) + §11-3(구현·리뷰가 더한 것)이 정본이다. 요지: 6건 전건 ETag 없음(`plan-uiux.md` U23 표와 어긋남) · 투입·반출 둘 다 W/O 상태를 안 본다(마감·취소 W/O 에도 들어간다) · 투입 상한(`received_qty`)을 안 세고 반출은 잔량·창고 유형을 안 본다 · `material_substitution_rule` 을 안 봐서 대체품 투입은 BOM 밖 품목이라 400 · 같은 품목이 `bom_component` 두 줄이면 `sequence_no` 첫 줄 · `MC-`·`MR-` 번호의 날짜가 **UTC** 라 하노이 새벽이 전날 번호를 받는다 · 투입·반출 응답에 표시 라벨 칸이 **0개**(047 과 같은 뿌리) · 409 봉투에 required `code` 가 빠진다(멱등 계층 · e2e 33파일 회귀 면 때문에 후속 소형 PR) · `corrects_consumption_id`·`actual_consumed_qty`·`received_at` 셋은 영원히 빈다 · `enteredQty`↔`inputQty` 환산을 안 하므로 **화면이 환산 주체**다 · `uomId` 와 `bom_component.uom_id` 의 관계를 계약이 안 적어 대조하지 않는다(ⓢ) · 교차 투입 배지의 판별 축이 응답에 없다(ⓣ) · 반출의 「같은 공장」 거부는 **이 슬라이스가 계약 없이 더한 유일한 거부**다(ⓤ · 완화가 싸다) · 목록 필터 두 칸과 `shopfloor_receipt_line` 에 인덱스가 없다(후속 마이그). 구현·리뷰가 더한 것: 본문의 `bomComponentId`·`shopfloorReceiptLineId`·`actualUseProcessId` 를 **받아도 무시하고 서버 값으로 덮는다**(400 아님 — 계약에 「보내면 거절」이 없다) · `app.code_t` 세 칸의 빈 문자열과 음수 `enteredQty` 가 500 으로 새던 자리를 400 으로 앞당겼다(리뷰 Major) · `schema.prisma` 의 `terminal` relation 도 optional 이 됐다(Prisma 검증).
- (I-11) `slices/I-11.md` §11-3 ⓐ~ⓛ **12건**(R-13 이 ⓜ 를 지우고 ⓝ~ⓠ 넷을 더한다) + §14-3(구현·리뷰가 더한 것)이 정본이다. 요지: **`work_session.shift_id` 의 NOT NULL 을 우리가 풀었다**(마이그 1 · D1 선례 · 정본 모델 역반영 필요) · `open=false`·`active=false` 는 **여집합**으로 읽었다 · `controlLevelCode` 를 서버가 대조하지 않는다(`app.operation_policy` 0행 — 켜면 전건 400) · `basisInspectionId` 는 FK 존재 검사만(`maintenance` 모듈이 없다) · `:end`·events·`/workers` 에 **단말 게이팅을 안 건다**(8플래그에 「중단」이 없다) · 세션 열기가 `controlOverride` 를 받을 때 긴급 W/O 판정을 한 번 더 한다 · `controlOverride.note` 를 버린다(담을 칸 0) · `assertWorkerNo` 4·5번째 사본 · **If-Match 의 대조 대상이 자리마다 다르다**(세션 열기는 W/O · events·`:end` 는 세션 · 참여는 읽되 안 올린다 — 계약이 한 번도 적지 않았다) · `ProductionConflictResponse` enum 셋이 영원히 빈다(400 `STATE_LOCKED` 로 닫았다) · `:end` 의 `stopReasonCode` 를 받아서 저장하지 않는다 · 자식 GET 둘이 404 미선언인데 404 를 낸다 · (R-13) 오프라인 재전송 중 계정 세션이 만료되면 401 이 먼저 난다 · 세션 열기만 오프라인 대상이 아니라 같은 도메인 안에서 처리가 갈린다 · 점검 NG 인데 `OVERRIDDEN` 이 통과한다 · `/workers`·`:leave` 의 사번 부재가 화면 규약과 어긋난다. 구현·리뷰가 더한 것: **상태가 같으면 W/O 를 UPDATE 하지 않는다**(둘째 세션마다 화면의 W/O ETag 가 낡던 자리를 없앴다) · `plant.timezone_code` 가 비-IANA 면 교대 도출이 던지므로 `shift_id = NULL` 로 둔다(계약 ⌜세션을 막지 않는다⌝) · 단말 토큰 파싱이 컨트롤러에서 사번 검사보다 **앞서** 두 헤더가 함께 어긋나면 `Authorization/INVALID` 가 먼저 난다 · `:end` 도 낡은 토큰이면 400 이라 오프라인 재전송의 창이 열린다.
- (I-12) `slices/I-12.md` §9-3 ⓐ~ⓝ **14건**(R-13) + §12(구현·리뷰가 더한 것)이 정본이다. 요지: `completed_at = occurredAt`(서버 시각 아님) · 혼적·수용량·보관조건·`TEMP` 위치유형을 서버가 안 본다 · `warehouseManagementLevelCode` 로 분기하지 않고 언제나 `actualLocationId` 를 요구한다 · 목적 창고 밖 위치는 임시 적재도 400 `INVALID` · 두 POST 의 404 미선언인데 낸다 · 적치 원장이 `GET /inventory/transactions?sourceDocumentTypeCode=STOCK_TRANSFER` 에 섞여 나온다(059 와 짝) · **비관리 창고에서도 권장이 없으면 셸이 `confirmedNoRule=true` 를 실어야 한다**(안 실으면 400 `REQUIRED`) · 권장이 있으면 `confirmedNoRule` 을 읽지 않는다 · `from == to` 적치는 정상 · 「일괄 완료」는 N 회 `:complete` 호출(부분 성공이 정상 형상) · **적치가 하나라도 완료된 입고는 취소가 `SUCCESSOR_EXISTS` 로 막힌다** · 잔액 하한은 `post()` 가 아니라 적치 서비스가 400 `NEGATIVE_BALANCE` 로 세운다.
