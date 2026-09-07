# 미커버 249건 실행 계획 — **UI/UX 설계 관점**

> 3관점 계획서 중 하나. 공통 브리프: `docs/coverage-100/planner-brief.md` · 규칙 정본: `docs/coverage-100/README.md`
> 계약 사본 고정 `a6a87e1` · 설계 저장소 같은 커밋 로컬 사본 `/Users/rangkim/projects/crefle/omf/apps/omf-mes/design/wiki/`
> 이 문서는 **읽기만 하고 쓴 것**이다 — 코드·계약·스키마·이슈에 손대지 않았다.

> ⚠ 정정(2026-09-06 · I-1 재수립): §1-3 U1 「사번 헤더가 없으면 `assignedToMe`·`requestedByMe`·`myTurnOnly` 를 400 으로 거부」는 **철회**. 계약 `assignedToMe` 가 「지금은 계정 토큰에서만 풀린다」로 갈랐고 `계약-되돌림-mdm.md` Y-5 와 같다 — 400 은 W-CO-09 를 통째로 막는다. §6-2 의 「상신→승인→전기」 한 줄 e2e 는 I-4 에서 선다. 정본은 `plan.md` §5 #9.

## 이 관점이 무엇을 가르는가

API 관점이 자원 축으로, 통합 관점이 원장·트랜잭션 축으로 자른다면 **이 관점은 「화면 하나가
온전히 열리는가」로 자른다.** 판단 기준은 하나다 — 하노이 현장의 작업자가 그 화면을 열었을 때
**빈 칸·죽은 버튼·틀린 숫자가 없는가.**

그래서 슬라이스의 경계가 도메인이 아니라 **화면 묶음**이다. 한 화면은 대개
`목록 + 상세 + 라인 + 집계 + 동사` 다섯이 «같이» 있어야 열리고, 넷만 있으면 열리지 않는 것이
아니라 **잘못 열린다**(예: 집계 없이 목록만 있으면 화면이 페이지를 모아 더해 틀린 수를
보인다 — 공유계약 `L-2` 가 명시적으로 금지한 것).

**증거의 출처.** 계약 `contracts/*.json` 의 오퍼레이션 249건을 전부 파싱해 `description` ·
`x-internal-note` 안의 화면 식별자(`W-01-10` 꼴)를 뽑았다. 249건 중 **207건이 화면 식별자를
스스로 들고 있고 42건이 안 들고 있다**(§5-3). 설계 저장소의 화면 명세 131건 중
**82건을 실제로 열어 읽었다.** 추측한 것은 「추측」이라 적었다.

---

## §1. 슬라이스 목록

43개 슬라이스 + 건너뜀 5건 = **249건 전건.** 아래 표에 없는 오퍼레이션은 없다(스크립트로 대조).

### §1-1. 한눈에

| # | 슬라이스 | 건 | 소유 화면 | 선행 | 새 표 | 마이그 | posting | 상태기계 | PR |
|---|---|--:|---|---|---|---|---|---|--:|
| U1 | 결재 뼈대 | 12 | W-CO-09 · W-06-15 | — | 없음 | 불필요 | — | ○ 승인 요청 | 2 |
| U2 | 알림 | 8 | W-CO-03 · W-CO-11 | — | recipient 규칙 | ○ | — | — | 2 |
| U3 | 출력물 발행 이력 | 5정상(별도프린터1유보/rendition1제외) | P-01-01 · P-01-02 · P-02-05/07/09 · P-04-02/04 · W-05-13 · W-04-03 | I26저장조회 | 없음 | A9결과/귀속6nullable | — | 기록/실물분리 | I27 R16 책임별 |
| U4 | P/O · ASN | 10 | W-01-11 · W-01-09 | U1 | 없음 | ○ §I-48 | — | ○ P/O | 2 |
| U5 | 입하 | 9 | M-01-01 · M-01-06 · W-01-03 | U4 | 없음 | — | — | ○ 입하 | 3 |
| U6 | LOT 부가 조회 | 3 | M-01-02 · W-01-07 | — | 없음 | 불필요 | — | — | 1 |
| U7 | 검사 실행 | 8 | W-01-01 · P-02-13 | U5 | 없음 | 불필요 | — | ○ 결과 | 2 |
| U8 | LOT Status · 보류 | 9 | W-03-01 · W-03-02 · W-03-03 | U7 | 없음 | ○ lot_hold.version_no | — | ○ LOT 상태 | 3 |
| U9 | 긴급 IQC 생략 | 1 | M-01-13 · W-01-02 | U1 · U8 | 없음 | 불필요 | — | — | 1 |
| U10 | 적치 지시 | 4 | M-01-05 · M-01-07 · M-04-04 | U5 | 없음 | 불필요 | ○ 위치 이동 | ○ 지시 | 2 |
| U11 | 출고요청 · 피킹 | 8 | M-01-08 앞 · W-02-10 | U20 | 없음 | 불필요 | ~~○ 예약~~ **피킹 소진만**(`pick()`·`consume()` · 예약을 거는 자리 없음 · I-8 R-22) | ~~○ 피킹~~ **없음**(`picking_order`·`picking_line` 상태를 서버가 안 옮긴다 · I-8 §6-6) | ~~2~~ **5**(I-8 R-1) |
| U12 | 출고 전표 | 7 | M-01-08 뒤 · W-01-05 · W-01-06 · W-04-10 | U11 · U1 | 없음 | 불필요 | ○ 출고 | ○ 출고 | 5(I-4 재수립 R-11) |
| U13 | 생산창고 입고 | 3 | M-01-09 | U12 | 없음 | 불필요 | 없음(I-9 §3-4 기록만) | 없음(영원히 `REGISTERED` · I-9 R-4) | 2 |
| U14 | 재고 이동 · 반출 | 6 | M-01-10 · W-04-11 | U12 | 없음 | 불필요 | ○ 2단 | ○ 이동 | 2 |
| U15 | 재생재 | 1 | M-01-12 | U5 | 없음 | 불필요 | ○ 증가 | — | 1 |
| U16 | 실사 | 6 | W-01-04 · M-01-11 | — | 없음 | 불필요 | — | ○ 실사 | 2 |
| U17 | 재고 조정 | 7 | W-01-12 | U16 · U1 | 없음 | 불필요 | ○ 조정 | ○ 조정 | 2 |
| U18 | 물류 문서 진행현황 · 취소 | 4 | W-01-13 | U5 · U12 · U1 | 없음 | ○ §I-38 취소 흔적 | ○ 역분개 | ○ 취소 | 3 |
| U19 | P/O 수신 · 생산 계획 | 10 | W-02-01 · W-02-02 · W-02-06 · W-06-10(`:resync` 권한) | — | 없음 | ○ 분할 계보 2칸(A11 — 변경 이력 칸은 실재 · I-24 R-17) | — | ○ 계획 | 4 |
| U20 | W/O 편성 · 배포 | 9 | W-02-03/04/07/08 | U19 | ~~work_order_resource_plan~~ 표는 있다(`work_order_resource_assignment`) — 결손은 **유일 제약**(I-6 R-9) | ○ | — | ○ W/O | 3 |
| U21 | W/O 상태 전이 | 4 | P-02-10 · W-02-05 · W-02-06 | U20 · U24 | 없음 | 불필요 | — | ○ 4전이 | 2 |
| U22 | 작업 세션 · 작업 전 점검 | 11 | P-02-01 · P-02-02 · P-02-10 | U20 · U33 | 없음 | **1** · `work_session.shift_id` NOT NULL 완화(I-11 재수립 R-3) | — | ○ 세션 | 5 |
| U23 | 자재 투입 · 반납 | 6 | P-02-03 | U22 · U13 | 없음 | **2** · `terminal_id`·`return_quality_status_code` NOT NULL 완화(I-10 재수립 R-3·R-4) | 없음(투입·반출 둘 다 · R-2) | — | 3 |
| U24 | 생산 실적 · 정정 | 5 | P-02-04 · W-02-05 | U23 | 없음 | **2**(D1 `shift_id` 완화 · D2 `correct_reason_code`) | — (원장 안 지난다 · 제품 재고는 기존 입고) | ○ L1 호출 | 3 (I-7 ①②③ · 재수립 R-19) |
| U25 | 생산 LOT 완료 · 개체 발번 | 4 | P-02-06 · P-02-05 · W-02-05/06 | U24 | 없음 | 불필요 | — | — (완료는 `completed_at` 시각 · 어느 상태 칸도 안 옮긴다 · I-7 §3-3) | 2 |
| U26 | 공정 인계 · 수리 왕복 | 6 | M-02-01 · M-02-02 | U24 | 없음 | 불필요 | ○ 이동 | ○ 인계 | 2 |
| U27 | 취급 단위 · 포장 | 7 | P-02-08 · M-04-03 · P-04-01/04 · P-01-02 | U25 | **handling_unit_repack_event(+line)** | ○ | — | ○ 포장 | 3 |
| U28 | 부적합 · 처분 | 9 | W-04-06/07 · W-03-10 · P-04-03 | U8 | 없음 | 불필요 | — | ○ 부적합 | 3 |
| U29 | 특채 | 2 | W-03-09 | U1 · U28 | 없음 | 불필요 | — | — | 1 |
| U30 | 출하지시서 · 출하작업지시 | 7 | W-04-01 · W-04-02 · M-04-01 | U25 · U11 | 없음 | 불필요 | ○ 예약 | ○ 지시 | 3 |
| U31 | 출하 처리 · 확정 · 취소 | 8 | W-04-04/05/12 · P-04-01/02 | U30 · U1 | 없음 | 불필요 | ○ 출하·역분개 | ○ 2단 확정 | 3 |
| U32 | 재고 재등록 | 1 | W-04-03 · W-04-11 · W-03-02 | U8 · U14 · U28 | 없음 | 불필요 | ○ 복합 | ○ | 1 |
| U33 | 설비 점검 · 고장 | 9(진행8·보류1) | M-05-01 · M-05-02 · W-05-04 · P-02-02 | — | 없음 | A15 nullable8추가·2완화 | — | ○ 고장 start, 완료 보류 | 실행8 + 조건부 |
| U34 | 보전 지시 · 실적 | 8 | W-05-05/06 · W-05-02/03 | U33·I32순간helper | MO/cancel·부여/PM최소공유 | ○ result.version_no/필드확장 | ✕ 기존출고 참조만 | ○ 지시 | I31 R12 최소책임별 |
| U35 | 비가동 | 6(진행4·보류2) | P-05-02 · W-05-08 | I-30 날짜helper·U22 | 없음 | ○ remarks/최초사번/version 추가3·type완화1 | — | — | µs준비+조회/쓰기분리 |
| U36 | 툴 사용실적 | 3(GET2/POST1) | P-05-01 | I32순간·I31reset경계 | 없음 | ○추가4/완화2 | — | 누계NKU·실제FK회귀 | I33물리/조회/쓰기분리 |
| U37 | 계측기 | 4 | W-05-10 · W-05-11 | — | 없음 | ○추가8·유일완화/version추가0 | — | CAL기본3효과/확장만422 | I33물리/조회/쓰기분리 |
| U38 | 수집 채널 | 5 | W-05-07 | I32순간·A참조조율 | **collection_channel_observation** | ○추가5/완화3/네축NULL식유일 | — | 登録/활성연결분리 | I33물리/조회/쓰기분리 |
| U39 | 검사 집계 | 5 | W-03-05 | U7 · U24 | 없음 | 불필요 | — | — | 1 |
| U40 | 변경 이력 | 1 | W-06-11 · W-06-06 · W-CO-02 | — | 없음 | ○ §I-5 jsonb 규약 | — | — | 1 |
| U41 | 예비품 올리기 | 1 | W-06-08 | — | 없음 | 불필요 | — | — | 1 |
| U42 | 통합 대시보드 | 1 | W-CO-05 | U24 · U35 · U2 | 없음 | 불필요 | — | — | 1 |
| U43 | 첨부 목록 | 1 | W-CO-04 · W-CO-08 | — | 없음 | 불필요 | — | — | 1 |
| — | **건너뜀** | 5 | §3 | — | — | — | — | — | 0 |

**합계 244 + 건너뜀 5 = 249.** PR 예상 합계 **86**(마이그레이션 선행 커밋 12건 별도).

> PR 수 산정 근거 — 관행대로 「전표 하나 + posting 연결 + e2e」 = 1 PR, 「같은 도메인 조회 GET
> 묶음」 = 1 PR. 조회만 있는 슬라이스(U6·U29·U39·U40·U42·U43)는 1 PR, 전표+동사가 있는
> 슬라이스는 「조회 1 + 전표 1(+ 코어 1)」로 2~3 PR. 코어(원장 쓰기·상태기계)가 붙는
> U12·U18·U24·U31 은 CLAUDE.md 의 diff ≤ 200줄 규칙 때문에 3 PR 이 하한이다.

### §1-2. 슬라이스별 오퍼레이션 전건

각 표의 「헤더」 칸: `멱등` = `Idempotency-Key` · `ETag` = `If-Match` · `사번` = `X-Worker-No`.

#### U1 결재 뼈대 (W-CO-09·W-06-15) — 12건

| 오퍼레이션 | 요약 | 화면 | 헤더 |
|---|---|---|---|
| `GET /app/approval-routes` | 결재선 목록 | W-06-15 | - |
| `GET /app/approval-routes/{approvalRouteId}` | 결재선 상세 | W-06-15 | - |
| `GET /app/approval-routes/{approvalRouteId}/steps` | 결재 단계 목록 | W-06-15 | - |
| `POST /app/approval-routes` | 결재선 등록 | W-06-15 | 멱등 |
| `PUT /app/approval-routes/{approvalRouteId}` | 결재선 수정 | W-06-15 | 멱등, ETag |
| `PUT /app/approval-routes/{approvalRouteId}/steps` | 결재 단계 전체 치환 (순서 포함) | W-06-15 | 멱등, ETag |
| `POST /app/approval-routes/{approvalRouteId}:activate` | 결재선 다시 사용 | W-06-14,W-06-15 | 멱등, ETag |
| `POST /app/approval-routes/{approvalRouteId}:deactivate` | 결재선 사용 중지 | W-06-15 | 멱등, ETag |
| `GET /app/approval-requests` | 승인 요청 목록 | M-01-13,M-CO-01,W-01-02,W-03-09,W-CO-09 | 사번 |
| `GET /app/approval-requests/{approvalRequestId}` | 승인 요청 상세 (결재선 진행 포함) | W-CO-09 | - |
| `POST /app/approval-requests/{approvalRequestId}:approve` | 승인 | W-CO-09 | 멱등, ETag |
| `POST /app/approval-requests/{approvalRequestId}:reject` | 반려 | W-CO-09 | 멱등, ETag |

#### U2 알림 (W-CO-03·W-CO-11) — 8건

| 오퍼레이션 | 요약 | 화면 | 헤더 |
|---|---|---|---|
| `GET /app/notification-events` | 알림 이벤트 목록 | W-05-10,W-CO-03,W-CO-11 | - |
| `GET /app/notifications` | 알림 목록 | W-CO-03 | - |
| `GET /app/notifications/unread-count` | 안 읽은 알림 수 | W-CO-03 | - |
| `POST /app/notifications/{notificationId}:read` | 알림 읽음 처리 | W-CO-03 | 멱등 |
| `POST /app/notifications:read-all` | 모두 읽음 | W-CO-03 | 멱등 |
| `GET /app/notification-subscriptions` | 알림 수신자 설정 조회 | W-CO-11 | - |
| `PUT /app/notification-subscriptions` | 알림 수신자 설정 저장 | W-CO-11 | 멱등, ETag |
| `POST /app/notification-subscriptions/recipients:preview` | 지금 받는 사람 미리보기 | W-CO-11 | 멱등 |

#### U3 출력물 발행 이력 (P-01-01·P-01-02·P-02-05/07/09·P-04-02/04·W-05-13) — 5건

**I-27 R1~R16 재수립**: 조회3·부분 정상 발행1·보고1은 진행하지만 문서9종 전체 지원/물리 라벨 완료는 아니다. 발행은 계정 사번 선택·검증된 terminal이면 필수, report는 항상 필수이며 최초 발행/보고 계정·작업자를 분리한다. MATERIAL PENDING/FAILED도 기존 labelIssued=true이고 렌디션 실패 뒤 재조회 복구·51+이력 페이지·target.screenId 이동은 소비자 미완이다. DELIVERY+LOT/PACKING+LOT 실제 임시치환은 서버 허용 근거가 아니다. 프린터 상태/기본을 만들지 않고 GET을 유보한다. summary는 CSV전건·중복순서·미존재count0(존재증명 아님)·같은행의last3를 보존하고 구행 NULL outcome도 정상 null이다.

| 오퍼레이션 | 요약 | 화면 | 헤더 |
|---|---|---|---|
| `GET /app/document-issues` | 발행 이력 조회 | — | - |
| `GET /app/document-issues/summary` | 대상별 발행 요약 — 목록 화면용 | — | - |
| `GET /app/document-issues/{documentIssueLogId}` | 발행 기록 한 건 | — | - |
| `POST /app/document-issues` | 발행 · 재발행 | — | 멱등, 사번 |
| `POST /app/document-issues/{documentIssueLogId}:report-print` | 인쇄 결과 보고 | P-01-01,P-01-02,P-04-02,W-05-13 | 멱등, 사번 |

#### U4 P/O·ASN (W-01-11·W-01-09) — 10건

⚠ **정정(2026-09-06 · I-2 재수립 R-9)** — 라인 두 칸의 「W-01-11」은 **등록 폼 «안»의 라인 그리드**(`W-01-11` §4-B 필드 표 · §5-1 「라인 추가·삭제」)를 오인한 것이다. 그 행위는 `POST /logistics/purchase-orders` 본문으로 가고, 등록한 P/O 를 다시 여는 화면은 인벤토리에 없다 → **문의 025**.

| 오퍼레이션 | 요약 | 화면 | 헤더 |
|---|---|---|---|
| `GET /logistics/purchase-orders` | P/O 목록 | W-01-09,W-01-11,**M-01-01**(도출표 `:58` 실측 · `openOnly` 의 실제 소비처 — I-3 재수립 R-14) | - |
| `GET /logistics/purchase-orders/{purchaseOrderId}` | P/O 상세 | W-01-03,W-01-09,**M-01-01**(도출표 `:59` 실측) | - |
| `GET /logistics/purchase-orders/{purchaseOrderId}/lines` | P/O 라인 목록 | — (025) | - |
| `POST /logistics/purchase-orders` | P/O 등록 | W-01-03,W-01-11 | 멱등 |
| `PUT /logistics/purchase-orders/{purchaseOrderId}` | P/O 헤더 수정 | — | 멱등, ETag |
| `PUT /logistics/purchase-orders/{purchaseOrderId}/lines` | P/O 라인 치환 | — (025) | 멱등, ETag |
| `POST /logistics/purchase-orders/{purchaseOrderId}:request-approval` | P/O 승인 요청 | W-01-11 | 멱등, ETag |
| `GET /logistics/asns` | 입하 예정 목록 | W-01-09 | - |
| `GET /logistics/asns/{asnId}` | 입하 예정 상세 | W-01-09 | - |
| `GET /logistics/asns/{asnId}/lines` | 입하 예정 라인 | W-01-09 | - |

#### U5 입하 (M-01-01·M-01-06·W-01-03) — 9건

| 오퍼레이션 | 요약 | 화면 | 헤더 |
|---|---|---|---|
| `POST /logistics/inbound-receipts` | 입하 등록 | M-01-01 | 멱등, ETag, 사번 |
| `GET /logistics/inbound-receipts` | 입하 목록 | M-01-06,P-01-01,W-01-03 | - |
| `GET /logistics/inbound-receipts/{inboundReceiptId}` | 입하 상세 | M-01-06,P-01-01,W-01-03 | - |
| `GET /logistics/inbound-receipts/{inboundReceiptId}/lines` | 입하 라인 목록 | P-01-01,W-01-03 | - |
| `PUT /logistics/inbound-receipts/{inboundReceiptId}` | 입하 헤더 수정 | — (026) | 멱등, ETag |
| `PUT /logistics/inbound-receipts/{inboundReceiptId}/lines` | 입하 라인 치환 | — (026) | 멱등, ETag |
| `POST /logistics/inbound-receipts:split` | 초과 입하 분리 등록 | W-01-03 | 멱등 |
| `GET /logistics/inbound-receipt-lines/{inboundReceiptLineId}/variances` | 입하 차이 목록 | M-01-06 | - |
| `POST /logistics/inbound-receipt-lines/{inboundReceiptLineId}/variances` | 입하 차이 등록 | M-01-06 | 멱등, 사번 |

#### U6 LOT 부가 조회 (M-01-02·W-01-07) — 3건

| 오퍼레이션 | 요약 | 화면 | 헤더 |
|---|---|---|---|
| `GET /trace/lots/{lotId}/external-identifiers` | LOT 외부 식별자 목록 | M-01-02 | - |
| `PUT /trace/lots/{lotId}/external-identifiers` | LOT 외부 식별자 치환 | — | 멱등, ETag |
| `GET /trace/lots/{lotId}/holds` | LOT 보류 목록 | M-01-08,W-01-07 | - |

#### U7 검사 실행 (W-01-01·P-02-13) — 8건

| 오퍼레이션 | 요약 | 화면 | 헤더 |
|---|---|---|---|
| `GET /quality/inspection-requests` | 검사 의뢰 목록 | W-01-01,W-03-05 | - |
| `GET /quality/inspection-requests/{inspectionRequestId}` | 검사 의뢰 한 건 | P-02-13,W-01-01 | - |
| `GET /quality/inspection-results` | 검사 결과 목록 | W-01-01,W-03-05 | - |
| `GET /quality/inspection-results/{inspectionResultId}` | 검사 결과 한 건 | W-03-05 | - |
| `GET /quality/inspection-results/{inspectionResultId}/measurements` | 측정치 목록 | W-03-05 | - |
| `POST /quality/inspection-results` | 검사 결과 저장 | P-02-13,W-01-01 | 멱등, ETag, 사번 |
| `PUT /quality/inspection-results/{inspectionResultId}` | 검사 결과 수정 | W-01-01 | 멱등, ETag |
| `POST /quality/inspection-results/{inspectionResultId}:confirm` | 검사 판정 확정 | P-02-13,W-01-01 | 멱등, ETag |

#### U8 LOT Status·보류 (W-03-01·W-03-02·W-03-03) — 9건

| 오퍼레이션 | 요약 | 화면 | 헤더 |
|---|---|---|---|
| `GET /quality/lot-statuses` | LOT 품질 상태 목록 | W-03-01,W-03-02,W-03-03 | - |
| `GET /quality/lot-status-summary` | LOT 상태 요약 | W-03-01 | - |
| `GET /quality/lot-status-transitions` | 갈 수 있는 LOT 상태 | W-03-02 | - |
| `GET /quality/lot-holds` | LOT 보류 목록 | W-03-01,W-03-02 | - |
| `GET /quality/lot-holds/{lotHoldId}` | LOT 보류 한 건 | W-03-01 | - |
| `GET /quality/lot-hold-events` | 보류 등록·해제 사건 조회 | W-03-01 | - |
| `POST /quality/lot-holds` | LOT 보류 등록 | W-03-02,W-03-03 | 멱등 |
| `POST /quality/lot-holds/{lotHoldId}:release` | LOT 보류 해제·재판정 | W-03-02 | 멱등, ETag |
| `GET /trace/lot-status-events` | LOT 상태 변경이력 조회 — 전이 9종 전건 | M-01-08,W-01-02,W-03-01 | - |

#### U9 긴급 IQC 생략 (M-01-13·W-01-02) — 1건

| 오퍼레이션 | 요약 | 화면 | 헤더 |
|---|---|---|---|
| `POST /trace/lots/{lotId}:request-iqc-skip` | 긴급 IQC 생략 요청 | M-01-13 | 멱등, 사번 |

#### U10 적치 지시 (M-01-05·M-01-07·M-04-04) — 4건

| 오퍼레이션 | 요약 | 화면 | 헤더 |
|---|---|---|---|
| `GET /logistics/putaway-tasks` | 적치 지시 목록 | M-01-05,M-01-07,M-01-10,M-04-04,W-06-06 | - |
| `GET /logistics/putaway-tasks/{putawayTaskId}` | 적치 지시 상세 | M-01-05 | - |
| `POST /logistics/putaway-tasks/{putawayTaskId}:complete` | 적치 완료 | M-01-05 | 멱등, ETag, 사번 |
| `POST /logistics/putaway-tasks/{putawayTaskId}:complete-temporary` | 임시 위치 적재 | M-01-07 | 멱등, ETag, 사번 |

#### U11 출고요청·피킹 (M-01-08 앞단·W-02-10) — 8건

| 오퍼레이션 | 요약 | 화면 | 헤더 |
|---|---|---|---|
| `GET /logistics/material-issue-requests` | 자재 출고 요청 목록 | M-01-08 | - |
| `GET /logistics/material-issue-requests/{materialIssueRequestId}` | 자재 출고 요청 상세 | M-01-08 | - |
| `GET /logistics/material-issue-requests/shortage` | W/O 품목별 소요·기출고·부족 | W-02-10 | - |
| `POST /logistics/material-issue-requests` | 추가 자재 출고 요청 발행 | W-02-10 | 멱등(~~ETag~~ — 계약 `responses.*.headers` 0 · I-8 §12 #6) |
| `GET /logistics/picking-orders` | 피킹 지시 목록 | M-01-08 | - |
| `GET /logistics/picking-orders/{pickingOrderId}` | 피킹 지시 상세 | M-01-08 | - |
| `POST /logistics/picking-orders/{pickingOrderId}/lines/{pickingLineId}:pick` | 라인 피킹 | M-01-08 | 멱등, ~~ETag~~(계약 headers 0 · I-8 §12 #6), 사번(없으면 400 `REQUIRED` · I-8 R-16) |
| `GET /inventory/reservations` | 재고 예약 조회 | M-01-08 | - |

#### U12 출고 전표 (M-01-08 뒷단·W-01-05·W-01-06) — 7건

| 오퍼레이션 | 요약 | 화면 | 헤더 |
|---|---|---|---|
| `GET /logistics/goods-issues` | 출고 목록 | M-01-09,P-01-02,W-01-05,W-01-06 | - |
| `GET /logistics/goods-issues/{goodsIssueId}` | 출고 상세 | P-01-02,W-01-05,W-01-06 | - |
| `GET /logistics/goods-issues/{goodsIssueId}/lines` | 출고 라인 목록 | P-01-02 | - |
| `PUT /logistics/goods-issues/{goodsIssueId}/lines` | 출고 라인 치환 | — (0건 확정 — `M-01-09` §8 #1 · 반품·피킹은 항상 `POSTED` · 폐기 두 화면 액션표에 라인 편집 없음 · I-4 「알려둘 것」) | 멱등, ETag |
| `POST /logistics/goods-issues` | 출고 등록 | M-01-08,W-01-05,W-01-06,W-04-10 | 멱등, ETag, 사번 |
| `POST /logistics/goods-issues/{goodsIssueId}:post` | 출고 전기 | W-01-06,W-04-10 | 멱등, ETag |
| `POST /logistics/goods-issues/{goodsIssueId}:request-approval` | 기타 출고 품의 상신 | W-01-06,W-04-10 | 멱등, ETag |

#### U13 생산창고 입고 (M-01-09) — 3건

| 오퍼레이션 | 요약 | 화면 | 헤더 |
|---|---|---|---|
| `GET /logistics/shopfloor-receipts` | 생산창고 입고 목록 | P-02-03(`derived-permissions.ts:70` · I-9 R-12) | - |
| `GET /logistics/shopfloor-receipts/{shopfloorReceiptId}` | 생산창고 입고 상세 | P-02-03(`derived-permissions.ts:71`) | - |
| `POST /logistics/shopfloor-receipts` | 생산창고 입고 확정 | M-01-09 | 멱등, ~~ETag~~(계약 201 `headers` 0 · I-9 §1-1), 사번 |

#### U14 재고 이동·반출 (M-01-10·W-04-11) — 6건

| 오퍼레이션 | 요약 | 화면 | 헤더 |
|---|---|---|---|
| `GET /logistics/stock-transfers` | 재고 이동 목록 | M-01-10,W-06-06 | - |
| `GET /logistics/stock-transfers/{stockTransferId}` | 재고 이동 상세 | M-01-10 | - |
| `GET /logistics/stock-transfers/{stockTransferId}/lines` | 이동 라인 목록 | M-01-10 | - |
| `PUT /logistics/stock-transfers/{stockTransferId}/lines` | 이동 라인 치환 | — | 멱등, ETag |
| `POST /logistics/stock-transfers` | 반출 등록 | M-01-10,W-04-11 | 멱등, ETag, 사번 |
| `POST /logistics/stock-transfers/{stockTransferId}:arrive` | 도착 확정 | M-01-10 | 멱등, ETag, 사번 |

#### U15 재생재 (M-01-12) — 1건

| 오퍼레이션 | 요약 | 화면 | 헤더 |
|---|---|---|---|
| `POST /logistics/recycle-entries` | 재생재 등록 | M-01-12 | 멱등, ETag, 사번 |

#### U16 실사 (W-01-04·M-01-11) — 6건

| 오퍼레이션 | 요약 | 화면 | 헤더 |
|---|---|---|---|
| `GET /inventory/counts` | 실사 목록 | M-01-11,W-01-04 | - |
| `GET /inventory/counts/{inventoryCountId}` | 실사 상세 | W-01-04 | - |
| `GET /inventory/counts/{inventoryCountId}/lines` | 실사 라인 목록 | W-01-04 | - |
| `PUT /inventory/counts/{inventoryCountId}/lines` | 한 위치의 실사 라인 치환 | M-01-11 | 멱등, ETag, 사번 |
| `POST /inventory/counts` | 실사 개시 | W-01-04 | 멱등 |
| `POST /inventory/counts/{inventoryCountId}:close` | 실사 마감 | W-01-04 | 멱등, ETag |

#### U17 재고 조정 (W-01-12) — 7건

| 오퍼레이션 | 요약 | 화면 | 헤더 |
|---|---|---|---|
| `GET /inventory/adjustments` | 재고 조정 목록 | W-01-12,W-06-06 | - |
| `GET /inventory/adjustments/{inventoryAdjustmentId}` | 재고 조정 상세 | W-01-12 | - |
| `GET /inventory/adjustments/{inventoryAdjustmentId}/lines` | 조정 라인 목록 | W-01-12 | - |
| `PUT /inventory/adjustments/{inventoryAdjustmentId}/lines` | 조정 라인 치환 | — | 멱등, ETag |
| `POST /inventory/adjustments` | 재고 조정 등록 | W-01-12 | 멱등 |
| `POST /inventory/adjustments/{inventoryAdjustmentId}:post` | 재고 조정 전기 | W-01-12 | 멱등, ETag |
| `POST /inventory/adjustments/{inventoryAdjustmentId}:request-approval` | 재고 조정 상신 | W-01-12 | 멱등, ETag |

#### U18 물류 문서 진행현황·취소 (W-01-13) — 4건

| 오퍼레이션 | 요약 | 화면 | 헤더 |
|---|---|---|---|
| `GET /logistics/document-progress` | 물류 문서 진행현황 | W-01-13 | - |
| `GET /logistics/document-progress/{documentTypeCode}/{documentId}` | 물류 문서 진행현황 상세 | W-01-13 | - |
| `POST /logistics/document-progress/{documentTypeCode}/{documentId}:request-cancel` | 물류 문서 취소 요청 | W-01-13 | 멱등, ETag |
| `POST /logistics/document-progress/{documentTypeCode}/{documentId}:cancel` | 물류 문서 취소 실행 | W-01-13 | 멱등, ETag |

#### U19 P/O 수신·생산 계획 (W-02-01·W-02-02·W-02-06) — 10건

| 오퍼레이션 | 요약 | 화면 | 헤더 |
|---|---|---|---|
| `GET /planning/production-orders` | P/O 목록 | W-02-01,W-02-06,W-06-06 | - |
| `GET /planning/production-orders/{productionOrderId}` | P/O 한 건 | W-02-01,W-02-06 | ETag(응답) |
| `POST /planning/production-orders/{productionOrderId}:acknowledge` | P/O 변경 확인 처리 | W-02-06 | 멱등, If-Match |
| `POST /planning/production-orders/{productionOrderId}:resync` | ERP 재동기 요청 | W-06-10(W-02-01 §5-5 「이 화면에 두지 않는다」) | 멱등 |
| `GET /planning/production-plans` | 생산 계획 목록 | W-02-02,W-06-06 | - |
| `GET /planning/production-plans/{productionPlanId}` | 생산 계획 한 건 | W-02-02 | ETag(응답) |
| `POST /planning/production-plans` | 생산 계획 추가 | W-02-02 | 멱등 |
| `PUT /planning/production-plans/{productionPlanId}` | 생산 계획 수정 | W-02-02 | 멱등, If-Match |
| `DELETE /planning/production-plans/{productionPlanId}` | 생산 계획 삭제 | W-02-02 | 멱등, If-Match |
| `POST /planning/production-plans/{productionPlanId}:confirm` | 전개 확정 | W-02-02,W-02-03,W-02-04,W-02-07 | 멱등, If-Match |

#### U20 W/O 편성·배포 (W-02-03·W-02-04·W-02-07·W-02-08) — 9건

| 오퍼레이션 | 요약 | 화면 | 헤더 |
|---|---|---|---|
| `GET /production/work-orders` | W/O 목록·진행현황 | P-02-01,W-02-01,W-02-03,W-02-04,W-02-05,W-02-07,W-02-08,W-06-06 | - |
| `GET /production/work-orders/{workOrderId}` | W/O 한 건 | W-02-05,W-02-08 | - |
| `PUT /production/work-orders/{workOrderId}` | W/O 수정 · 4M 자원배정 | W-02-03,W-02-04 | 멱등, ETag |
| `POST /production/work-orders` | W/O 발행 | W-02-07 | 멱등 |
| `GET /production/work-orders/{workOrderId}/resource-plans` | 4M 계획 배정 목록 | W-02-03 | - |
| `POST /production/work-orders/{workOrderId}/resource-plans` | 4M 계획 배정 추가 | W-02-03 | 멱등 |
| `DELETE /production/work-orders/{workOrderId}/resource-plans/{workOrderResourcePlanId}` | 4M 계획 배정 해제 | W-02-03 | 멱등 |
| `GET /production/work-orders/{workOrderId}/validation` | 4M 배정 유효성 점검 | W-02-03 | - |
| `POST /production/work-orders/{workOrderId}:release` | 확정·배포 · 생산LOT 선발행 | P-02-12,W-02-04,W-02-07,W-02-10 | 멱등, ETag |

#### U21 W/O 상태 전이 (P-02-10·W-02-05·W-02-06) — 4건

| 오퍼레이션 | 요약 | 화면 | 헤더 |
|---|---|---|---|
| `POST /production/work-orders/{workOrderId}:hold` | 작업 중단 | ~~P-02-10~~ **부르는 화면 0건**(P-02-10 §5-4 는 세션 사건 — 문의 035 · I-6 R-19) | 멱등, ETag, 사번 |
| `POST /production/work-orders/{workOrderId}:resume` | 작업 재개 | P-02-10 | 멱등, ETag, 사번 |
| `POST /production/work-orders/{workOrderId}:cancel` | W/O 취소 | W-02-06 | 멱등, ETag |
| `POST /production/work-orders/{workOrderId}:close` | 마감 · ERP 실적 송신 | W-02-02,W-02-05,W-06-12 | 멱등, ETag |

#### U22 작업 세션·작업 전 점검 (P-02-01·P-02-02·P-02-10) — 11건

| 오퍼레이션 | 요약 | 화면 | 헤더 |
|---|---|---|---|
| `GET /production/work-sessions` | 작업 세션 목록 | — | - |
| `GET /production/work-sessions/{workSessionId}` | 세션 한 건 | P-02-01 | - |
| `POST /production/work-sessions` | 작업 시작 — 세션 열기 | P-02-01,P-02-02 | 멱등, ~~ETag~~, 사번 |
| `POST /production/work-sessions/{workSessionId}:end` | 세션 닫기 | — | 멱등, ~~ETag~~, 사번 |
| `GET /production/work-sessions/{workSessionId}/events` | 세션 이벤트 목록 | P-02-10 | - |
| `POST /production/work-sessions/{workSessionId}/events` | 세션 이벤트 적재 | P-02-01,P-02-10 | 멱등, ~~ETag~~, 사번 |
| `GET /production/work-sessions/{workSessionId}/workers` | 세션 작업자 목록 | P-02-01 | - |
| `POST /production/work-sessions/{workSessionId}/workers` | 작업자 참여 | — | 멱등, ~~ETag~~ · ⚠ 계약이 사번을 안 줬다 — 화면 규약(`P-CO-01` §5-4)과 어긋난다(I-11 R-10) |
| `POST /production/work-sessions/{workSessionId}/workers/{workSessionWorkerId}:leave` | 작업자 이탈 | — | 멱등 · ⚠ 사번 없음(위와 같다) |
| `GET /production/precheck-decisions` | 작업 전 점검 통제 판정 이력 조회 | P-02-02 | - |
| `POST /production/precheck-decisions` | 작업 전 점검 통제 판정 기록 | P-02-02 | 멱등, 사번 |

#### U23 자재 투입·반납 (P-02-03) — 6건

| 오퍼레이션 | 요약 | 화면 | 헤더 |
|---|---|---|---|
| `GET /production/material-consumptions` | 자재 투입 목록 | P-02-03 | - |
| `GET /production/material-consumptions/{materialConsumptionId}` | 자재 투입 한 건 | P-02-03 | - |
| `POST /production/material-consumptions` | 자재 투입 등록 | P-02-03 | 멱등, 사번 |
| `GET /production/material-returns` | 자재 반출 목록 | 미매핑(§9-2) | - |
| `GET /production/material-returns/{materialReturnId}` | 자재 반출 한 건 | 미매핑(§9-2) | - |
| `POST /production/material-returns` | 자재 반출 등록 | 미매핑(§9-2) — 권한은 `P-02-03` 임시(I-10 §4-1 · 재수립 R-10) | 멱등, 사번 |

#### U24 생산 실적·정정 (P-02-04·W-02-05) — 5건

| 오퍼레이션 | 요약 | 화면 | 헤더 |
|---|---|---|---|
| `GET /production/production-results` | 생산 실적 목록 | P-02-04,W-02-08 | - |
| `GET /production/production-results/{productionResultId}` | 생산 실적 한 건 | P-02-04,W-02-08 | - |
| `POST /production/production-results` | 생산 실적 등록 | P-02-04,W-02-05 | 멱등, ETag, 사번 |
| `POST /production/production-results/{productionResultId}:correct` | 실적 정정 | W-02-05 | 멱등 |
| `POST /production/production-results/{productionResultId}:request-approval` | 실적 정정 상신 | W-02-05,W-06-15 | 멱등 |

#### U25 생산 LOT 완료·개체 발번 (P-02-06·P-02-05·W-02-05/06) — 4건

| 오퍼레이션 | 요약 | 화면 | 헤더 |
|---|---|---|---|
| `POST /trace/lots/{lotId}:complete` | 생산 LOT 완료 | P-02-06 | 멱등, ETag, 사번 — 받되 저장 칸 없음(거부 판정에만 쓴다 · I-7 §9-3 ⓜ) |
| `GET /trace/serial-numbers` | 제품 개체 목록 | P-02-05 | - |
| `POST /trace/serial-numbers` | 제품 개체 대량 발번 — 상태/단위 원천 전 본길 유보 | P-02-05,P-02-12(재사용) | 멱등·사번 필수, If-Match 선택·원천 재개 전 판정. 응답 버전 ETag 없음 |
| `GET /trace/lot-lifecycle-events` | LOT 생명주기 변경이력 조회 — 전이 3종 전건 | W-02-05,W-02-06 | - |

I-26 R1~R10: 기존 개체 GET은 진행한다. 기발번 수는 해당 LOT **다른 필터 없는 page.total**이며 items.length나 상태/기간 필터된 total이 아니다. 신규 발번→발행은 N개 응답을 단일 targets 요청으로 넘기고 단계별 별도 키를 보존한다. ② 응답 유실은② 같은 키로 원래 회차 재생, 새 발번/재발행이 아니다. GET 첫 쪽으로 성공 배치를 재구성하지 않는다. P-02-12도 새 발번 제한을 승계한다. P-04-04 권한 매핑만으로 시리얼 소비자로 단정하지 않는다. 공용 로그인·CORS/귀속·멱등 기록 실제 삭제 한계는054·104~107에 인계.

#### U26 공정 인계·수리 왕복 (M-02-01·M-02-02) — 6건

| 오퍼레이션 | 요약 | 화면 | 헤더 |
|---|---|---|---|
| `GET /production/operation-handovers` | 공정 인계 목록 | M-02-01 | - |
| `GET /production/operation-handovers/{operationHandoverId}` | 공정 인계 한 건 | M-02-01 | - |
| `POST /production/operation-handovers` | 공정 인계 확정 | M-02-01,M-02-02 | 멱등, ETag, 사번 |
| `GET /production/repair-executions` | 수리 실행 목록 | M-02-02 | - |
| `POST /production/repair-executions` | 수리 투입 등록 | M-02-02 | 멱등, 사번 |
| `POST /production/repair-executions/{repairExecutionId}:return` | 수리 반출 등록 | M-02-02,P-02-03,P-02-04 | 멱등, 사번 |

#### U27 취급 단위·포장 (P-02-08·M-04-03·P-04-01·P-04-04·P-01-02) — 7건

| 오퍼레이션 | 요약 | 화면 | 헤더 |
|---|---|---|---|
| `GET /inventory/handling-units` | 취급 단위 목록 | M-01-10,P-01-02,P-02-08 | - |
| `GET /inventory/handling-units/{handlingUnitId}` | 취급 단위 상세 | P-01-02 | - |
| `GET /inventory/handling-units/{handlingUnitId}/contents` | 취급 단위 구성 목록 | M-01-10 | - |
| `PUT /inventory/handling-units/{handlingUnitId}/contents` | 취급 단위 구성 치환 | M-04-03,P-04-04 | 멱등, ETag, 사번 |
| `GET /inventory/handling-units/{handlingUnitId}/repack-events` | 포장 재구성 이력 | M-04-03 | - |
| `POST /inventory/handling-units` | 취급 단위 등록 | M-04-03,P-02-08,P-04-01 | 멱등, 사번 |
| `POST /inventory/handling-units/{handlingUnitId}:pack` | 포장 확정 | P-02-08 | 멱등, ETag, 사번 |

#### U28 부적합·처분 (W-04-06·W-04-07·W-03-10·P-04-03) — 9건

| 오퍼레이션 | 요약 | 화면 | 헤더 |
|---|---|---|---|
| `GET /quality/nonconformances` | 부적합 목록 | W-03-10,W-04-07,W-06-06 | - |
| `GET /quality/nonconformances/{nonconformanceId}` | 부적합 한 건 | W-03-09,W-03-10 | - |
| `POST /quality/nonconformances` | 부적합 등록 | W-04-06,W-04-07 | 멱등 |
| `POST /quality/nonconformances/{nonconformanceId}:request-disposition` | 처분 판정 의뢰 | W-04-07 | 멱등, ETag |
| `GET /quality/nonconformances/{nonconformanceId}/disposition-decisions` | 이 부적합의 처분 결정 | W-03-10 | - |
| `POST /quality/nonconformances/{nonconformanceId}/disposition-decisions` | 처분 판정 저장 | W-03-03,W-03-10 | 멱등, ETag |
| `GET /quality/disposition-decisions` | 처분 결정 목록 | P-04-03,W-03-10,W-04-07,W-04-10,W-04-11 | - |
| `GET /quality/disposition-decisions/{dispositionDecisionId}` | 처분 결정 한 건 | W-04-11 | - |
| `GET /quality/disposition-candidates` | 처분 판정 대상 목록 | W-04-07,W-05-05 | - |

#### U29 특채 (W-03-09) — 2건

| 오퍼레이션 | 요약 | 화면 | 헤더 |
|---|---|---|---|
| `GET /quality/concessions` | 특채 목록 | W-03-09 | - |
| `GET /quality/concessions/{concessionId}` | 특채 한 건 | W-03-09 | - |

#### U30 출하지시서·출하작업지시 (W-04-01·W-04-02·M-04-01) — 7건

| 오퍼레이션 | 요약 | 화면 | 헤더 |
|---|---|---|---|
| `GET /logistics/sales-orders` | 출하지시서 목록 | W-04-01 | - |
| `GET /logistics/sales-orders/{salesOrderId}` | 출하지시서 한 건 | W-04-01 | - |
| `GET /logistics/shipment-requests` | 출하작업지시 목록 | W-04-02,W-04-04,W-04-05 | - |
| `GET /logistics/shipment-requests/{shipmentRequestId}` | 출하작업지시 한 건 | W-04-01 | - |
| `GET /logistics/shipment-requests/summary` | 출하작업지시 요약 | W-04-02,W-04-04,W-04-05 | - |
| `POST /logistics/shipment-requests` | 출하작업지시 편성 | W-04-01 | 멱등 |
| `POST /logistics/shipment-requests/{shipmentRequestId}/lines/{shipmentRequestLineId}:pick` | 제품 LOT 피킹 확정 | M-01-08,M-04-01 | 멱등, 사번 |

#### U31 출하 처리·확정·취소 (W-04-04·W-04-05·W-04-12·P-04-01/02) — 8건

| 오퍼레이션 | 요약 | 화면 | 헤더 |
|---|---|---|---|
| `GET /logistics/shipments` | 출하 목록 | W-04-02,W-04-04,W-04-06,W-04-12,W-06-06 | - |
| `GET /logistics/shipments/{shipmentId}` | 출하 한 건 | — | - |
| `POST /logistics/shipments` | 출하 처리 | W-04-04,W-04-05,W-04-12 | 멱등 |
| `POST /logistics/shipments/{shipmentId}:confirm` | 출하 확정 | W-04-12 | 멱등, ETag |
| `POST /logistics/shipments/{shipmentId}:request-cancel` | 출하 취소 요청 | W-04-12 | 멱등, ETag |
| `POST /logistics/shipments/{shipmentId}:cancel` | 출하 취소 실행 | W-04-12 | 멱등, ETag |
| `GET /logistics/shipment-lot-allocations` | 출하 LOT 배분 목록 | M-04-01,P-04-01,P-04-02,W-04-04 | - |
| `PUT /logistics/shipment-lot-allocations/{shipmentLotAllocationId}` | 배분에 포장 단위 연결 | P-04-01 | 멱등, 사번 |

#### U32 재고 재등록 (W-04-03·W-04-11·W-03-02) — 1건

| 오퍼레이션 | 요약 | 화면 | 헤더 |
|---|---|---|---|
| `POST /logistics/stock-reinstatements` | 재고 재등록 확정 | W-03-02,W-04-03,W-04-11 | 멱등 |

#### U33 설비 점검·고장 (M-05-01·M-05-02·W-05-04·P-02-02) — 9건

| 오퍼레이션 | 요약 | 화면 | 헤더 |
|---|---|---|---|
| `GET /maintenance/inspections` | 점검 기록 목록 | M-05-01,P-02-02,W-05-05 | - |
| `GET /maintenance/inspections/{inspectionId}` | 점검 기록 한 건 | — | - |
| `POST /maintenance/inspections` | 점검 기록 등록 | — | 멱등, 사번 |
| `GET /maintenance/breakdowns` | 고장 기록 목록 | W-05-05 | - |
| `GET /maintenance/breakdowns/{breakdownId}` | 고장 기록 한 건 | — | 응답 ETag |
| `POST /maintenance/breakdowns` | 고장 보고 등록 | — | 멱등, 사번 |
| `POST /maintenance/breakdowns/{breakdownId}:start-handling` | 처리 중으로 | — | 멱등, If-Match 필수 |
| `POST /maintenance/breakdowns/{breakdownId}:complete` | 고장 완료 · 원인 원천 보류 | P-02-02,P-05-02,W-05-04 | 멱등, If-Match 필수 |
| `PUT /maintenance/breakdowns/{breakdownId}` | 처리 내역 저장 | — | 멱등, If-Match 필수 |

I-30 재수립 R-1~R-14가 구현 정본이다. 연속 편집은 상세 GET→메모 PUT→상세 GET→start→상세 GET으로 숫자 버전을 새로 받는다. 쓰기 응답의 내용 해시를 If-Match로 쓰지 않는다. 목록의 linkedDowntimeCount=0은 실제 경고 해제 근거가 아니며 상세를 다시 읽는다. 원인 미정 complete1건은 보류, PUT은 원인 nonnull만 거부한다. 보고 성공과 알림 발송/사진 저장을 구분하며, 오프라인 단말의 필수 항목·자동 판정 책임과 현재 인증/CORS 한계는 문의090~098·054에 남겼다.

#### U34 보전 지시·실적 (W-05-05·W-05-06·W-05-02·W-05-03) — 8건

| 오퍼레이션 | 요약 | 화면 | 헤더 |
|---|---|---|---|
| `GET /maintenance/orders` | 보전 지시 목록 | W-05-05 | - |
| `GET /maintenance/orders/{maintenanceOrderId}` | 보전 지시 한 건 | — | - |
| `POST /maintenance/orders` | 보전 지시 발행 | — | 멱등 |
| `POST /maintenance/orders/{maintenanceOrderId}:cancel` | 보전 지시 취소 | — | 멱등, ETag |
| `GET /maintenance/results` | 보전 실적 목록 | — | - |
| `GET /maintenance/results/{maintenanceResultId}` | 보전 실적 한 건 | — | - |
| `POST /maintenance/results` | nonreset 미마감 실적 등록, reset/closed true만422 | W-05-06·W-05-03 | 멱등, If-Match 선택(툴 reset 조건부필수·현재성공유보) |
| `PUT /maintenance/results/{maintenanceResultId}` | 보전 실적 수정 | — | 멱등, ETag |

I-31 정본 R1~R13·문의113~116: 미마감 저장/편집, 마감, PM 기준, 원천/부여, parts 확인·정정을 별도 인수한다. closed/reset true는 각각422·전건0이며 일반 기록 성공을 PM/지시 완료 성공으로 표시하지 않는다. finishedAt가 있어도 PM 완료 선언이 아니다. EQUIPMENT 직접고장의 breakdownId·예방baseDate·실제effective부여, MOLD order 필수·자유부위 입력은 현재 client 누락을 고칠 자리다. 상세GET→실적 ETag→PUT 진입점은 아직 없고 parts7칸·unknown UOM/GI 재선택·수량정정 표시도 미완이다. client의 브라우저offset 자정 입력/UTCprefix 날짜표시는 공장로컬 인수094로 분리하며 서버 instant를 재해석하지 않는다. 툴 폐기만으로 nonreset 과거 기록을 막지 않는다. 담당/수행자/발행자/실제actor는 별도 계정축, 예비품은 출고 참조이지 자동출고/수불이 아니다.

#### U35 비가동 (P-05-02·W-05-08) — 6건

| 오퍼레이션 | 요약 | 화면 | 헤더 |
|---|---|---|---|
| `GET /maintenance/downtimes` | 비가동 목록 | P-05-02 | - |
| `GET /maintenance/downtimes/{downtimeId}` | 비가동 한 건 | — | 응답 버전 ETag |
| `POST /maintenance/downtimes` | 비가동 등록 | — | 멱등, 사번 |
| `PUT /maintenance/downtimes/{downtimeId}` | 비가동 수정 | — | 멱등, If-Match 필수 |
| `POST /maintenance/downtimes/{downtimeId}:close` | 비가동 지금 종료 — 시각 입력 경로 해소 전 유보 | P-05-02 | 멱등, If-Match 선택, 사번 |
| `GET /maintenance/downtimes/summary` | 비가동 집계 | W-05-08 | - |

I-32 재수립 R1~R14·문의108~112가 정본이다. 입력/수정의 µs는 유지하고 미래 인라인은 단말 로컬 시계로 검사한다. 닫힌 구간 재개(null)는400, 과거 닫힌 입력·겹침·0길이는 허용한다. openOnly=true만 기간 생략 예외이며 무기간은 timezone 평가0. summary는 정상 계획구간/적용 산식과 완료보전 정의가 남아 유보하며 optional을 영구 생략하지 않는다. 경미정지는 공장정책으로 충분·미설정만5·actual포함/일반사유와별도줄, 폐지사유는 미분류+원본code다. 열린세션/교차기간/소수분 등은 특정조건 문제로 별도판정한다. ‘종료 버튼/집계 화면 완성’과 CRUD4건 구현을 구분한다.

#### U36 툴 사용실적 (P-05-01) — 3건

I33 R1/R2/R13·119: 화면제출shot보존·서버누적·현재정책재계산0. POST누계/기준시각은같은tx, GET과거누계쌍은snapshot없어생략. I31resettrue는114해소전전건422이고nonreset정상. 실제productionFK/NKU·MDMCAS/두증분은서버인수, POP세션/CORS·오프라인은별도미완.

| 오퍼레이션 | 요약 | 화면 | 헤더 |
|---|---|---|---|
| `GET /maintenance/tool-usages` | 툴 사용실적 목록 | — | - |
| `GET /maintenance/tool-usages/{toolUsageId}` | 툴 사용실적 한 건 | — | - |
| `POST /maintenance/tool-usages` | 툴 사용실적 등록 | — | 멱등, 사번 |

#### U37 계측기 (W-05-10·W-05-11) — 4건

I33 R3/R11·117: CAL PASS/ADJUSTED는master2날짜갱신,FAIL이력만·nonCAL확장정상·미분류CAL만422. 실제registry ADJUSTED/EXTERNAL선택·비대상CHECK경고후등록·합격미리보기·기한NULL≠이력없음·공장today/UTC표시·clearUI 인수는서버API완료와별개. cycle/MAX/서버임의보정0.

| 오퍼레이션 | 요약 | 화면 | 헤더 |
|---|---|---|---|
| `GET /maintenance/calibrations` | 계측기 이력 목록 | W-05-11 | - |
| `GET /maintenance/calibrations/{calibrationId}` | 계측기 이력 한 건 | — | - |
| `POST /maintenance/calibrations` | 계측기 이력 등록 | W-05-10 | 멱등 |
| `POST /maintenance/calibrations/{calibrationId}:clear` | 계측기 이력의 사용 차단을 해소한다 | W-05-11 | 멱등 |

#### U38 수집 채널 (W-05-07) — 5건

I33 R6/R7/R9/R10·118: 실제최신T관측의값/시각을조회하고 alreadyMapped=어떤등록행존재,unmappedOnly=활성항목연결부재. 혼합조건ANY연결판정·무임의페이지/age컷·同plan모든상태MAXRev. 빈unit400/단위없음유지생략PUT과실제409·500성공오집계는각별도소비자인수/번호승인대기. 수집자없는운영환경을수신완료로세지않는다.

| 오퍼레이션 | 요약 | 화면 | 헤더 |
|---|---|---|---|
| `GET /maintenance/collection-channels` | 수집 채널 목록 | — | - |
| `GET /maintenance/collection-channels/{collectionChannelId}` | 수집 채널 한 건 | — | - |
| `GET /maintenance/collection-channels/observations` | 최근 수신 신호 | — | - |
| `POST /maintenance/collection-channels` | 수집 채널 등록 | W-05-07 | 멱등 |
| `PUT /maintenance/collection-channels/{collectionChannelId}` | 수집 채널 수정 | W-05-07 | 멱등, ETag |

#### U39 검사 집계 (W-03-05) — 5건

| 오퍼레이션 | 요약 | 화면 | 헤더 |
|---|---|---|---|
| `GET /quality/inspection-results/summary` | 검사 요약 | W-03-05 | - |
| `GET /quality/inspection-results/defect-rate-trend` | 불량률 추이 | W-03-05 | - |
| `GET /quality/inspection-results/{inspectionResultId}/measurement-summary` | 검사 결과의 항목별 측정 요약 | W-03-05 | - |
| `GET /quality/defect-records` | 불량 실적 목록 | M-02-02,P-04-03,W-03-05 | - |
| `GET /quality/defect-records/distribution` | 불량코드 분포 | W-03-05 | - |

#### U40 변경 이력 (W-06-11·W-06-06·W-CO-02) — 1건

| 오퍼레이션 | 요약 | 화면 | 헤더 |
|---|---|---|---|
| `GET /audit/events` | 변경 이력 조회 | W-06-06,W-06-11,W-CO-02 | - |

#### U41 예비품 올리기 (W-06-08) — 1건

| 오퍼레이션 | 요약 | 화면 | 헤더 |
|---|---|---|---|
| `POST /mdm/spare-parts:import` | 예비품 엑셀 올리기 | W-06-08 | 멱등 |

#### U42 통합 대시보드 (W-CO-05) — 1건

| 오퍼레이션 | 요약 | 화면 | 헤더 |
|---|---|---|---|
| `GET /app/dashboard-summary` | 통합 대시보드 집계 | W-CO-05 | - |

#### U43 첨부 목록 (W-CO-04·W-CO-08) — 1건

| 오퍼레이션 | 요약 | 화면 | 헤더 |
|---|---|---|---|
| `GET /app/attachments` | 첨부 목록 | W-CO-04,W-CO-08 | - |

#### 건너뜀 — 5건

| 오퍼레이션 | 요약 | 화면 |
|---|---|---|
| `POST /app/attachments` | 첨부 올리기 | W-CO-04,W-CO-08 |
| `GET /app/attachments/{attachmentId}/content` | 첨부 파일 내려받기 | — |
| `POST /maintenance/breakdowns/{breakdownId}/attachments` | 고장 사진 붙이기 | — |
| `GET /app/document-issues/{documentIssueLogId}/rendition` | 출력물 이미지 · 문서 | — |
| `GET /app/printers` | 프린터 목록 · 상태 | — |

### §1-3. 슬라이스마다 예상되는 설계 미정 자리 — §2 절차로 어떻게 가를지 초안

「§2 절차」는 `docs/coverage-100/README.md` §2(0단계 선례 → 1단계 가장자리/본길 → 2단계 뒤집는
비용 → 3단계 흔적)를 가리킨다. 아래는 **화면이 그 갈림길에서 무엇을 보이게 되는가**로 가른 초안이다.

| 슬라이스 | 미정 자리 | 갈림 | 초안 판정 |
|---|---|---|---|
| U1 | `approval_route` 유일 키(`§I-35`) | 본길 — `(approvalTypeCode, businessUnitId)` 로 활성 1벌을 강제할지 | 계약이 문자로 적었다(「같은 (approvalTypeCode, businessUnitId) 로 활성 결재선이 이미 있으면 400」) → **0단계에서 끝난다.** 부분 유일 인덱스로 물리에 건다(마이그레이션) |
| U1 | 현장 셸의 `X-Worker-No` 주체 해석(`Y-5`) | 가장자리 — 관리웹은 계정 토큰, 모바일은 사번 | 2단계 ②「거부하는 쪽」 — 사번 헤더가 없으면 `assignedToMe`·`requestedByMe`·`myTurnOnly` 를 **400 으로 거부**한다. 조용히 빈 목록을 내면 M-01-13 이 「내가 올린 요청이 없다」로 읽힌다 |
| U2 | 알림 발생 지점과 eventCode 정본 | 발생기는 제외, 코드 목록은3 operation의 본길 | **I-28 R-1**: 사건명은 있지만 코드 문자열은 미확정. 저장 조회/읽음/preview5건 진행, 이벤트GET/구독GET/PUT3건 보류(099). 제목·유형 선택·구독 화면 완료와 API5건 완료는 별개 |
| U2 | 수신자 규칙의 전개 축(`recipients:preview`) | 실제 조직 관계·이벤트별 토큰 | **I-28 R-2·R-5**: 기존 표를 이벤트 NULL/NULL 헤더+규칙 자식으로 조건부 확장(지금 마이그0). ROLE=부서 사업부+user_role, USER 직접 지정. 규칙 수≠중복 제거 전원≠활성 totalCount(100·101) |
| U4 | P/O 유일 제약·OCR 자리(`§I-48`) · `erp_purchase_order_no` 유일 없음(W-01-11 §8) | 가장자리 | 2단계 ②거부 — 같은 `erp_purchase_order_no` 재등록을 400 으로 막는다. 허용→거부가 깨는 변경이므로 먼저 막는다 |
| U5 | 「미등록 품목이 도착하면 입하 라인을 만들 수 없다」(M-01-06 §8) | 본길 — 품목 생성 경로가 계약에 0건 | 1단계 본길 → **오퍼레이션 자체는 그대로 두고**(입하 라인은 등록된 품목만), 화면이 못 여는 경우를 요청서에 싣는다 |
| U7 | 계측기 미검교정 시 검사 차단 여부(W-01-01 §6 예외 E-3) | 가장자리 | 2단계 ①「재고·원장·상태를 안 쓰는 쪽」 — **차단하지 않고 `calibrationExpired` 표식만** 낸다. 계약이 이미 그 축을 필터·집계에 두었다(`calibrationExpiredCount` — 「집계에서 자동으로 빼지 않는다」) |
| U8 | `LOT_HOLD_STATUS` 값 목록 없음(`§Z-3` · 대기 13번) | 가장자리 | 이미 정해진 선례를 그대로 — `HELD` 시드 + **해제 판정은 `released_at IS NULL`** 로만. §Z-3 의 판정을 슬라이스 전역에 확장한다 |
| U8 | 보류 해제 사유 코드 필요 여부(대기 11번 · `§Z-8` 열린 물음) | 가장자리 | 2단계 ④「조용히 도출하지 않는 쪽」 — 사유를 **받되 필수로 만들지 않는다**(nullable). 필수→선택은 완화, 선택→필수는 깨는 변경 |
| U10 | `putaway_rule.priority_no` 방향 · `capacityQty` 사용(`§I-35` · `§Z-11`) | 가장자리 | `§Z-11` 선례 그대로 — **한도를 보지 않고 우선순위 첫 건**만 권장한다 |
| U11 | 피킹 지시를 **누가 만드는가**(M-01-08 §5-1 「⚠ 누가 만드는지 미정」) | 본길 — 만드는 주체가 없으면 M-01-08 이 영영 빈 화면 | 1단계 본길 → 계약에 생성 오퍼레이션이 없다. ~~`POST /logistics/material-issue-requests` 와 `:release` 가 만드는 쪽으로 «서버 파생»을 두되~~ **서버 파생을 둘 수 없다**(I-8 §5-2 실측 — 요청은 «도착» 위치만 갖고 출발 창고·LOT·위치를 모른다 · 배정 축 3겹 부재) → **문의 045**(선출 축·`pickSequenceRank` 모집단 포함 · I-8 R-22). 조회·`:pick` 은 그대로 구현 |
| U12 | 기타 출고 결재선 선택 축(`businessUnitId` × `reasonCode` 파생) | 가장자리 — 계약이 「서버가 전표의 reasonCode 로 파생한다」로 이미 못박음 | ~~0단계에서 끝난다~~ → **022 대기 · 공통본만**(`businessUnitId` 8자리 `null` · `item.business_unit_id` 는 없는 칸 — I-4 재수립 R-5) |
| U14 | 창고 «내» 위치 이동을 담을 헤더가 없다(M-01-10 §8) | 본길 | 1단계 본길 → `stock_transfer` 는 창고 간(from ≠ to)만 받는다. 위치 이동은 **적치(U10)로 흡수**하고 요청서에 싣는다 |
| U16 | 「차이가 있을 때 조정 없이 마감할 수 있나」(W-01-04 §8) | 가장자리 | 계약이 답했다 — `closable`·`closeBlockedReasonCode(VARIANCE_UNADJUSTED)` → 0단계 |
| U18 | `screenId` 를 채울 표가 없다(`계약-재검토-2026-09-04` §3) | 가장자리 | 계약의 물러난 길 그대로 — **키를 생략한다(널을 보내지 않는다).** `DocumentProgress.screenId` · `ApprovalTarget.screenId` · `Notification.screenId` 셋 다 같다 |
| U18 | 취소 흔적 3컬럼이 `inbound_receipt`·`goods_receipt` 에 없다(`§I-38` · 실측 확인) | 본길 — 취소가 흔적 없이 지나간다 | 마이그레이션으로 3컬럼을 «먼저» 넣는다. 넣지 않으면 계약이 「승인 기록이 그 이력을 대신한다」로 물러난 자리와 어긋난다 |
| U19 | `changedFields` 열거 셋(`ORDER_QTY`·`DUE_DATE`·`STATUS_CODE`) 밖 변경 · `beforeQty` 저장 자리(W-02-06 §8) | 가장자리 | 2단계 ③ nullable 칸으로 연다. 열거 밖 변경은 **무시하지 않고** `OTHER` 로 보인다(④ 조용히 도출 금지) |
| U20 | ~~`work_order_resource_plan` 표가 물리에 없다~~ 표는 있다(`work_order_resource_assignment` · 네 칸) — 유일 제약만 없다 | 본길 | 계약이 준 이름 `uq_work_order_resource_plan` 으로 식 유일 인덱스 1건(I-6 R-9) |
| U20 | 정렬 축에 파생값(달성률)을 열 것인가(W-02-08 §5) | 가장자리 | ~~기간 필터가 있을 때만 받는다~~ → **열지 않는다**(I-6 R-21) — 계약 「정렬 키는 제한한다(L-4)」 · 허용 키는 응답이 가진 축 넷(`priorityNo`·`plannedStartAt`·`workOrderNo`·`statusCode`) · 달성률 정렬은 400 이고 화면 통지 |
| U21 | 마감 3분류 「정상」의 허용 오차(W-02-05 §8-1) | 가장자리 | 계약이 「서버 정책이 정해지면 그 기준을 따른다 — 계약과 화면은 그대로다」 → **오차 0**(양품 = 지시)으로 두고 상수에 이름을 붙인다(3단계 흔적) |
| U22 | 작업 중단·포장 전용 단말 게이팅 플래그가 8종에 없다(P-02-08·P-02-10 §8) | 가장자리 | 2단계 ③ — 플래그를 늘리지 않고 **기존 `can_start_work`·`can_input_result` 로만** 게이팅한다 |
| U23 | 자재 투입 정정(`:correct`)이 계약에 없다(P-02-03 §8) | 본길 | 계약에 오퍼레이션이 없으므로 만들 수 없다. 요청서에 싣는다 |
| U24 | 3원(양품/불량/손실) ↔ 5컬럼 대응(P-02-04 §8) · `hold_qty` 가 3원 어디에도 안 든다(W-02-08 §8) | 본길 — 실적 수량의 뜻이 갈린다 | 계약이 「다섯 수량을 그대로 받는다」 → **다섯을 그대로 저장**하고 3원 접기는 하지 않는다(④ 조용히 도출 금지) |
| U27 | `handling_unit_repack_event` 표가 없다 | 본길 | 계약이 「기다리지 않는다」라 적었다 → 헤더+라인 두 표를 만든다(수량 변경 전/후) |
| U28 | 처분 결재 필요 여부(W-04-07 §8 — W-06-15 가 소관 부인) | 가장자리 | 2단계 ② — 결재를 **걸지 않는다**(없음 → 있음이 완화) |
| U31 | `shipment.confirmed_at`·`confirmed_by` 컬럼 없음(W-04-12 §8) | 가장자리 | `cancelled_*` 3컬럼과 대칭이 깨진 자리다. nullable 2칸을 더한다(2단계 ③) |
| U33 | 「열린 고장 N건」 표시 자리 미정(P-02-02 §8) | 가장자리 | `GET /maintenance/breakdowns?openOnly=true&equipmentId=` 로 화면이 센다 — 새 집계를 만들지 않는다 |
| U35 | 경미 정지 임계 기본 5분(`minorStopThresholdMinutes`) | 가장자리 | 계약이 「운영 정책이 정하며 기본은 5」라 적었다 → `app.operation_policy` 에서 읽고 없으면 5. **응답에 값을 함께 내린다**(계약 요구) |
| U37 | history/agency3/tolerance/recorded/blocks/cleared2 합계8추가, nextDueOn은기존valid_until | 물리보완선행·과거필수결손별도 | I33 R4: 새version0/유형별유일완화. 열린blocks한건이라도있으면사용불가·한건해소가전체해소아님 |
| U38 | 구collection_observation은등록channel필수FK,미등록key를담을T신설필요 | T실제저장자료조회정상·수집자운영인수미완 | I33 R6/118: 설비/key최신1행·값과µs시각같은행·flag/filter분리. 실제fixture검증, 영구빈stub0 |
| U40 | `audit_event.before_value`/`after_value` jsonb 키 규약 없음(`§I-5`) | 가장자리 | 2단계 ④ — 규약을 지어내지 않고 **조회만** 낸다. 쓰기는 이미 각 도메인이 하고 있고, 화면은 원문 jsonb 를 그대로 보인다 |
| U41 | `:import` 이 받을 열이 미정(`§P`) · 공장 생략(대기 7번) | 가장자리 | 툴 올리기(`§P-2`·`§P-3`)의 선례 그대로 — 머리글 별명 파서 + **공장이 하나일 때만 생략 허용** |
| U42 | OEE 분모(계획 조업 시간) | 가장자리 | 계약이 답했다 — 「`mdm.WorkCalendar`/`WorkCalendarDay`/`WorkCalendarApplication`(결정 03)에서 구한다」. 캘린더가 없으면 `valueStatusCode=NOT_YET`(0 을 내지 않는다) |

---

## §2. 순서 — 하노이 현장 흐름을 따라간다

`docs/development-strategy.md` 마일스톤(M1 tracer bullet → M2 실행 보강 → M3 품질 → M4 출하 →
M5 주변부)을 **바탕으로 삼되, 마일스톤 안의 순서를 화면 흐름으로 다시 세운다.** 벗어나는 자리는
아래 「⚠ 벗어남」으로 이유를 적었다.

| 순 | 슬라이스 | 왜 여기인가 |
|---:|---|---|
| 1 | **U1 결재 뼈대** | ⚠ **벗어남 — M5(승인 워크플로)를 맨 앞으로 당긴다.** 상신 동사가 **8건**(`P/O:request-approval` · `기타출고:request-approval` · `조정:request-approval` · `실적정정:request-approval` · `IQC생략` · `문서취소:request-cancel` · `출하취소:request-cancel` · `처분의뢰`)이고 전부 「결재선이 없으면 400 `ROUTE_NOT_FOUND`」다. 결재선이 없으면 W-01-06·W-01-11·W-01-12·W-02-05·M-01-13·W-01-13·W-04-12 일곱 화면의 주 버튼이 **죽은 채로 배포된다.** 뒤로 미루면 그 일곱 화면을 두 번 만든다 |
| 2 | U4 P/O · ASN | 흐름의 머리. W-01-09(입하 예정 조회)는 조회 전용이라 현장이 「오늘 뭐가 오나」를 볼 수 있게 되는 첫 화면 |
| 3 | U5 입하 | M-01-01 이 **현장이 여는 첫 모바일 화면**이고 오프라인 첫 사례다(결정 17). M-01-06(오류 등록)·W-01-03(초과 분리)이 같은 전표를 쓰므로 한 슬라이스 |
| 4 | U3 출력물 발행 이력 | P-01-01(자재 LOT 라벨)이 입하 «직후»다. ⚠ `rendition` 이 건너뜀이라 **라벨이 실제로 나오지는 않는다** — 발행 «기록»만 선다(§3) |
| 5 | U6 LOT 부가 조회 | M-01-02 스캔 화면과 W-01-07 재고 현황의 남은 칸(보류 목록·외부 식별자)을 메운다. 이미 선 `GET /trace/lots` 위에 얹는 얇은 슬라이스 |
| 6 | U7 검사 실행 | M3 을 당긴다. 입하된 LOT 은 **검사 대기로 잡히므로**(계약: 「자재 LOT 은 등록 즉시 검사 대기로 보류된다」) 검사가 없으면 그 뒤 전 흐름이 막힌다 |
| 7 | U8 LOT Status · 보류 | 결정 10 「차단 판정 단일 지점」. 피킹·출고·출하가 전부 이 지점을 본다 — **U11 보다 반드시 먼저** |
| 8 | U9 긴급 IQC 생략 | U1 · U8 이 서야 성립. 1건짜리 슬라이스라 U8 PR 에 얹을 수도 있다 |
| 9 | U10 적치 지시 | 입고(이미 구현)가 만드는 지시를 소화한다. M-01-05·M-01-07 |
| 10 | U16 실사 | ⚠ **벗어남 — M5(실사)를 앞으로.** 적치까지 서면 창고에 물건이 쌓이는데 **세는 화면이 없으면 초기 데이터가 틀어진 채로 굳는다.** M-01-11(모바일)·W-01-04(관리웹)가 같은 레코드를 쓴다 |
| 11 | U17 재고 조정 | 실사 차이를 닫는다. U16 없이는 W-01-12 의 「실사 결과에서 불러오기」가 빈다 |
| 12 | U19 P/O 수신 · 생산 계획 | 생산 흐름의 머리 |
| 13 | U20 W/O 편성 · 배포 | `:release` 가 **출고요청과 생산 LOT 선발행을 만든다** — U11 · U25 의 원천 |
| 14 | U11 출고요청 · 피킹 | M-01-08. W/O 가 서야 요청이 생긴다 |
| 15 | U12 출고 전표 | M-01-08 의 「출고 확정」 + W-01-05 · W-01-06. **원장 쓰기 첫 코어 슬라이스** |
| 16 | U13 생산창고 입고 | M-01-09. 출고를 받는 쪽 |
| 17 | U22 작업 세션 · 작업 전 점검 | P-02-01 · P-02-02. POP 의 첫 화면 |
| 18 | U23 자재 투입 | P-02-03. 계보(`lot_relation`)가 여기서 시작한다 |
| 19 | U24 생산 실적 · 정정 | P-02-04. M1 tracer bullet 의 종점 |
| 20 | U25 생산 LOT 완료 · 개체 발번 | P-02-06 · P-02-05 |
| 21 | U21 W/O 상태 전이 | 중단·재개(P-02-10)는 세션이 서야, 마감·취소(W-02-05·W-02-06)는 실적이 서야 판정할 수 있다 |
| 22 | U26 공정 인계 · 수리 왕복 | M-02-01 · M-02-02. 실적 뒤 |
| 23 | U14 재고 이동 · 반출 | M-01-10. 불량 반출이 실적·검사 뒤에 생긴다 |
| 24 | U15 재생재 | M-01-12. 분쇄재는 생산이 돌아야 생긴다 |
| 25 | U27 취급 단위 · 포장 | P-02-08 → P-04-01. 완제품 흐름의 머리 |
| 26 | U28 부적합 · 처분 | W-04-07 → W-03-10. 출하 검사·반품이 이 위에 선다 |
| 27 | U29 특채 | W-03-09. U1 · U28 뒤 |
| 28 | U30 출하지시서 · 출하작업지시 | W-04-01 · W-04-02 · M-04-01 |
| 29 | U31 출하 처리 · 확정 · 취소 | W-04-04 · W-04-12. **두 번째 원장 코어 슬라이스** |
| 30 | U32 재고 재등록 | W-04-11. 반품 처분 뒤 |
| 31 | U18 물류 문서 진행현황 · 취소 | ⚠ 취소가 유형 축 하나로 합쳐졌으므로(`계약-재검토-2026-09-04` §2) **입하·입고·출고가 «전부» 선 뒤**라야 한 화면이 온전히 열린다. 그래서 물류 마지막 |
| 32 | U33 설비 점검 · 고장 | M-05-01 · M-05-02. ⚠ **P-02-02(작업 전 점검 통제)가 이 목록을 근거로 삼는다** — 엄밀히는 U22 보다 앞이어야 하나, 점검 «기록»이 없으면 통제 판정이 「이력 없음」으로 떨어지는 것이 정상 동작이라 뒤로 둘 수 있다 |
| 33 | U35 비가동 | P-05-02. 세션(U22)이 조업 시간의 분자라 그 뒤 |
| 34 | U34 보전 지시 · 실적 | W-05-05 · W-05-06 |
| 35 | U36 툴 사용실적 | P-05-01 |
| 36 | U37 계측기 | W-05-10 · W-05-11 |
| 37 | U38 수집 채널 | W-05-07 |
| 38 | U39 검사 집계 | W-03-05. 검사(U7)와 불량 실적(U24)이 둘 다 서야 **숫자가 맞는다** |
| 39 | U2 알림 | W-CO-03 · W-CO-11. 알릴 사건이 먼저 있어야 한다 |
| 40 | U43 첨부 목록 | 1건 |
| 41 | U40 변경 이력 | W-06-11 |
| 42 | U41 예비품 올리기 | W-06-08 |
| 43 | U42 통합 대시보드 | W-CO-05. **모든 카드의 원천이 선 뒤**라야 숫자가 맞는다 — 실적(U24)·비가동(U35)·알림(U2)·캘린더(이미 구현) |

**마일스톤과의 대조.** M1(PO→GR→불출→실적)이 순서 2·3·13·14·15·18·19 에 흩어져 있다 —
화면 단위로 자르면 tracer bullet 이 한 줄로 붙지 않기 때문이다. 다만 **15(U12)·19(U24) 가
M1 의 완성 지점**이라 그 둘의 e2e 가 M1 의 완료 기준(취소 경로 포함 전표 체인)을 진다.
취소 경로는 31(U18)에서 닫힌다 — ⚠ **M1 의 완료 기준이 순서 31 까지 밀린다**는 뜻이고,
이것은 취소가 유형 축으로 합쳐진 결과다.

---

## §3. 건너뜀 표

| 오퍼레이션 | 화면 | 사유 |
|---|---|---|
| `POST /app/attachments` | W-CO-04 · W-CO-08 | **바이너리 저장소.** 물리 `app.attachment` 가 `storage_key VARCHAR(500)` 을 갖는다 — 파일 본체는 DB 밖이다. 「DB 안에서 끝나는 것만」(README §0)에 걸린다 |
| `GET /app/attachments/{attachmentId}/content` | (미지정) | 같은 이유. 계약이 「파일 내용을 그대로 내린다」 |
| `POST /maintenance/breakdowns/{breakdownId}/attachments` | (미지정 · M-05-02) | 고장 사진 3장 업로드. 같은 이유 |
| `GET /app/document-issues/{documentIssueLogId}/rendition` | (미지정 · P-01-01 등) | **서버가 그린 이미지·문서.** 계약이 「서버가 그린 결과를 돌려준다 … 미리보기와 인쇄가 같은 경로다」 — 렌더러가 범위 밖 |
| `GET /app/printers` | (미지정) | **I-27 R15 본길 유보**. 단말매핑·식별명·명시기본/지원·관측 producer 정본이 없다. DB 저장원천만 읽는 경로 확정 뒤 재개; active→READY/관측없음→OFFLINE/전건false/빈stub 금지 |

**다음 0건은 최초 계획 당시 판정이며 현재값이 아니다.** 이후 I-28/I-30/I-26/I-32/I-27 재수립의 본길 유보와 현재475/487 목표는 `plan.md` §6을 따른다.

**최초 계획에서 대기 중인 물음에 본길이 걸려 건너뛰는 것: 0건.** 대기 12·13·14 는 README §0 이 「값 정의·권고안이
있으므로 그대로 구현한다」로 이미 갈랐고, 나머지 물음은 전부 가장자리라 §2 절차로 넘긴다.

⚠ **건너뜀의 결과를 화면 말로 적어 둔다** — 라벨·인식표를 뽑는 POP 화면 여덟(P-01-01 · P-01-02 ·
P-02-05 · P-02-07 · P-02-09 · P-04-02 · P-04-04 · W-05-13)은 **「발행 기록은 남지만 종이가 나오지
않는」** 상태로 선다. 현장 검증을 이 상태로 하면 「인쇄가 안 된다」는 버그 보고가 쏟아진다 —
배포 노트에 미리 적어야 한다.

---

## §4. 위험 — 이 관점에서 보이는 함정 10

| # | 함정 | 어디서 터지나 | 왜 UI/UX 관점에서 보이나 |
|---:|---|---|---|
| 1 | **집계를 페이지에서 접는다.** 목록 응답을 화면이 모아 더하면 「필터 전체 기준」과 다른 수가 나온다 | U39 · U42 · U35 · U30 · U20 · U16 · U28 | 계약이 같은 경고를 **여덟 곳에 반복**해 적었다(`L-1`·`L-2`). 반복이 곧 이 함정이 흔하다는 증거다. 서버가 요약 오퍼레이션을 «따로» 내려주지 않으면 화면은 반드시 접는다 |
| 2 | **「판정 불가」를 0 이나 「정상」으로 접는다.** `UNDETERMINABLE` · `NOT_YET` · `closable=false` 의 이유 코드 · `availabilityPercent: null` · `outOfScopeCount` | U20 · U16 · U18 · U35 · U42 · U8 | 계약이 전부 별도 칸으로 뺐다 — 「⛔ `UNDETERMINABLE` 을 `ON_TIME` 으로 접지 않는다 — 「판정 불가」를 「정상」으로 보이면 요약의 지연 건수가 실제보다 적게 나온다」. 서버가 0 을 내면 화면은 **틀린 것을 맞다고 그린다** |
| 3 | **오프라인 큐가 `If-Match` 를 못 싣는다**(공유계약 `C-9`) — 현장 오퍼레이션에서 `If-Match` 를 필수로 만들면 POP 이 재전송 때 409 로 죽는다 | U12 · U14 · U22 · U23 · U24 · U25 · U27 · U15 · U35 | 계약이 **15건**을 「`Idempotency-Key` 는 필수이고 `If-Match` 는 선택」이라 명시했다(§8-2 목록). 서버가 일괄로 필수화하면 그 15건이 전부 깨진다 |
| 4 | **멱등키의 유일 범위가 표마다 다르다.** `inventory_transaction` 만 `(idempotency_key, business_date)` 고 나머지는 전역 | U12 · U14 · U17 · U24 · U31 · U32 | `business_date` 는 클라이언트가 보낸다(C-8). 자정을 넘긴 오프라인 재전송이 **이중 전기**가 되는 자리가 정확히 여기다. 화면이 재전송하는 것이 정상 동작이므로 서버가 막아야 한다 |
| 5 | **부모 ETag 로 자식을 잠근다**(`B-1-1`). 자식 컬렉션 GET 에 ETag 를 붙이면 화면이 잘못된 토큰을 보낸다 | U4 · U5 · U6 · U12 · U14 · U17 · U27 · U1 | 계약이 자식 치환 **7건**에 「⭐ 이 경로의 조회는 ETag 를 내리지 않는다」를 못박았다. 서버가 습관적으로 붙이면 409 가 «나야 할 때 안 나거나» 그 반대가 된다 |
| 6 | **목록의 「기간 필수」(`L-3`)와 「미처리 전건」(`L-12`)이 한 오퍼레이션에 공존한다** | U33 · U35 · U8 · U30 · U31 · U2 · U40 · U39 | `GET /maintenance/downtimes` 가 대표다 — 「기간이 필수다 … 다만 `openOnly=true` 로 부르는 호출은 기간을 비울 수 있다」. 규칙을 하나로 통일하면 **P-05-02 의 「진행 중 비가동」 구획이 전날 것을 놓친다** |
| 7 | **한 화면이 두 슬라이스에 걸려 「반쯤」 열린다** | M-01-08(U6·U8·U11·U12·U30 — 5슬라이스 · 10건 전건 미커버) · M-01-10(3) · W-02-05(4) | 화면 단위로 자르면 이 문제가 «보인다». 자원 축으로 자르면 안 보인다 — M-01-08 은 피킹만 서고 출고가 안 서면 「LOT 을 집었는데 확정 버튼이 죽어 있는」 화면이 된다 |
| 8 | **파생값 정렬이 페이지와 어긋난다** | U20(달성률) · U7(재검 사슬) · U31(경과일) | `GET /quality/inspection-results` 가 가장 험하다 — 「`finalRoundOnly=false` 면 page/size/total 은 뿌리 결과(1회차) 기준으로 세고, 사슬 전체가 뿌리와 같은 페이지에 동거한다」. 평범한 LIMIT/OFFSET 으로 짜면 **부모·자식이 페이지로 갈린다** |
| 9 | **`screenId` 를 널로 보낸다** | U18 · U42 · U2 · U1 | 세 자리(`DocumentProgress`·`ApprovalTarget`·`Notification`)가 화면 식별자를 요구하는데 대응표가 저장소 어디에도 없다. 계약의 물러난 길은 **「키를 생략한다 — 널을 보내지 않는다」**. 널을 보내면 화면이 `openable` 판정을 뒤집는다 |
| 10 | **현장 셸의 주체를 단말 토큰으로 푼다** | U1(M-01-13) · U3 · U33 · U35 · U22 | 계약이 명시적으로 막았다 — 「⛔ 단말 토큰으로 풀지 않는다 — 한 단말을 여러 작업자가 «교대로» 쓰므로 남이 올린 요청이 섞인다」. `X-Worker-No` 를 받는 오퍼레이션이 **41건**인데(§8-3), 이것을 감사 컬럼용으로만 쓰고 필터 주체로 안 쓰면 M-01-13 의 「내가 올린 요청」이 남의 것을 보인다 |

> 11번째로 적어 둘 것 — **`GET /production/work-orders` 의 질의 파라미터가 23개다**(`released` ·
> `held` · `open` · `releasable` · `poMismatch` · `withProgress` · `withSummary` · `withValidation` …).
> 여덟 화면이 이 하나를 공유한다. 조합을 다 열면 인덱스로 감당이 안 되고, 화면마다 다른 서브셋만
> 열면 계약과 어긋난다. **U20 을 세 PR 로 잡은 이유가 이것이다.**

---

## §5. 화면 → 오퍼레이션 대응표 (관점 고유 ①)

### §5-1. 대응을 어떻게 얻었나

`x-screen` 이라는 확장 필드는 **없다.** 화면 식별자는 오퍼레이션의 `description` 과
`x-internal-note` 안에 「근거: `W-01-04` §5-6」 꼴로 박혀 있다. 계약 7벌의 `paths` 를 전부
파싱해 `[WMP]-(\d\d|CO)-\d\d` 를 뽑았다.

- 미커버 **249건 중 207건**이 화면 식별자를 스스로 들고 있다.
- **42건은 안 들고 있다** — §5-3 에서 화면 명세를 읽어 붙였다.
- 반대 방향(설계 저장소 `screens/` 의 화면 명세 → API)은 **성립하지 않는다.** 화면 명세는
  계약보다 먼저 쓰였고 엔드포인트 경로를 적지 않는다(§4 는 «출처 컬럼»을 적는다). 그래서
  대응의 정본은 «계약 쪽»이고, 화면 명세는 §3 레이아웃·§4 필드·§5 액션으로 **묶음의 완결성**을
  검증하는 데 쓴다.

### §5-2. 화면마다 «같이» 있어야 하는 묶음

숫자는 그 화면이 쓰는 **미커버** 오퍼레이션 수다(이미 구현된 것은 세지 않았다).
「목록·상세·라인·자식·집계·파생·동사」 다섯 칸이 그 화면의 «묶음 모양»이다 —
**한 칸이라도 다른 슬라이스로 갈리면 그 화면은 반쯤 열린다.**

| 화면 | 미커버 | 목록 | 상세 | 라인·자식 | 집계·파생 | 동사 | 슬라이스 |
|---|--:|---|---|---|---|---|---|
| **(미지정)** | 42 | 6 | 10 | 2 | 2 | 22 | U3·U4·U5·U6·U12·U14·U17·U22·U31·U33·U34·U35·U36·U37·U38·건너뜀 |
| **M-01-01** | 1 | — | — | — | — | 1 | U5 |
| **M-01-02** | 2 | — | — | 1 | — | 1 | U6·U25 |
| **M-01-05** | 3 | 1 | 1 | — | — | 1 | U10 |
| **M-01-06** | 4 | 1 | 1 | 1 | — | 1 | U5 |
| **M-01-07** | 2 | 1 | — | — | — | 1 | U10 |
| **M-01-08** | 10 | 4 | 2 | 1 | — | 3 | U6·U8·U11·U12·U30 |
| **M-01-09** | 4 | 2 | 1 | — | — | 1 | U12·U13 |
| **M-01-10** | 8 | 3 | 1 | 2 | — | 2 | U10·U14·U27 |
| **M-01-11** | 2 | 1 | — | — | — | 1 | U16 |
| **M-01-12** | 1 | — | — | — | — | 1 | U15 |
| **M-01-13** | 2 | 1 | — | — | — | 1 | U1·U9 |
| **M-02-01** | 3 | 1 | 1 | — | — | 1 | U26 |
| **M-02-02** | 8 | 3 | 1 | — | — | 4 | U23·U26·U39 |
| **M-04-01** | 2 | 1 | — | — | — | 1 | U30·U31 |
| **M-04-03** | 3 | — | — | 1 | — | 2 | U27 |
| **M-04-04** | 1 | 1 | — | — | — | — | U10 |
| **M-05-01** | 1 | 1 | — | — | — | — | U33 |
| **M-CO-01** | 1 | 1 | — | — | — | — | U1 |
| **P-01-01** | 4 | 1 | 1 | 1 | — | 1 | U3·U5 |
| **P-01-02** | 6 | 2 | 2 | 1 | — | 1 | U3·U12·U27 |
| **P-02-01** | 5 | 1 | 1 | 1 | — | 2 | U20·U22 |
| **P-02-02** | 5 | 2 | — | — | — | 3 | U22·U33 |
| **P-02-03** | 4 | 1 | 1 | — | — | 2 | U23·U26 |
| **P-02-04** | 4 | 1 | 1 | — | — | 2 | U24·U26 |
| **P-02-05** | 2 | 1 | — | — | — | 1 | U25 |
| **P-02-06** | 1 | — | — | — | — | 1 | U25 |
| **P-02-08** | 3 | 1 | — | — | — | 2 | U27 |
| **P-02-10** | 4 | — | — | 1 | — | 3 | U21·U22 |
| **P-02-12** | 1 | — | — | — | — | 1 | U20 |
| **P-02-13** | 3 | — | 1 | — | — | 2 | U7 |
| **P-04-01** | 3 | 1 | — | — | — | 2 | U27·U31 |
| **P-04-02** | 2 | 1 | — | — | — | 1 | U3·U31 |
| **P-04-03** | 2 | 2 | — | — | — | — | U28·U39 |
| **P-04-04** | 1 | — | — | — | — | 1 | U27 |
| **P-05-02** | 3 | 1 | — | — | — | 2 | U33·U35 |
| **W-01-01** | 6 | 2 | 1 | — | — | 3 | U7 |
| **W-01-02** | 2 | 2 | — | — | — | — | U1·U8 |
| **W-01-03** | 6 | 1 | 2 | 1 | — | 2 | U4·U5 |
| **W-01-04** | 5 | 1 | 1 | 1 | — | 2 | U16 |
| **W-01-05** | 3 | 1 | 1 | — | — | 1 | U12 |
| **W-01-06** | 5 | 1 | 1 | — | — | 3 | U12 |
| **W-01-07** | 1 | — | — | 1 | — | — | U6 |
| **W-01-09** | 5 | 2 | 2 | 1 | — | — | U4 |
| **W-01-11** | 5 | 1 | — | 1 | — | 3 | U4 |
| **W-01-12** | 6 | 1 | 1 | 1 | — | 3 | U17 |
| **W-01-13** | 4 | 1 | 1 | — | — | 2 | U18 |
| **W-02-01** | 4 | 2 | 1 | — | — | 1 | U19·U20 |
| **W-02-02** | 7 | 1 | 1 | — | — | 5 | U19·U21 |
| **W-02-03** | 7 | 1 | — | 1 | 1 | 4 | U19·U20 |
| **W-02-04** | 4 | 1 | — | — | — | 3 | U19·U20 |
| **W-02-05** | 7 | 2 | 1 | — | — | 4 | U20·U21·U24·U25 |
| **W-02-06** | 5 | 2 | 1 | — | — | 2 | U19·U21·U25 |
| **W-02-07** | 4 | 1 | — | — | — | 3 | U19·U20 |
| **W-02-08** | 4 | 2 | 2 | — | — | — | U20·U24 |
| **W-02-10** | 3 | — | — | — | 1 | 2 | U11·U20 |
| **W-03-01** | 6 | 4 | 1 | — | 1 | — | U8 |
| **W-03-02** | 6 | 2 | — | — | 1 | 3 | U8·U32 |
| **W-03-03** | 3 | 1 | — | — | — | 2 | U8·U28 |
| **W-03-05** | 9 | 3 | 1 | 1 | 4 | — | U7·U39 |
| **W-03-09** | 4 | 2 | 2 | — | — | — | U1·U28·U29 |
| **W-03-10** | 5 | 2 | 1 | 1 | — | 1 | U28 |
| **W-04-01** | 4 | 1 | 2 | — | — | 1 | U30 |
| **W-04-02** | 3 | 2 | — | — | 1 | — | U30·U31 |
| **W-04-03** | 1 | — | — | — | — | 1 | U32 |
| **W-04-04** | 5 | 3 | — | — | 1 | 1 | U30·U31 |
| **W-04-05** | 3 | 1 | — | — | 1 | 1 | U30·U31 |
| **W-04-06** | 2 | 1 | — | — | — | 1 | U28·U31 |
| **W-04-07** | 5 | 2 | — | — | 1 | 2 | U28 |
| **W-04-10** | 2 | 1 | — | — | — | 1 | U12·U28 |
| **W-04-11** | 4 | 1 | 1 | — | — | 2 | U14·U28·U32 |
| **W-04-12** | 5 | 1 | — | — | — | 4 | U31 |
| **W-05-04** | 1 | — | — | — | — | 1 | U33 |
| **W-05-05** | 4 | 3 | — | — | 1 | — | U28·U33·U34 |
| **W-05-06** | 1 | — | — | — | — | 1 | U34 |
| **W-05-07** | 2 | — | — | — | — | 2 | U38 |
| **W-05-08** | 1 | — | — | — | 1 | — | U35 |
| **W-05-10** | 2 | 1 | — | — | — | 1 | U2·U37 |
| **W-05-11** | 2 | 1 | — | — | — | 1 | U37 |
| **W-05-13** | 1 | — | — | — | — | 1 | U3 |
| **W-06-06** | 10 | 10 | — | — | — | — | U10·U13·U14·U17·U19·U20·U28·U31·U40 |
| **W-06-08** | 1 | — | — | — | — | 1 | U41 |
| **W-06-10** | 1 | — | — | — | — | 1 | U19 |
| **W-06-11** | 1 | 1 | — | — | — | — | U40 |
| **W-06-12** | 1 | — | — | — | — | 1 | U21 |
| **W-06-14** | 1 | — | — | — | — | 1 | U1 |
| **W-06-15** | 9 | 1 | 1 | 1 | — | 6 | U1·U24 |
| **W-CO-02** | 1 | 1 | — | — | — | — | U40 |
| **W-CO-03** | 5 | 2 | — | — | 1 | 2 | U2 |
| **W-CO-04** | 2 | 1 | — | — | — | 1 | U43·건너뜀 |
| **W-CO-05** | 1 | — | — | — | 1 | — | U42 |
| **W-CO-08** | 2 | 1 | — | — | — | 1 | U43·건너뜀 |
| **W-CO-09** | 4 | 1 | 1 | — | — | 2 | U1 |
| **W-CO-11** | 4 | 2 | — | — | 1 | 1 | U2 |

### §5-3. 화면 식별자를 안 들고 있는 42건 — 어디에 붙는가

계약이 화면을 안 적은 것이 곧 「쓰는 화면이 없다」는 뜻은 아니다. 대부분은 **형제
오퍼레이션이 화면을 들고 있는 «한 벌»의 나머지**다(상세 GET · 라인 치환 PUT).

| 오퍼레이션 무리 | 건 | 붙는 화면 | 근거 |
|---|--:|---|---|
| `/app/document-issues` 계열 5 + `printers` 1 + `attachments/content` 1 | 7 | P-01-01 · P-01-02 · P-02-05 · P-02-07 · P-02-09 · P-04-02 · P-04-04 · W-05-13 | `report-print` 만 화면을 들고 있고(`P-01-01,P-01-02,P-04-02,W-05-13`) 나머지는 같은 「공통 출력물 계약」 한 벌이다. 계약이 그렇게 부른다 — 「라벨 출력은 이 오퍼레이션 밖이다 — **공통 출력물 계약이 소유한다**」 |
| `/maintenance/*` 상세·쓰기 | 23 | M-05-01 · M-05-02 · W-05-04 · W-05-05 · W-05-06 · W-05-02 · W-05-03 · P-05-01 · P-05-02 · W-05-07 · W-05-11 | 05 계약은 **목록에만** 화면을 적고 상세·쓰기에는 안 적는 습관이 있다. 예 — `GET /maintenance/breakdowns` 는 `W-05-05` 를 들고 있는데 `{breakdownId}` 는 안 들고 있다 |
| 물류 자식 치환 PUT 7 (`inbound-receipts` 헤더·라인 · `purchase-orders` 헤더 · `goods-issues` 라인 · `stock-transfers` 라인 · `adjustments` 라인 · `lots/external-identifiers`) | 7 | W-01-03 · M-01-01 · W-01-11 · W-01-06 · M-01-10 · W-01-12 · M-01-02 | 전부 「부모 자원 GET 의 ETag 를 If-Match 로 쓴다」로 부모를 지목한다 — **부모의 화면이 곧 이 오퍼레이션의 화면**이다 |
| `/production/work-sessions` 목록·작업자 3 + `:end` 1 | 4 | P-02-01 · P-02-04 · P-02-10 | `{workSessionId}` 상세와 `/workers` 목록이 `P-02-01` 을 들고 있다. 「세션 작업자 목록」의 짝인 «참여·이탈»이 화면을 안 들고 있을 뿐이다 |
| `GET /logistics/shipments/{shipmentId}` | 1 | W-04-04 · W-04-12 | 형제 목록 `GET /logistics/shipments` 가 「W-04-02·W-04-04·W-04-12 가 함께 쓴다」라 적었다 |

⚠ **이 중 셋은 「정말로 부르는 화면이 없다」** — 계약이 스스로 그렇게 적었다. §9-2 에 옮긴다.

---

## §6. 현장 우선순위 (관점 고유 ②)

### §6-1. 매일 도는 흐름과 그것을 지는 화면

하노이(UTC+7) 현장 작업자가 **하루에 여러 번** 여는 화면만 골랐다. 관리 화면(결재선 정의 ·
알림 수신자 설정 · 대시보드 · 변경 이력)은 **한 달에 몇 번**이라 뒤로 뺐다.

```
입하 ──▶ 검사 ──▶ 입고 ──▶ 적치 ──▶ 피킹 ──▶ 불출 ──▶ 투입 ──▶ 실적 ──▶ 검사 ──▶ 출하
M-01-01  W-01-01  W-01-10  M-01-05  M-01-08  M-01-08  P-02-03  P-02-04  P-02-13  M-04-01
 (U5)     (U7)    ✅구현됨   (U10)    (U11)    (U12)    (U23)    (U24)    (U7)     (U30)
                            M-01-07                    M-01-09                     P-04-01
                            (U10)                      (U13)                       (U27)
```

| 등급 | 화면 | 여는 빈도 | 슬라이스 | 지금 상태 |
|---|---|---|---|---|
| **1군 — 매일 여러 번** | M-01-01 입하 등록 | 트럭마다 | U5 | 1/1 미커버 |
| | M-01-05 적치·입고 완료 | 입고마다 | U10 | 3/6 미커버 |
| | M-01-08 자재 출고·피킹 | W/O 마다 | U11+U12 | **10/10 전건 미커버** |
| | P-02-01 작업 시작 | 교대마다 | U22 | 5/5 미커버 |
| | P-02-03 자재 투입 스캔 | 투입마다 | U23 | 4/5 미커버 |
| | P-02-04 작업 실적 등록 | 실적마다 | U24 | 4/5 미커버 |
| | W-01-01 IQC 판정 | 입하마다 | U7 | 6/6 미커버 |
| **2군 — 매일 한두 번** | M-01-06 입하 오류 · M-01-07 임시 적재 · M-01-09 생산창고 입고 · M-01-10 반출 · P-02-02 점검 통제 · P-02-06 LOT 완료 · P-02-13 PQC · M-04-01 제품 피킹 · P-04-01 Packing · P-05-02 비가동 · M-05-01 설비 점검 | | U5·U10·U13·U14·U22·U25·U7·U30·U27·U35·U33 | |
| **3군 — 주 단위** | W-01-03 초과 분리 · W-01-05 반품 · W-01-06 폐기 · W-02-02 전개 · W-02-04 배포 · W-02-05 마감 · W-04-01 편성 · W-04-04 출하 처리 · W-03-02 판정 전이 | | | |
| **4군 — 월 단위 · 관리** | W-06-15 결재선 · W-CO-11 알림 수신자 · W-CO-05 대시보드 · W-06-11 변경 이력 · W-05-07 수집 채널 · W-06-08 예비품 | | U1·U2·U42·U40·U38·U41 | |

### §6-2. 그런데 4군인 W-06-15(결재선)를 «맨 앞»에 둔다 — 이유

현장 우선주의를 여기서 한 번 깬다. 결재선은 «월 단위» 화면이지만 **결재선이 없으면 1~3군
화면의 주 버튼이 400 을 낸다.** 계약이 여덟 자리에 같은 문장을 적었다 —
「결재선이 없으면 400(`code=ROUTE_NOT_FOUND`)이다 — 상신할 곳이 없는 요청을 만들지 않는다」.

이것은 「관리 화면을 먼저 만든다」가 아니라 **「현장 화면의 죽은 버튼을 없앤다」**로 읽어야 한다.
같은 이유로 U1 의 e2e 는 결재선 정의가 아니라 **「W-01-06 에서 상신 → W-CO-09 에서 승인 →
W-01-06 에서 전기」** 한 줄이어야 한다.

### §6-3. 뒤로 미루는 것과 그 근거

| 미루는 것 | 근거 |
|---|---|
| W-CO-05 통합 대시보드 (U42) | 카드 6종(생산량·양품률·성능가동률·시간가동률·미처리 알람·OEE)의 원천이 **전부 다른 슬라이스**다. 원천이 반만 서면 카드가 `NOT_YET`·`PARTIAL` 로 뜨는데, 그 상태를 현장에 보이면 「대시보드가 고장났다」로 읽힌다. 계약이 자동 갱신도 뺐다(「⛔ 자동 갱신을 두지 않는다 — 사람이 「갱신」을 누른다」) — 급할 이유가 없다 |
| W-CO-11 알림 수신자 설정 (U2) | 계약이 「⛔ 2026-08-29 실측 — **발생 지점 표가 아직 비어 있다**」라 적었다. 수신자를 설정해도 **나올 알림이 정의돼 있지 않다** |
| W-06-11 변경 이력 (U40) | `audit_event.before_value`/`after_value` jsonb 키 규약이 없다(`§I-5`). 화면이 그릴 수 있는 것은 원문 jsonb 뿐이다 |
| W-05-07 수집 채널 (U38) | T실제관측조회는구현하되수집자/시각선택·역순/동률·보관운영인수는118미완. 저장자료없는현장import완료주장0·영구빈handler0 |
| W-06-08 예비품 올리기 (U41) | 받을 열이 미정(`§P`). 현행 엑셀 대장 이관은 초기 1회다 |

---

## §7. 조회 설계 (관점 고유 ③)

### §7-1. 목록 — 필터·정렬·페이지의 세 갈래

미커버 249건 중 **조회 GET 은 133건**이다. 계약을 읽으면 목록이 세 갈래로 갈린다.

| 갈래 | 규약 | 어느 목록 | 서버가 지켜야 할 것 |
|---|---|---|---|
| **① 기간 유계 목록** | 공유계약 `L-3` — 기간 없이 열면 목록이 끝나지 않는다 | `/app/notifications` · `/audit/events` · `/maintenance/downtimes` · `/maintenance/inspections` · `/logistics/shipment-requests` · `/logistics/shipments` · `/quality/inspection-results` · `/quality/lot-hold-events` | 기간이 없으면 **400**. `/audit/events` 는 `occurred_at` RANGE 파티션이라 없으면 전 파티션을 훑는다 |
| **② 미처리 전건 목록** | 공유계약 `L-12` — 기본이 미처리 전건, 정렬은 «경과일 긴 순» | `/maintenance/breakdowns`(기본) · `/maintenance/inspections`(보전 지시 트리거 모드) · `/maintenance/downtimes?openOnly=true` · `/logistics/shipments`(W-04-12 미확정) | 기간을 **비울 수 있어야** 한다. 「전날부터 이어진 구간을 놓치면 안 되기 때문」 |
| **③ 구간 형 리소스** | 공유계약 `G-16` — 「진행 중」을 상태 컬럼으로 두지 않는다 | `/quality/lot-holds?open` · `/production/work-sessions?open` · `/production/repair-executions?open` · `/maintenance/downtimes?openOnly` · `/maintenance/calibrations`(`clearedAt IS NULL`) | 열림/닫힘을 **끝 시각의 널 여부**로 판정한다. `status_code` 로 판정하면 §Z-3 의 실수를 되풀이한다 |

**정렬.** 계약이 `sort` 파라미터를 «여덟 목록에만» 열었다 — `breakdowns` · `inspections` ·
`inspection-results` · `lot-holds`(`lot-hold-events`) · `lot-statuses` · `work-orders` ·
`shipment-requests` · `shipments`. 나머지는 **서버 기본 정렬 하나뿐**이고 계약이 그 값을 적었다:

- `GET /logistics/asns` — 「기본 정렬은 **도착 예정일 오름차순**」(W-01-09 §5-1)
- `GET /app/approval-routes/{id}/steps` — 「**`stepNo` 오름차순**」
- `GET /maintenance/inspections` — 「⭐ 기본 정렬이 **점검 시각 내림차순**이라, `equipmentId`·`inspectionTypeCode` 로 좁히고 `size=1` 로 부르면 통제 판정이 쓰는 「가장 최근 한 건」이 된다(P-02-02 §5-5)」
- `GET /maintenance/breakdowns` — 「기본은 처리되지 않은 전건이고 **경과일이 긴 순**」
- `GET /logistics/shipments`(W-04-12) — 화면 명세가 「**경과일 긴 순(기본값)**」

⚠ **기본 정렬을 안 정하면 화면이 매번 다른 순서를 본다.** POP 은 「첫 줄을 집는」 조작이 많아
(`size=1` 로 최근 한 건을 집는 P-02-02 가 대표) 기본 정렬이 곧 업무 판정이 된다.

**페이지.** `page`·`size` 를 가진 목록은 **54건**이다. 계약이 페이지를 «반드시» 요구한 자리는
둘이고 이유까지 적었다 —
- `GET /inventory/counts/{id}/lines` — 「창고 하나의 라인이 **수천 건**이라 페이지네이션이 필요하다」
- `GET /quality/inspection-results/{id}/measurements` — 「의뢰 412 · 결과 450 에 견줘 측정치는
  **135,000 자릿수**라 표가 터진다. **「한 화면」이지 「한 표」가 아니다**」

⚠ 반대로 **페이지를 두면 안 되는 자리**도 계약이 적었다 — `GET /app/document-issues/summary` 는
`targetIds` 를 배열로 받아 「여러 대상의 발행 현황을 **한 번에** 돌려준다 … 대상이 수백 건이면
건별 조회로는 그릴 수 없다」. 목록 화면의 행마다 배지를 그리는 자리라 N+1 이 나면 화면이 멈춘다.

### §7-2. 집계 — 「무엇을 어떤 축으로 세나」

집계는 잘못 만들면 **화면이 틀린 숫자를 보인다.** 아래는 계약 응답 스키마의 설명문과 화면
명세의 표시 항목을 대조해 적은 정의다. 인용은 계약 원문(⌜⌝) 과 화면 명세 원문(「」)이다.

#### ① `GET /quality/inspection-results/summary` — 검사 요약 카드 5종 (W-03-05 §3)

| 칸 | 정의 | 함정 |
|---|---|---|
| `inspectionCount` · `inspectedQty` · `acceptedQty` · `rejectedQty` · `heldQty` | 필터 전체 기준 합계 | ⌜요약 카드 5종 — **필터 전체 기준이다**(공유계약 L-1). 파생은 서버가 계산한다(L-2)⌝ |
| `defectRate` | ⌜백분율. ⭐ **분모는 검사 수량이다 — 생산 수량이 아니다.** W-02-08 의 수율(생산 수량 기준 · 손실 분리)과 **다른 수가 나오는 것이 정상**이다⌝ | 두 화면의 「불량률」이 달라 보이는 것이 버그가 아니다. 배포 노트에 적어야 한다 |
| `finalRoundOnly` | ⌜검사 건수·수량은 **최종 회차만** 센다. 재검 합격분은 합격으로 세지만 **1회차 불량 실적은 그대로 남아 두 수가 다르다**⌝ | 이 플래그를 응답에 되돌려주지 않으면 화면이 어느 기준으로 센 수인지 모른다 |
| `calibrationExpiredCount` | ⌜교정 만료 장비로 측정된 건수. ⛔ **집계에서 자동으로 빼지 않는다** — 무효화 정책이 미정이다(WF03 예외 E-9 ①)⌝ | 빼면 「우리가 정책을 지어낸 것」이 된다 |
| `asOf` | ⌜서버 집계 기준 시각 … **브라우저 수신 시각이 아니다**⌝ | 요약을 내는 **일곱 오퍼레이션 전부**가 이 칸을 갖는다(`L-5`) |

#### ② `GET /quality/defect-records/distribution` — 불량코드 2계층 분포 (W-03-05 §5-5)

- 세는 대상: ⌜⚠ 이 뷰는 **검사 결과가 아니라 불량 레코드를 센다** — 판정·최종회차·교정만료 축이 없다⌝
- 축: `groupBy` — ⌜`occurrenceProcess` 로 묶어야 개선 대상이 나온다⌝
- 노드: `defectCodeId` · `parentDefectCodeId` · `recordCount` · `defectQty` · `share`(백분율)
- ⚠ `duplicateRisk` — ⌜공정별로 나눌 때 **같은 현상이 공정 수만큼 복제 등록**됐을 수 있다는 표식…
  화면은 경고를 **상시** 보인다⌝. 이 칸을 안 내면 화면이 왜곡된 분포로 개선 대상을 고른다

#### ③ `GET /quality/inspection-results/defect-rate-trend` — 불량률 추이 (W-03-05 §5-8)

- 축: **일자 × 불량률.** 점마다 `bucket`(일자) · `inspectedQty` · `rejectedQty` · `defectRate`
- ⛔ ⌜**관리도 통계(Xbar-R · Cp/Cpk)는 없다** — Analytics 이연(결정 11)⌝ — 만들면 범위를 넘는다

#### ④ `GET /quality/inspection-results/{id}/measurement-summary` — 항목별 측정 요약

- 왜 서버가 세나: ⌜결과 하나의 측정치 **전건(수만 행일 수 있다)**을 서버가 항목 단위로 요약한다.
  **페이지 단위 원시 행을 브라우저에서 합산하면 틀린 요약**이 되고, 항목·장비를 건별 조회하면 N+1 이다⌝
- 「전체 보기」는 별개다 — 원시 행은 `/measurements` 페이지 조회를 그대로 쓴다

#### ⑤ `GET /quality/lot-status-summary` — LOT 상태 4값 (W-03-01 §5-4)

- 축: `statusCode`(`NORMAL`·`DEFECTIVE`·`INSPECTION_PENDING`·`SCRAPPED`) **× `lotTypeCode`**
- ⚠ ⌜셋(자재·생산·제품)을 **합쳐 집계하지 않는다**(공유계약 L-7) — 같은 「보류 38건」이라도 자재와 제품은 뜻이 다르다⌝
- ⚠ ⌜**판정 불가를 0 으로 내리지 않는다**(L-8)⌝ · `outOfScopeCount` — ⌜권한 범위(`user_data_scope`) 밖이라 목록에 안 나온 건수. ⚠ 「없다」와 구분되지 않는 문제를 화면이 문구로 푼다⌝

#### ⑥ `GET /maintenance/downtimes/summary` — 비가동 집계 (W-05-08 §5-2·§5-6)

| 칸 | 정의 |
|---|---|
| `operatingMinutes` | ⌜조업 시간(분). 서버가 설비별·기간별로 **작업 세션 구간을 더한 값**⌝ ← U22 가 서야 값이 산다 |
| `plannedDowntimeMinutes` | ⌜계획 비가동(분). **작업 캘린더가 정한** 휴무·계획 정지. ⛔ 이 오퍼레이션이 만들지 않는다⌝ |
| `availabilityPercent` | 시간가동률. ⌜**조업 시간이 0 이면 비어 있다** — 화면은 산출 불가로 그린다⌝ (0% 가 아니다) |
| `openIntervalCount` · `overlappingIntervalCount` | ⌜아직 끝나지 않아 **합계에서 빠진** 구간 수⌝ · ⌜겹쳐서 **한 번만 센** 구간 수⌝ — 건수만 내고 목록은 안 담는다 |
| `minorStop*` | ⌜임계보다 짧은 구간이며 **위 합계에 들어 있다** — 걸러서 빼지 않고 줄을 나눠 보인다. 잦다는 것 자체가 신호라 감추면 안 된다⌝ · 임계 기본 5분을 **응답에 함께 내린다** |
| `byReason` / `byEquipment` / `byPeriod` | `groupBy` 에 따라 «하나만» 채워진다. 사유는 6값 코드 그룹 `DOWNTIME_REASON` |
| `sessionsWithoutEquipmentCount` | ⌜설비가 붙지 않은 작업 세션 수. 조업 시간에는 들어가지만 설비별 묶음에서는 빠진다 … **0 과 「모른다」를 같은 모양으로 그리지 않기 위해 «건수»로 내린다**⌝ |
| 보전 3칸 | ⌜보전 건수 셋은 비가동이 아니지만 **같은 사람이 같은 시점에 보므로** 요약에 함께 낸다 — 탭을 늘리지 않는다⌝. `breakdownsClosedWithoutOrderCount` 의 ⌜**비율의 분모는 사후·예방 보전 건수의 합**이다 — 완료 고장 전체가 아니다⌝ |
| ⛔ | ⌜**설비종합효율은 내지 않는다**⌝ — OEE 는 `GET /app/dashboard-summary` 소관 |

#### ⑦ `GET /app/dashboard-summary` — 통합 대시보드 (W-CO-05 §5·§8-1)

- 카드 6종 고정: ⌜생산량 · 양품률 · 성능가동률 · 시간가동률 · 미처리 알람 · **OEE**⌝ —
  ⌜⛔ **카드가 늘면 드릴다운 대상도 함께 정해야 하므로 계약이 닫는다**⌝
- OEE 분모: ⌜계획 조업 시간의 분모는 `mdm.WorkCalendar`/`WorkCalendarDay`/`WorkCalendarApplication`(결정 03)에서 구한다⌝
- `valueStatusCode` — ⌜`NOT_YET` 이면 화면이 **0 이 아니라 「아직 없음」**을 그린다 · `PARTIAL` 이면 `excludedCount` 를 함께 보인다⌝
- `note` — ⌜분모가 온전하지 않은 지표는 여기에 그 사실을 담는다(예: 「시간가동률은 교대 시간 기준입니다 — 휴일·계획 정지가 반영되지 않았습니다」). ⛔ **툴팁이 아니다**⌝
- ⛔ ⌜**자동 갱신을 두지 않는다** — 사람이 「갱신」을 누른다⌝

#### ⑧ `GET /logistics/shipment-requests/summary` — 출하 예정 요약 (W-04-02 §4-B)

화면 명세의 요약 구획 원문: 「작업지시 24건 · 요청 12,400 · 배정 11,900 · 출하 3,200 ·
**미배정 = 요청−배정** 500 · 검사대기 4건 · 피킹미완 9건」.
계약이 그대로 여섯 칸 + `asOf` 를 낸다. ⌜`unallocatedQtyTotal` — 요청 − 배정. ⭐ **서버가 계산한다**(L-2)
— 화면이 `requestedQtyTotal`·`allocatedQtyTotal` 을 받아 다시 빼지 않는다⌝ ·
⌜질의 축은 짝 목록과 같다 — **`page`·`size`·`sort` 만 뺀다**(L-1-1 ⑶)⌝

#### ⑨ `GET /production/work-orders` 의 `withSummary` — W/O 목록 요약 (W-02-08 §5-2)

화면 명세 원문: 「요약 카드 6종(전체·대기·진행중·완료·마감·지연) = `COUNT(*) GROUP BY status_code`,
양품·불량·손실 합계 = `SUM(good_qty)` 등, **달성률 = `SUM(good_qty) / SUM(order_qty)`**」.
계약의 `WorkOrderListSummary` 가 그대로다. ⚠ required 는 `totalCount`·`statusCounts` **둘**뿐 — 나머지 8칸 중 카운트는 0 도 값으로 내고, `achievementRate` 는 분모 0 이면 키 생략(I-6 R-21). 두 함정:

- ⚠ ⌜**기간 축은 W/O 의 «계획 시작 시각»**이라 「그 기간에 생산된 양」이 아니다⌝ — 화면 라벨을
  「생산량」으로 쓰면 틀린 뜻이 된다
- `undeterminableDelayCount` — ⌜계획 종료 시각이 없어 지연을 판정할 수 없는 건 — **「지연 아님」과 구분한다**⌝

행 단위 `withProgress`(`WorkOrderProgress`)는 ⌜**정정(상쇄) 실적이 반영된 값**⌝이고
`achievementRate` 의 ⌜분모는 **지시 수량**⌝이다. ⚠ 같은 이름의 `LotProgress.achievementRate` 는
⌜분모가 다르다 — 그쪽은 **이 LOT 의 `initialQty`**⌝. **두 화면(P-02-06 · W-02-08)이 「달성률」이라는
같은 말로 다른 수를 보인다** — 라벨을 가르지 않으면 현장이 어긋난 것으로 읽는다.

#### ⑩ `GET /inventory/counts/{id}` 의 `summary` — 실사 요약 4칸 (W-01-04 §5-6)

화면 명세 원문: 「계획 라인 120 │ 카운트 38 │ 미실사 82 │ 차이 발생 6」.
⌜화면이 전체 라인을 받아 세면 **페이지네이션과 어긋난다**⌝. `closable` 과
`closeBlockedReasonCode`(`COUNT_REMAINING`·`VARIANCE_UNADJUSTED`·`ALREADY_CLOSED`·`STATE_LOCKED`)를
서버가 함께 판정한다 — ⌜화면이 조건을 따로 조합하면 **화면마다 갈린다**⌝.

#### ⑪ `GET /logistics/material-issue-requests/shortage` — 소요·기출고·부족 (W-02-10 §3 ②)

화면 표의 열이 그대로 응답이다 — 「품목 / BOM 소요 / 기출고 / 부족 / 요청수량 / 비고」.
⌜`shortageQty` — 부족 = 소요 − 기출고. **음수면 0 으로 낸다**⌝ ·
⌜`issuedQty` — ⛔ 화면이 요청 건별 상세를 훑어 더하지 않는다⌝ ·
⌜자재 명세(BOM) 조회를 화면이 **따로 하지 않는다**⌝ — 즉 이 한 호출이 「BOM 소요량 불러오기」 버튼이다.

#### ⑫ `GET /logistics/document-progress` — 파생 판정 3칸 (W-01-13 §5-2)

집계는 아니지만 **서버가 판정해 내리는 파생**이라 같은 함정이다.
⌜`successorCount`·`cancellable` 을 서버가 판정해 내린다. 원천 참조가 다형이라 …
프런트가 「입고 → 출고·이동·투입」 관계표를 **하드코딩하면 유형이 늘 때마다 취소 판정이 조용히 틀린다**⌝ ·
`cancelBlockedReasonCode` 에 `TYPE_NOT_CANCELABLE` 이 있다 — ⌜취소 실행 경로가 있는 것은 **입하·입고·출고 3종뿐**⌝
인데 목록은 **9종**을 낸다. 나머지 6종은 취소 버튼이 «회색»으로 그려져야 하고, 그것을 가르는 것이 이 칸이다.
⭐ I-5 재수립 R-6 ⓐ: **`successorCount` 는 취소 불가 6종에서도 센다** — 「후속」 열은 취소 게이트가 아니라 FR-IM-086 진행현황 열이다.

#### ⑬ `GET /quality/nonconformances/{id}/disposition-decisions` 의 `summary`

⌜`summary` 가 **남은 수량**을 함께 내린다 — 화면이 대상 수량과 결정 수량을 받아 직접 빼지 않는다(L-2)⌝.
부분 처분이 성립하므로(일부 재작업 · 일부 폐기) 화면이 빼면 반올림·부분 처분에서 어긋난다.


#### ⑭ 화면 명세에만 있고 계약이 옮기지 않은 집계 규칙 — **서버가 지어내면 틀린다**

계약 응답 스키마는 «칸»을 정하지만 «세는 법»을 다 옮기지 않았다. 화면 명세를 열어 보면
계약이 한 줄로 줄여 놓은 자리에 규칙이 더 있다.

| 자리 | 화면 명세 원문 | 계약이 줄여 놓은 말 | 서버가 해야 할 것 |
|---|---|---|---|
| `DowntimeSummary` 겹친 구간 | W-05-08 §5-3 — 「**합계 시간**: ⭐ **구간을 합집합으로 병합**해 센다 — 겹친 30분을 두 번 세면 가동률이 음수로 갈 수 있다」 / 「**사유별 시간**: ⚠ **겹치면 나눌 수 없다 — 사유별 합이 총합보다 크다.** 그 사실을 표에 적는다」 / 「⛔ **겹침을 임의로 배분하지 않는다**(예: 30분을 15분씩) — **근거 없는 숫자**가 만들어진다」 | ⌜겹쳐서 한 번만 센 구간 수⌝ 한 줄 | `actualDowntimeMinutes` 는 **구간 합집합**으로 낸다. `byReason[].totalMinutes` 의 합이 그것보다 커도 **맞추지 않는다** |
| `DowntimeSummary.availabilityPercent` | W-05-08 §5-2 — 「`시간가동률 = (조업시간 − 실적비가동) ÷ 조업시간`」 · 「⚠ **이 화면의 분모는 실제 조업시간**(Σ `work_session`)이다. `W-CO-05` 는 **계획 조업시간**을 분모로 쓴다 — **다른 수가 나오는 것이 정상**」 | ⌜조업 시간이 0 이면 비어 있다⌝ | 두 오퍼레이션이 「시간가동률」이라는 같은 이름으로 **다른 식**을 쓴다. 한쪽에 맞추면 화면 하나가 틀린다 |
| `DashboardSummary.cards` | W-CO-05 §5-2 지표 표 — 양품률 = `good_qty` ÷ **수량 5종 합** · 성능가동률 = (`standard_cycle_time_sec` × 생산량) ÷ **실제 가동시간(`work_session`)** · 시간가동률 = 실제 가동시간 ÷ **계획 조업시간(`WorkCalendarDay`)** · **OEE = 양품률 × 성능가동률 × 시간가동률** | ⌜계획 조업 시간의 분모는 `mdm.WorkCalendar`…에서 구한다⌝ | 세 비율의 **분자·분모가 전부 다르다.** 하나라도 뒤섞으면 OEE 가 조용히 틀린다 |
| `DashboardSummary` 의 빈 값 | W-CO-05 §6 — 「오늘 실적이 아직 없다 → ⭐ **0 이 아니라 「아직 없음」**. ⛔ **0%로 그리면 「가동 안 함」으로 읽힌다**」 · 「`standard_cycle_time_sec` 미등록 품목 → ⚠ **성능가동률에서 제외하고 「N품목 제외」로 적는다** · ⛔ **0 으로 채우지 않는다**」 · 「교대가 진행 중 → **끝나지 않은 구간으로 나눈 비율은 낮게 나온다**」 | `valueStatusCode` · `excludedCount` · `note` 세 칸 | 세 칸이 **비어 있으면 화면이 0 을 그린다.** 서버가 반드시 채운다 |
| `DefectDistribution` 의 축 | W-03-05 §3 — 「⭐ **원천별로 갈라 보입니다** — 현장·PQC·OQC·수리·클레임」 · §5-5 — 「**발생 공정으로 묶어야** 개선 대상이 나온다」(`defect_record` 는 `occurrence_process_id`·`detection_process_id` 둘 다 NOT NULL) | `sourceCode` 필터 · `groupBy` | `groupBy=occurrenceProcess` 가 기본이고 **검출 공정으로 묶으면 다른 화면이 된다** |
| `InspectionSummary` 의 3원 분리 | W-03-05 §5-4 — 「⚠ **QA #13 의 3원(양품/불량/손실)이 여기서 갈린다.** 손실(퍼징·시작불량)은 `production.material_loss` 에 있고 **불량이 아니다** … **이 화면은 손실을 세지 않는다**」 | ⌜분모는 검사 수량이다⌝ | 손실을 불량에 더하면 두 화면의 차이가 «설명 불가»가 된다 |
| `LotStatusSummary` 의 0 금지 | W-03-01 §5-4 — 「⚠ **「0」으로 쓰지 않는다.** … **모르는 것과 없는 것을 같은 모양으로 그리면 안 된다**」 | ⌜판정 불가를 0 으로 내리지 않는다(L-8)⌝ | 4값에 없는 상태는 **칸을 빼고** 내린다 |

⚠ **계약과 화면 명세가 어긋난 자리 하나** — `GET /app/dashboard-summary` 는 ⌜⛔ **자동 갱신을
두지 않는다** — 사람이 「갱신」을 누른다⌝ 인데, W-CO-05 §5-4 는 「기준 2026-08-11 14:32 ·
**5분마다 갱신**」이라 적었다. **계약이 뒤(2026-08-30 되살림)라 계약을 따른다** — 서버는 캐시
주기를 두지 않고 부를 때 센다. §9-4 에 옮긴다.

### §7-3. 조회 슬라이스를 어떻게 자를 것인가

**규칙: 「목록 + 상세 + 라인」은 한 PR, 「집계」는 그 다음 PR.**

집계는 원천이 다 서기 전에는 **맞는 수를 낼 수 없다**(⑥ 은 U22, ⑦ 은 U24·U35·U2, ① 은 U7·U24).
목록과 같은 PR 에 넣으면 리뷰가 「이 수가 맞나」를 판정할 수 없다. 그래서 U39(검사 집계)를
독립 슬라이스로 뗐고, U35 의 `summary` 는 비가동 목록 PR 과 분리한다.

---

## §8. 오프라인 · 멱등 · ETag (관점 고유 ④)

### §8-1. 숫자

미커버 249건 중 — **`Idempotency-Key` 116건 · `If-Match` 74건 · `X-Worker-No` 41건.**
(계약의 `components/parameters/{IdempotencyKey,IfMatch,WorkerNo}` `$ref` 를 전건 해석해 셌다.)

### §8-2. 오프라인 큐가 재전송하는 오퍼레이션 — 멱등키가 «생명선»인 15건

계약이 「오프라인 대상 오퍼레이션이다 — `Idempotency-Key` 는 필수이고 **`If-Match` 는 선택**이다.
큐는 낙관적 잠금 토큰을 싣지 않는다(공유계약 `C-9`)」라고 «글자 그대로» 적은 것:

| 오퍼레이션 | 화면 | 비고 |
|---|---|---|
| `POST /production/work-sessions/{id}/events` | P-02-01 · P-02-10 | ⚠ ⌜세션이 먼저 서야 한다 — 큐에서는 **세션 열기와 묶음으로** 간다(C-10)⌝ |
| `POST /production/work-sessions/{id}:end` | P-02-01 | ⌜**큐에서 가장 먼저 보낸다**(C-16)⌝ |
| `POST /production/work-sessions/{id}/workers` · `.../{wid}:leave` | P-02-01 | |
| `POST /production/production-results` | P-02-04 | 다섯 수량을 그대로 받는다 |
| `POST /production/material-consumptions` | P-02-03 | 계보(`lot_relation`)가 같은 트랜잭션 |
| `POST /production/material-returns` | (화면 미매핑 — §9-2) | |
| `POST /production/work-orders/{id}:hold` · `:resume` | P-02-10 | |
| `POST /trace/serial-numbers` | P-02-05 | ⛔ 부분 발번 없음 — 하나라도 실패하면 전량 되돌린다 |
| `POST /quality/inspection-results` | P-02-13 | ⭐ ⌜**오프라인 큐는 언제나 확정으로 온다** — 임시 저장은 단말에 남는다⌝ |
| `POST /logistics/recycle-entries` | M-01-12 | ⭐ LOT 번호를 **서버가 매긴다**(C-2) — 「번호는 저장 후 정해집니다」 |
| `POST /trace/lots/{id}:complete` | P-02-06 | |
| `POST /inventory/handling-units/{id}:pack` · `PUT .../contents` | P-02-08 · M-04-03 | |

⛔ **여기에 얹혀 있는 공통 문장 하나** — ⌜오프라인일 때는 이 오퍼레이션이 **호출되지 않는다** —
셸의 outbox 가 들고 있다가 연결되면 그때 보낸다. **그래서 서버 응답은 온라인일 때의 것 하나뿐이다.**
미확정 표식은 셸이 붙인다(`C-7`)⌝. 즉 **서버가 「큐 접수 202」를 만들면 안 된다.** 계약이
`POST /production/work-sessions` 에서 그것을 정정 이력까지 달아 못박았다 —
⌜⛔ 큐 접수 202 를 두지 않는다 — 오프라인이면 HTTP 요청 자체가 일어나지 않아 서버가 202 를 보낼
자리가 없다(2026-08-12 정정 · `omf-mes-client#97`)⌝.

### §8-3. 「오프라인이 아닌데 멱등키가 필수」인 것 — 이유가 다르다

같은 `Idempotency-Key` 필수라도 **왜 필수인지가 다르고, 그것이 `If-Match` 의 선택 여부를 가른다.**

| 오퍼레이션 | 오프라인? | `If-Match` | 계약이 밝힌 이유 |
|---|---|---|---|
| `POST /production/work-sessions` | ⛔ 아님 | 선택 | ⌜**신규 생성이라 대조할 `version_no` 가 아직 없다**(`C-9` 의 큐 조항과는 **무관하다**)⌝ |
| `POST /production/operation-handovers` | ⛔ 아님(M-02-01 온라인 전용) | 선택 | ⌜재시도 중복을 막기 위해서다(`C-8`)⌝ · ⌜신규 생성이라 대조할 `version_no` 가 아직 없다⌝ |
| `POST /logistics/material-issue-requests` | ⛔ 아님(W-02-10 관리웹) | 선택 | ⌜관리웹 셸에는 **오프라인이 없다**(`C-5`)⌝ |
| `POST /production/precheck-decisions` | ⛔ 아님 | 없음 | ⌜이 화면은 **온라인에서만 판정한다**(P-02-02 §6-1)⌝ |
| `POST /production/repair-executions` | ⛔ 아님 | 없음 | ⌜이 화면은 온라인 전용이다(M-02-02 §5-6)⌝ |
| `POST /logistics/shipment-requests/{id}/lines/{lid}:pick` | ⛔ 아님 | 없음 | ⌜**Release 판정값을 캐시할 수 없어** 이 화면은 온라인에서만 돈다(`C-6` · M-04-01 §5-6)⌝ |
| `POST /app/notification-subscriptions/recipients:preview` | — | 없음 | ⌜아무것도 저장하지 않지만 POST 라 전 쓰기 규약대로 받는다 — **같은 키로 다시 보내면 같은 전개 결과를 돌려준다**⌝ |

⚠ **서버가 이 넷을 구별하지 않고 「POST 면 멱등키」로 일괄 처리하면** `recipients:preview` 같은
읽기성 POST 가 «저장된 응답»을 되돌려줘야 한다는 요구를 놓친다.

### §8-4. `X-Worker-No` — 41건. 감사 컬럼이 아니라 «주체»다

계약이 `GET /app/approval-requests` 에서 규칙을 세웠다 —
⌜부르는 셸이 «둘»이다 … **관리웹은 계정 토큰에서 서버가 풀고, 현장 단말·모바일은 계정 세션이
없어 `X-Worker-No` 헤더로 주체를 싣는다**(`D-5`·`F-2`). ⛔ **단말 토큰으로 풀지 않는다** — 한
단말을 여러 작업자가 «교대로» 쓰므로 남이 올린 요청이 섞인다⌝.

⚠ **우리 쪽 `§Y-5` 가 「현장 셸의 `X-Worker-No` 를 주체로 쓸 수 없다 — 단말 토큰이 없어서다」로
남아 있다.** 이 자리가 열린 채로 U1 을 만들면 **M-01-13 의 「내가 올린 요청」 구획이 빈다.**
§1-3 의 초안 판정(사번 없으면 400)을 U1 에서 흔적으로 남긴다.

### §8-5. `If-Match` — **토큰의 출처를 화면이 어디서 얻는가**

이것이 이 절에서 가장 잘 틀리는 자리다. 계약이 **일곱 자리**에 같은 문장을 붙였다 —
⌜⭐ 이 경로의 조회는 **ETag 를 내리지 않는다** — `If-Match` 에 담을 토큰은 부모 자원
`GET …/{id}` 200 의 ETag 다. **잠그는 단위가 부모이기 때문이다**(`B-1-1`)⌝.

| 편집 오퍼레이션 | 토큰을 내려주는 GET | 슬라이스 |
|---|---|---|
| `PUT /logistics/purchase-orders/{id}/lines` | `GET /logistics/purchase-orders/{id}` | U4 |
| `PUT /logistics/inbound-receipts/{id}/lines` | `GET /logistics/inbound-receipts/{id}` | U5 |
| `PUT /logistics/goods-issues/{id}/lines` | `GET /logistics/goods-issues/{id}` | U12 |
| `PUT /logistics/stock-transfers/{id}/lines` | `GET /logistics/stock-transfers/{id}` | U14 |
| `PUT /inventory/adjustments/{id}/lines` | `GET /inventory/adjustments/{id}` | U17 |
| `PUT /inventory/handling-units/{id}/contents` | `GET /inventory/handling-units/{id}` | U27 |
| `PUT /trace/lots/{lotId}/external-identifiers` | `GET /trace/lots/{lotId}` (이미 구현) | U6 |
| `PUT /app/approval-routes/{id}/steps` | `GET /app/approval-routes/{id}` — ⌜`approval_route_step` 에는 `version_no` 가 **없으므로**⌝ | U1 |
| `POST /quality/nonconformances/{id}/disposition-decisions` | `GET /quality/nonconformances/{id}` — ⌜잠그는 대상이 처분 결정 한 건이 아니라 **부적합**이기 때문⌝ | U28 |
| `POST /maintenance/results`(`resetCounter=true`) | ⌜**대상 툴의 상세 조회** 200 이 내려주는 ETag⌝ | U34 |
| `POST /logistics/document-progress/{type}/{id}:request-cancel`·`:cancel` | ⌜이 응답이 아니라 **대상 문서 리소스의 상세 GET**(`/inbound-receipts/{id}` · `/goods-receipts/{id}` · `/goods-issues/{id}`)⌝ | U18 |

⚠ **물리에 `version_no` 가 없는데 `If-Match` 를 요구하는 자리 셋**(I33 정정):
`lot_hold`(U8 `:release`) · `equipment_downtime`(U35 `PUT`·`:close`) ·
`maintenance_result`(U34 `PUT`). 검교정 U37은토큰미선언·cal version새칸0이며8필드물리보완과다른책임이다.
**전부 마이그레이션 선행 커밋**이 필요하다.

### §8-6. 「사후 입력 시간 임계값을 두지 않는다」

`계약-재검토-2026-09-04` §3 — `LATE_ENTRY_ALLOWED_HOURS` 예시가 철회됐다(2026-08-31 확정).
오프라인 큐가 며칠 뒤에 올라와도 **시간으로 거절하지 않는다.** 그 대신 막는 것은
`Idempotency-Key` 와 상태기계뿐이다 — U22 · U24 의 e2e 에 「3일 지난 큐를 재전송해도 통과」를
한 줄 넣어 못박는다.

---

## §9. 화면과 계약이 어긋난 자리 (관점 고유 ⑤ · 설계 문의 후보)

### §9-1. 화면이 요구하는데 계약에 오퍼레이션이 없다

| # | 화면 | 화면이 요구하는 것 | 계약 상태 | 이 계획에서의 처리 |
|---:|---|---|---|---|
| A | **M-01-10** 재고이동·불량반출 | **창고 «안»의 위치 이동**·파렛트 재편성을 담을 업무 문서 헤더 | `stock_transfer` 는 창고 간(from ≠ to)만 받는다. 화면 §8 원문 — 「이동 자체는 기록되나 **「이동 건」이라는 업무 문서가 없다**」 | U14 는 창고 간만 만든다. 위치 이동은 U10(적치)로 흡수하고 **요청서 후보** |
| B | **M-01-12** 재생재 등록 | 재생재 «신규 품목» 행을 만드는 경로 | `/mdm/items` 는 **GET 뿐**이다(W-06-05 가 「품목 추가는 없다 — ERP 정본 수신본」). 화면 §8 이 2026-09-02 재확인에도 **열려 있다**고 적음 | `POST /logistics/recycle-entries` 는 «등록된 품목만» 받는다. **요청서 후보** |
| C | **M-01-06** 입하 오류 등록 | 미등록 품목이 도착했을 때 입하 라인을 만드는 길 | 품목 생성 오퍼레이션 0건 (B 와 같은 뿌리) | 400 으로 거부. **요청서 후보(B 와 묶어서)** |
| D | **M-02-01** WIP 공정이동 스캔 | 인계의 «수령» 쪽 — `received_at`·`received_qty` 를 채울 오퍼레이션·화면 | `POST /production/operation-handovers` 는 ⌜인계와 인수를 **한 번에** 확정한다 — 화면의 버튼이 하나다⌝ 로 «인계 시점에 수령까지» 적는다. 별도 수령 스캔은 없다 | 계약대로 한 번에 확정. **화면 §8 의 「수령 스캔 부재」는 계약이 이미 답한 것으로 읽는다**(추측 아님 — 계약 원문) |
| E | **P-02-03** 자재 투입 스캔 | 투입 정정(`:correct`) | 실적에는 `:correct` 가 있는데 **투입에는 없다** | 만들 수 없다. **055 로 발행**(I-10 재수립 R-13) |
| F | **P-02-08** 포장 작업 | 포장 «해체»(되돌리기) | 계약에 없음 | 만들 수 없다. **요청서 후보** (화면 §8 기반 — 추측 아님) |
| G | **W-01-06** 폐기 요청·기타출고 | 승인 후 «미출고 품의»를 촉구할 수단 | 목록 필터로 대신할 수 있다 — `GET /logistics/goods-issues?statusCode=` + `GET /app/approval-requests?targetTypeCode=GOODS_ISSUE` | 새 오퍼레이션 없이 화면이 조합한다. 요청서 불필요 |
| H | **M-01-07** 임시 위치 적재 | 정위치 이동을 «촉구»할 화면 | `omf-mes#78` 로 **범위 밖 확정** | 처리 없음 |
| I | **W-04-12** 출하 확정 취소 | `shipment.confirmed_at`·`confirmed_by` | 물리에 없다(실측 — `cancelled_*` 3칸은 있는데 확정 쪽만 없다) | U31 에서 nullable 2칸 마이그레이션 |
| J | **P-01-01** 자재 LOT 라벨 | 이전 라벨 «무효화» 규칙 | 계약에 없다 — `document_issue_log` 는 회차만 올린다 | 회차만 올린다(계약대로). **요청서 후보** |
| K | **M-01-09** 생산창고 입고 | 출고·입고 «두 화면이 한 단말»로 합쳐지는 오프라인 시나리오 | ~~공유계약 §C 가 다루지 않는다~~ → **C-10 이 다룬다**(v0.7 「큐에 순서 의존이 있으면 묶음으로 거부」 · 출처 각주가 `M-01-09` §5-1) — 화면 §8 문장이 v0.1 시점이라 낡았다 | U12·U13 을 같은 순서 구간에 둔다. ~~요청서 후보~~ **해소**(I-9 R-2 · 서버 잔여 0) |

### §9-2. 계약에 있는데 부르는 화면이 없다 — **계약이 스스로 적었다**

| 오퍼레이션 | 계약 원문 | 이 계획에서의 처리 |
|---|---|---|
| `POST /planning/production-orders/{id}:resync` | ⌜⚠ **이 오퍼레이션을 호출하는 화면은 현재 없다** — 재동기 실행 소관은 연계 동기화 현황 화면이 단독으로 갖는다⌝ | U19 에 넣어 구현한다(202 만 낸다). 실행 화면은 W-06-10 이고 그 화면의 다른 오퍼레이션은 이미 구현됨 |
| `POST /production/material-returns` | ⌜⚠ 2026-08-26 — 근거였던 M-02-02(수리 왕복)가 이 경로를 쓰지 않는 것으로 정정됐다 … **부르는 화면이 아직 매핑되지 않았다** — 소유 화면이 정해지면 근거를 다시 적는다⌝ | U23 에 넣어 구현한다. **050 으로 발행**(I-10 재수립 R-13) — 권한은 `P-02-03` 임시 등록(`manual-permissions.ts` 선례 넷째 · R-10) |
| `POST /production/repair-executions/{id}:return` 뒤의 «재투입» | ⌜⭐ 재투입은 이 화면이 하지 않는다 … 그 등록은 P-02-03·P-02-04 가 후보다 — **아직 정해지지 않았다**(M-02-02 §5-4·§8-3)⌝ | U26 은 왕복만 닫는다. **요청서 후보** |
| `GET /maintenance/collection-channels/observations` | 미등록key수용T신설·구관측FK와구별,수집자원천/운영정책미완 | U38 R6/118: T실제값조회·두술어·무페이지,수집자/UI인수별도·영구빈stub0 |
| `GET /production/work-sessions`(목록) · `POST .../workers` · `.../{wid}:leave` | 화면 근거가 `공유계약 G-16` 뿐이거나 아예 없다 | U22 에 넣어 구현. P-02-01 §5 가 「세션 작업자 목록」을 그리므로 짝으로 필요하다(추측 아님 — 형제 GET 이 `P-02-01` 을 들고 있다) |
| `GET /app/attachments` | 목록만 살고 **올리기·내려받기가 건너뜀**(§3) | 화면 W-CO-04·W-CO-08 이 반쯤 열린다 |

### §9-3. 계약 안에서 서로 어긋난 자리 — 화면 쪽에서 보이는 것

| 자리 | 어긋남 | 판정 |
|---|---|---|
| `screenId` 3자리 | `ApprovalTarget`·`DocumentTarget`·`DocumentProgress`(+ `Notification`)가 **화면 식별자**를 요구하는데, 대응표는 저장소 어디에도 없다 | 계약이 물러난 길을 이미 적었다 — **키를 생략한다.** 널 금지 |
| `Lot.progress`(`LotProgress`) vs `WorkOrderProgress` | 같은 이름 `achievementRate` 의 **분모가 다르다**(LOT `initialQty` vs W/O `orderQty`) | 계약이 ⚠ 로 표시해 두었다. **화면 라벨을 가르는 것은 설계 몫** — 요청서에 적는다 |
| `InspectionSummary.defectRate` vs W-02-08 수율 | ⌜다른 수가 나오는 것이 정상이다⌝ | 배포 노트에 적는다 |
| `GET /quality/lot-hold-events` vs `GET /trace/lot-status-events` | 후자가 ⌜기존 `GET /quality/lot-hold-events`(보류 등록·해제 2종만)를 **대체하는 상위 자원**⌝ 인데 **둘 다 계약에 살아 있다** | 둘 다 만든다(U8). ⚠ W-03-01 이 어느 쪽을 부르는지 화면 명세가 갈라 적지 않았다 — **요청서 후보** |
| `M-01-08` 의 정면 충돌 | 화면 명세 머리에 적혀 있다 — 「**결정 10 의 「Hold 차단 판정은 캐시 없음」과 C-1 의 오프라인 허용이 정면으로 부딪친다.** 규칙 둘 다 확정인데 한 화면에서 동시에 지킬 수 없다」 | 서버는 **판정 단일 지점**을 지킨다(결정 10). 오프라인 허용 여부는 셸 몫이고 우리가 정할 자리가 아니다. **요청서에 이미 열린 것으로 인용** |

### §9-4. 05 설비 · 03 품질 · 공통에서 더 나온 것

| # | 자리 | 무엇 | 처리 |
|---:|---|---|---|
| L | **W-03-01** 품질 판정 축이 문서 안에서 갈린다 | §5-4 는 요약 카드가 「**LOT 상태 4값 전건**」을 센다 하고, 같은 문서 §8 #4 는 「⚠ **축이 다르다** — 품질 판정은 `inventory_balance.quality_status_code`(4값 확정)이고 `lot.status_code` 는 **수명주기 축**이다(#46 「폐번」)」라 적었다 | 우리 `docs/server-architecture.md` §5 열린 것 #1 이 **이미 같은 어긋남을 「회신 대상」으로 열어 두었다**(결정 08 부분 철회 · `omf-mes#115` 재판정 중). U8 은 계약의 `LotStatusSummary` 가 요구하는 대로 **`statusCode × lotTypeCode`** 로 내되, 어느 컬럼을 세는지는 §2 절차 0단계(계약 본문)로 가른다 — 계약이 ⌜값 목록은 `LOT_STATUS`⌝ 라 적었으므로 **`trace.lot.status_code`** 를 센다. 3단계 흔적으로 e2e 에 `// 설계 미정 — 축 재판정 중` 을 남긴다 |
| M | 승인 유형 9값에 **「특채」가 없다**(W-03-09) | `app-공통` 의 승인 유형이 8 → 9값(`PRODUCTION_RESULT_CORRECT` 추가)인데 특채(Concession) 유형이 없다. W-03-09 는 결재함(`GET /app/approval-requests`)으로 특채를 찾고 `GET /quality/concessions?approvalRequestId=` 로 조건을 붙인다 | 계약이 이미 그 길을 적었다 — ⌜목록 자체는 승인 계약이 낸다⌝. 새 유형을 지어내지 않는다. **요청서 후보** |
| N | 처분 전이 코드가 `transitionCode` 9종에 없다(W-03-10) | `POST .../disposition-decisions` 가 ⌜재작업 → `INSPECTION_PENDING` · 폐기 → `SCRAPPED` · 정상 → `NORMAL`⌝ 로 LOT 상태를 옮기는데, `GET /trace/lot-status-events` 의 전이 9종(C4~C15)에 처분 전이가 이름으로 없다 | 전이 코드를 지어내지 않는다. **요청서 후보** |
| O | 보전 유형이 스펙 3값 vs 계약 2값(W-05-05 · W-05-02) | 화면 스펙은 사후·예방·**예지** 셋, 계약은 ⌜보전 유형은 보내지 않는다 — **트리거 조합이 정한다**(고장이 하나라도 섞이면 사후다)⌝ 로 둘만 가른다 | 계약대로 트리거 조합으로 도출. 예지는 만들지 않는다 |
| P | `attachment.target_type_code` 에 고장 기록 유형이 필요(M-05-02) | 첨부 자체가 **건너뜀**(§3)이라 지금은 드러나지 않는다 | 첨부를 열 때 함께 |
| Q | 값 목록이 아직 없는 코드 5건 | 설비 고장 **원인 코드**(W-05-04) · 검교정 **결과 코드**(W-05-10) · **알림 이벤트 코드 문자열 자체**(W-CO-03) · 역할 값 목록(W-CO-11 · E-9 대기) · 기능 권한 값 목록(W-03-01 · E-9 대기) | `F-6` 「판정할 수 없음을 통과로 처리하지 않는다」 — 코드 검증이 필요한 자리는 **막고**, 검증이 필요 없는 자리(자유 입력)는 그대로 받는다. `LOT_HOLD_REASON` 6값은 2026-09-03 코드 사전에 등재돼 **이미 풀렸다** |
| R | 05 도메인의 오프라인 대상은 **26화면 중 4개뿐** | M-05-01 · M-05-02 · P-05-01 · P-05-02. 나머지는 전부 관리웹 온라인 전용(`C-5`) | U33·U35·U36 의 POP·모바일 쓰기 4건에만 오프라인 규약을 적용한다 |
| S | `GET /app/dashboard-summary` 의 갱신 주기 | 계약 ⌜⛔ 자동 갱신을 두지 않는다⌝ vs W-CO-05 §5-4 「5분마다 갱신」 | 계약이 뒤라 계약을 따른다(§7-2 ⑭). 서버에 캐시 주기를 두지 않는다 |
| T | 적체 화면의 요약값에 대응 오퍼레이션이 없다 | W-05-02(초과·임박·미등록 건수) · W-05-04(경과 일수) · W-05-10(만료·임박 건수) — 화면이 숫자를 보이는데 집계 오퍼레이션이 계약에 없다 **(추측 — 화면 명세 §3 의 표시 항목과 계약 목록을 대조한 결과)** | 목록 오퍼레이션의 필터로 화면이 센다(`dueBefore` · `openOnly` · `withoutMaintenanceOrder`). 새 집계를 만들지 않는다 |

---

## 부록 A. 이 계획서가 실제로 연 파일

- 계약 7벌 전건 파싱 — `contracts/*.json`(`a6a87e1`) · 오퍼레이션 487건 · `$ref` 해석 포함
- 물리 모델 전건 대조 — `prisma/schema.prisma` 181 모델 · `version_no`/`status_code`/취소 흔적/새 표 필요 여부
- 저장소 문서 — `CLAUDE.md` · `docs/coverage-100/README.md` · `docs/server-architecture.md` ·
  `docs/development-strategy.md` · `docs/기존-구현-도메인-규칙.md` · `docs/계약-재검토-2026-09-04.md` ·
  `docs/계약-되돌림-mdm.md` §Z-1 ~ §Z-11
- 설계 저장소 화면 명세 **82건**(131건 중) — `01/` 19 · `02/` `04/` 34 · `03/` `05/` `공통/` `06/` 27 ·
  직접 정독 2(`M-01-08` · `W-01-01`) + 집계 3화면 정독(`W-03-05` §3·§5-4·§5-5·§5-8 ·
  `W-05-08` §5-2·§5-3 · `W-CO-05` §5-2·§5-4·§6 · `W-03-01` §5-4·§8)

## 부록 B. 대조 스크립트가 보장하는 것

- 249건 = 43 슬라이스(244) + 건너뜀(5). **중복 0 · 누락 0 · 미커버 목록 밖 0.**
- 화면 식별자 추출은 `[WMP]-(\d\d|CO)-\d\d` 정규식으로 오퍼레이션 객체 전체(요약·설명·`x-*`)를 훑었다.
- 헤더(`Idempotency-Key`·`If-Match`·`X-Worker-No`)는 `components/parameters` `$ref` 를 해석해 셌다.
