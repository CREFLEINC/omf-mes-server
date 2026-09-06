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
