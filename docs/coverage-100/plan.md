# 커버리지 100 — 통합 계획서 (정본)

3관점 계획서(`plan-api.md` · `plan-uiux.md` · `plan-integration.md`)를 대조해 하나로 세운 정본이다.
규칙은 `README.md`, 오퍼레이션 배정은 `assignment.tsv`(249행, 기계 대조 249/249)가 진다.
슬라이스를 시작할 때는 이 문서 §1·§3·§4 와 `plan-integration.md` §3-1 의 해당 슬라이스 상세를 읽고
개별 계획안 1개를 세워 대조한다(README §1-2).

## 0. 세 관점이 부딪힌 자리와 판정

| # | 자리 | API | UI/UX | 통합 | **판정** | 근거 |
|---|---|---|---|---|---|---|
| 1 | 슬라이스 단위 | 자원 축 25 | 화면 축 43 | 전표 체인 축 35 | **통합 35 를 뼈대로**. 화면 축의 「반쯤 열리는 화면」(M-01-08 등)은 배포 노트로 옮긴다 | 서버 순서는 코어 재작업 비용이 가른다. 화면 완결성은 클라이언트 롤아웃 문제 |
| 2 | 승인 코어 위치 | 1번 | 1번 | 1번 | **I-1 맨 앞** | 셋이 일치 |
| 3 | 채번 코어 | `core/numbering` 신설, 규칙 없으면 기본 패턴 | — | I-2 에서 승격 + 입고 두 함수 이관 | **I-2 안의 코어 전용 PR(≤200줄)**: `numbering_rule`·`numbering_counter` 를 읽고, 미등재 유형은 `{PREFIX}-{YYYYMMDD}-{SEQ4}` 기본값. 같은 PR 에서 `GR-`·`PT-`·**`NTC-` 세 자리**를 코어로 옮긴다(사용처 3 확보 + `count()+1` 결함 제거 · `NTC-` 는 통합 §7 대기 10 이 「채번 코어가 이 자리를 흡수한다」라 적었다 — I-2 재수립 R-2) | API §5.5 ①②③ · 통합 §2 · 아키텍처 C-6 예고 |
| 4 | 적치(I-12) 순서 | 4번으로 당김 | 9번 | M5, 단 I-3 과 병렬 가능 | **I-3 뒤 4번째** — 문의 017 권고안이 이미 있고 입고가 만든 미완 자원을 닫는다. sonnet 로 I-3 과 병렬 | API §2 ⚠ · 통합 §6-2 |
| 5 | 다형 취소(I-5) 순서 | 5번 | 31번(전 유형이 선 뒤) | I-3·I-4 직후 | **I-4 직후 6번째** — 코어라 늦을수록 재작업(I-13·I-14·I-23). 화면 W-01-13 이 늦게 온전해지는 것은 배포 노트 | 통합 §2 「가장 비싼 되돌림」 |
| 6 | 검사(I-19) 시점 | M3 | 6번(입하 LOT 이 검사 대기라 막힌다) | M3 | **M3 유지** — 「판정은 IQC, 전이는 입고 확정」(3차 문의 ②)이라 입고가 이미 전이를 진다. M1 체인은 기존 입고 e2e 픽스처를 쓴다 | 3차 문의 ② |
| 7 | 건너뜀 5번째 `GET /app/printers` | 구현(칸 5개 추가) | 건너뜀(상태 칸 없음 → 지어냄) | 구현 | **구현(I-27)** — 계약 `Printer.status` 가 required·enum 4값이고 물리에 칸이 없다 → 「물리가 계약을 따른다」. `status_code NOT NULL DEFAULT 'OFFLINE'`: 보고하는 장치가 없는 프린터는 서버 관점에서 오프라인이 «사실»이라 F-6 에 안 걸린다. 상태를 올리는 오퍼레이션이 계약에 없다 → 문의 후보 | 계약 실측(2026-09-06) |
| 8 | 마이그레이션 수 | 22항목(앵커 실측) | 12 + 새 표 3 + `version_no` 4 | 7 | **API 표 A 를 목록 정본으로**(앵커에서 긁은 것) + 통합 7건(완화·인덱스) + UI/UX 의 `shipment.confirmed_*`·`version_no` 4표 → §4. 전부 추가·완화, 삭제 0 | 근거가 계약 문자인 것을 택함 |
| 9 | 새 표 3(UI/UX) | — | `work_order_resource_plan` · `handling_unit_repack_event` · `collection_channel_observation` | 기존 표 재사용(`work_order_resource_assignment` 인덱스 · `handling_unit_reconfiguration`) | **기존 표 우선**. `collection_channel_observation` 만 신설(계약 스키마가 실재하고 물리가 없다 — 「물리가 계약을 따른다」). 나머지 둘은 슬라이스 계획에서 기존 표로 안 되면 **3관점 재수립** 조건에 걸린다 | README §1-2 |
| 10 | `x-no-code-key` 16자리 `status_code` NOT NULL | 상수 하나 | — | — | **NOT NULL 해제(nullable)** — §2 2단계 ③ 이 「nullable」을 우선으로 적었다. 상수는 데이터에 남아 되돌리기 비싸다. 그 표를 처음 쓰는 슬라이스의 선행 마이그레이션에 싣는다 | README §2 2-3 |
| 11 | LOT 품질 축 전이 | 계약이 이름 적은 9줄만 등록, 나머지는 던짐 | 처분 전이 코드 없음 → 문의 | I-19 가 전이표를 채우고 뒤가 재사용 | **I-19 에서 계약이 이름 적은 전이만 등록**. 처분(I-21)은 계약 문장(재작업→`INSPECTION_PENDING` 등)대로 옮기되 `transitionCode` 는 지어내지 않고 문의(§7) | API §6-3 · UI/UX §9-4 N |
| 12 | 알림 구독 축 | 새 표 `notification_subscription_recipient` | recipient 규칙 마이그 | — | **새 표** — 계약(이벤트별 수신자)이 물리(사용자별)와 반대 | API 위험 7 |
| 13 | I-9 생산창고 차이 | — | — | 기록만(뒤집히면 3관점 재수립) | **기록만** | 통합 §9-6 |
| 14 | 출하의 원장 | — | — | `posting.post()` 직접, `GoodsIssueService` 안 부름 | 그대로 | 아키텍처 §1 |

## 1. 슬라이스 35 — 순서·선행·배분

순서는 통합 §4(M1 최단 → M2~M5), 병렬 레인은 통합 §6-2. **모델**: 코어/복합 = opus, 조회·복제 = sonnet (README §4).
**PR** 열은 예상(마이그레이션 선행 커밋은 같은 PR 안 별도 커밋).

| 순 | 슬라이스 | 건 | 선행 | 마이그(§4) | 코어 | 모델 | PR | 병렬 레인 |
|---:|---|--:|---|---|---|---|--:|---|
| 1 | **I-1** 승인 코어 — 결재선·결재함 | 12 | — | A6 | 승인(`src/core/approval/`) · `omitEmpty` 헬퍼 | opus(코어·결재) · sonnet(CRUD·조회) | 4 | ∥ I-30 |
| 2 | **I-2** P/O + 채번 코어 + 승인 상신 코어 | 7 | I-1 | A1·A2·M-b | 채번 · 승인 `request`/`assertNoOpenRequest`(별도 코어 PR) — `assertApproved` 는 **I-4 로 이관**(첫 사용처가 `goods-issues:post` · I-2 재수립 R-9) | opus(코어 2 · 마이그) · sonnet(P/O 조회·CRUD) | 5 | ∥ I-30/I-32 |
| 3 | **I-3** 입하 | 12 | I-2 | A3 | — | sonnet(조회) · opus(차이·초과분리) | 3 | ∥ I-12 |
| 4 | **I-12** 적치 완료·임시적재 | 4 | 입고(구현됨) | — | — | opus(원장 STOCK_TRANSFER) | 2 | ∥ I-3 |
| 5 | **I-4** 출고 — 전표·전기 | 7 | I-3 | M-c | — | opus | 3 | — |
| 6 | **I-5** 다형 취소 + 역트랜잭션 코어 | 4 | I-3·I-4 | — | `posting.reverse()` | opus | 3 | — |
| 7 | **I-6** W/O + 4M 배정 | 13 | I-2 | M-d | ERP 아웃박스(첫 사용처) · 생명주기 전이 | opus | 4 | — |
| 8 | **I-7** 생산 실적 + LOT 생명주기 L1 | 7 | I-6 | D1 | — | opus | 3 | — |
| — | **M1 체인 e2e** (통합 §4-1) | | I-7 | | | fable 통합 | 1 | |
| 9 | **I-8** 출고요청·피킹·예약 코어 | 8 | I-4 | — | `reserved_qty`/`picked_qty` | opus | 3 | ⛔ I-5 와 직렬 |
| 10 | **I-9** 생산창고 입고 | 3 | I-8 | — | — | sonnet | 2 | — |
| 11 | **I-10** 자재 투입·반출 + 계보 | 6 | I-9·I-7 | — | — | opus | 3 | ∥ I-11 |
| 12 | **I-11** 작업 세션·작업전점검 | 11 | I-6 | — | — | sonnet | 3 | ∥ I-13 |
| 13 | **I-24** 생산 계획·생산오더 | 10 | I-6 | A11 | — | opus(전개 `:confirm`) · sonnet(조회) | 3 | — |
| 14 | **I-25** 공정 인계·수리 왕복 | 6 | I-7 | — | — | sonnet | 2 | — |
| — | **M2 체인 e2e** | | | | | fable | 1 | |
| 15 | **I-19** 검사 — 의뢰·결과·측정·확정 | 11 | I-7 | M-e | 품질 축 전이표 | opus | 4 | — |
| 16 | **I-20** LOT 상태·보류 | 10 | I-19 | A12 · V-lot_hold | — | opus | 3 | — |
| 17 | **I-21** 부적합·처분·특채 | 11 | I-20 | — | — | opus | 3 | — |
| 18 | **I-18** LOT 부가·상태 이력·IQC 생략 | 5 | I-1 | — | — | sonnet | 2 | ∥ I-19 |
| — | **M3 체인 e2e** | | | | | fable | 1 | |
| 19 | **I-22** 출하지시·작업지시·제품 피킹 | 9 | I-8 | A13 | — | opus | 3 | — |
| 20 | **I-23** 출하·확정·취소 + 재등록 | 7 | I-22·I-5 | A14 · U-I(`confirmed_*`) | ERP 아웃박스 둘째 | opus | 4 | ⛔ I-4 와 직렬(이미 끝) |
| — | **M4 체인 e2e** | | | | | fable | 1 | |
| 21 | **I-13** 재고 이동 2단 | 6 | I-5 | A4 | — | opus | 3 | ∥ I-11 |
| 22 | **I-14** 재고 조정 | 7 | I-1·I-5 | — | — | opus | 3 | — |
| 23 | **I-15** 실사 | 6 | I-14 | — | — | sonnet | 3 | — |
| 24 | **I-16** 취급 단위·포장·재구성 | 7 | I-12 | — | — | opus | 3 | ∥ I-33 |
| 25 | **I-17** 재생재 등록 | 1 | I-3 | A5 | — | sonnet | 1 | — |
| 26 | **I-26** 제품 개체 발번 | 2 | I-7 | — | — | sonnet | 1 | — |
| 27 | **I-27** 발행 이력·프린터 | 7 | I-26 | A9·A10 | — | sonnet | 2 | ∥ I-28 |
| 28 | **I-28** 알림 | 8 | I-1 | A7·A8 | — | sonnet | 2 | ∥ I-27 |
| 29 | **I-30** 설비 점검·고장 | 9 | — | A15 | — | sonnet | 3 | ∥ I-1 (앞당김) |
| 30 | **I-31** 보전 지시·실적 | 8 | I-30 | A16·A17·A18·A19 · V-maintenance_result | — | opus(마이그 최대) | 3 | — |
| 31 | **I-32** 비가동 | 6 | I-11 | V-equipment_downtime | — | sonnet | 2 | ∥ I-2 |
| 32 | **I-33** 툴 사용·계측기·수집 채널 | 12 | I-31 | A20·A21·A22·M-g · V-equipment_calibration · T-observation | — | sonnet | 3 | ∥ I-16 |
| 33 | **I-34** 첨부(목록만) | 4 | — | — | — | sonnet | 1 | 3건 건너뜀 |
| 34 | **I-35** 변경 이력·예비품 엑셀 | 2 | — | audit jsonb 규약 | — | sonnet | 2 | — |
| 35 | **I-29** 통합 대시보드 | 1 | 전부 | — | — | opus(집계) | 1 | 맨 끝 |
| | **합계** | **249** | | | | | **~92** | |

⚠ 병렬 레인은 «허용»이지 «강제»가 아니다 — 게이트(`test:e2e`)는 한 번에 하나만 돌린다(간헐 실패 증거 #15).
병렬로 돌린 슬라이스는 앞 PR 병합 뒤 재베이스해서 게이트를 다시 탄다.

## 2. 마일스톤 완료 조건

| M | 슬라이스 | 체인 e2e (끝점 셋만 단언 — 통합 §5-3) |
|---|---|---|
| **M1** | I-1 → I-2 → I-3 (∥ I-12) → I-4 → I-5 → I-6 → I-7 (UI/UX U1 의 「상신 → 결재함 승인 → 전기」 한 줄 e2e 는 I-4 완료 시점에 선다 — I-1 은 원장 0건까지) | P/O 승인 → 입하 → 입고(기존) → 기타출고(`GOODS_RECEIPT` source, 피킹 없이) → W/O 발행·확정배포(선발행) → 실적(L1) → 제품 입고(기존) → balance 3행 → 입고 취소 요청·승인·실행 → 역트랜잭션 → balance 원복 |
| **M2** | I-8 → I-9 → I-10 ∥ I-11 → I-24 → I-25 | 계획 `:confirm` → W/O `:release`(출고요청 자동) → 피킹 → 출고 → 생산창고 입고 → 투입 → 세션 → 실적 → W/O `:cancel` 로 선발행 전건 폐번 |
| **M3** | I-19 → I-20 → I-21 ∥ I-18 | 실적 → 검사 의뢰 → 확정(전이) → 불합격 → 보류 → 부적합 → 처분 SCRAP → 폐기 출고(I-4 재사용) 원장 감소 |
| **M4** | I-22 → I-23 | 출하작업지시 → 제품 피킹 → 출하 처리(원장 out) → 확정(아웃박스 행) / 미확정 취소 → 역트랜잭션 · 반품 → 처분 NORMAL → 재등록 |
| **M5** | 나머지 (I-29 맨 끝) | 슬라이스 e2e 3건씩 |

⚠ `development-strategy.md` 에서 벗어난 자리: ① 승인(M5)을 맨 앞으로 ② M1 「불출」을 기타출고로 먼저 닫고
정식 경로(I-8)는 M2 ③ 적치를 I-3 과 병렬로 앞당김. 근거는 §0 #2·#4 와 통합 §4-1.

## 3. 공유 코어 — 만드는 시점 (통합 §2 그대로)

| 코어 | 시점 | 형태 |
|---|---|---|
| 승인 워크플로 | I-1 코어 PR ≤200줄 | **`src/core/approval/`**(도메인 간 service 호출 금지 — 9 상신자가 7 도메인) — `selectRoute`·`expandSteps`·`currentStep`·`approve`·`reject`. 컨트롤러·CRUD 는 `src/app/approval/`. `ROUTE_NOT_FOUND`·`ROUTE_AMBIGUOUS`·`NOT_YOUR_TURN`·`APPROVER_TYPE_NOT_SUPPORTED`·J-8(승인은 자물쇠만 푼다 — 후속은 상태 조회, 콜백 없음) |
| 승인 상신 코어 | I-2 코어 PR(채번과 별도) | `request`·`assertNoOpenRequest` — 둘 다 `approvalTypeCode` 축(`goods_issue` 가 두 유형). `selectRoute(businessUnitId)` 는 P/O 만 값, 8자리 null(문의 022). ⛔ **`assertApproved` 는 I-4 다** — 첫 사용처가 `goods-issues:post` 이고 I-2 에는 사용처가 0이다(I-2 재수립 R-9 · §1 과 같은 값). ⛔ **`request()` 는 채번을 부르지 않는다** — 호출자가 트랜잭션 밖에서 받은 `approvalRequestNo` 를 넘긴다(아래 채번 칸) |
| `omitEmpty` 헬퍼 | I-1 | `src/common/http/omit-empty.ts` — 값 없으면 키 생략(널 금지). 사용처 3(`ApprovalTarget`·`DocumentTarget`·`DocumentProgress`) |
| 채번 | I-2 코어 PR ≤200줄 | `core/numbering` — `numbering_rule`·`numbering_counter`, 기본 패턴, `GR-`·`PT-`·`NTC-` 이관. ⭐ **카운터 증가는 업무 트랜잭션 «밖»에서 돈다**(`next()` 가 `tx` 를 받지 않는다) — 안에서 올리면 ① 롤백이 번호를 되돌려 호출자의 재시도가 같은 번호를 다시 뽑고 ② 카운터 행 잠금이 전표 커밋까지 가서 같은 (유형·영업일)이 직렬화된다(Prisma 기본 5초 시한 → `P2028` 이 재시도 루프를 빠져나가 500). **결번은 허용한다** — 계약이 번호의 연속을 요구하지 않는다. ⭐ **그리고 업무 `$transaction` 을 «열기 전»에 부르고 번호 «문자열»만 트랜잭션에 넘긴다** — 업무 트랜잭션 안에서 부르면 한 요청이 커넥션을 셋 쥐어 풀(기본 `cpu×2+1`) 고갈 시 `P2024` 로 죽는다(PR #189 리뷰 Major-1). 순서는 `검증 → next() → $transaction(…, 번호)`. ⚠ **실측 정정(PR #190 리뷰 Major-1)** — 컨트롤러의 `runIdempotent` 가 이미 `$transaction` 을 열고 그 안에서 `create()` 를 부르므로 「모든 호출자가 열기 전」은 e2e 픽스처에서만 참이다. 운영 호출자는 **멱등 기록 트랜잭션 «안»**이라 요청당 동시 커넥션이 **2 로 main 과 같다(늘지 않는다)**. 진짜 밖으로 빼려면 `IdempotencyService.run` 경계 재설계가 필요해 I-2 범위 밖이다. 뒤 32 전표는 **이 정정된 문장**을 벤다(I-2 재수립 R-2) |
| 역트랜잭션 | I-5 코어 PR ≤200줄 | `InventoryPostingService.reverse()` — `reversal_of_transaction_id`·`reversal_of_business_date` 채움, `NEGATIVE_BALANCE` 400 |
| 다형 취소 | I-5 | `document-progress` 어댑터 — 유형↔표는 `app.entity_type_registry` 에서 읽음, 후속 판정 두 갈래(문서 역조회 + LOT 재고 사용), `SUCCESSOR_EXISTS` 요청·실행 시점 둘 다 |
| ERP 아웃박스 적재 함수 | I-6 (둘째 I-23) | `src/integration/message` 에 적재 함수 하나. `message_key` 규약 한 곳 |
| LOT 생명주기 전이 | I-6·I-7 | `transitions.ts` 에 이미 등록 — 호출만 |
| LOT 품질 축 전이 | I-19 | 계약이 이름 적은 전이만 등록. 미등록은 던진다(F-6) |
| 예약/피킹 | I-8 코어 PR ≤200줄 | `posting` 이 `reserved_qty`·`picked_qty` 를 올리고 내린다. 도메인의 `inventory_balance` 직접 UPDATE 금지(e2e 감지) |
| 시리얼 | 코어 아님 | I-26 서비스 안 |

## 4. 마이그레이션 목록 (전부 추가·완화 — 삭제 0, 두 릴리스 규칙 미해당)

번호: `A*` = API 표 A · `M-*` = 통합 §6-3 · `D*` = API 표 D · `U-*` = UI/UX §9 · `V-*` = `version_no` 결손 · `T-*` = 표 신설.
슬라이스 첫 PR 의 **선행 커밋**으로 싣는다. 슬라이스 계획에서 여기 없는 표·칸이 나오면 README §1-2 「차이가 크다」다.

| # | 슬라이스 | 표 | 무엇 |
|---|---|---|---|
| A6 | I-1 | `app.approval_route` · `app.approval_request` | 부분 유일 인덱스 `(approval_type_code, COALESCE(business_unit_id,0)) WHERE is_active` **+ `ix_approval_request_target (target_type_code, target_id)`**(J-8 상태 조회 축 — 모든 `:post` 의 자물쇠 경로) · 같은 선행 커밋 |
| A1·A2·M-b | I-2 | `logistics.purchase_order` | `approval_request_id?` · `source_inbound_receipt_line_id?` · 유일 제약(§I-48) |
| A3 | I-3 | `logistics.inbound_receipt_line` | `lot_id?` |
| M-c | I-4 | `logistics.goods_issue` | `destination_id`·`destination_type_code` NOT NULL 해제(#147) |
| M-d | I-6 | `production.work_order(_resource_assignment)` | 부분 유일 인덱스 + `remainder_disposition_code?` |
| D1 | I-7 | `production.production_result` | `shift_id` NOT NULL 해제 |
| A11 | I-24 | `planning.production_plan` | `split_of_plan_id?` |
| M-e | I-19 | 검사 의뢰 | 기준 완화(#280) |
| A12 · V | I-20 | `trace.lot_hold` | `target_lot_status_code?` · `version_no`(If-Match 대상이면) |
| A13 | I-22 | `logistics.shipment_request` | `sales_order_id?` |
| A14·M-f · U-I | I-23 | `logistics.shipment` | `expedited` · `expedite_reason?` · `confirmed_at?` · `confirmed_by?` |
| A4 | I-13 | `logistics.stock_transfer_line` | `handling_unit_id?` |
| A5 | I-17 | `logistics.recycle_entry` | `warehouse_id?` · `remarks?` (+ `item.mes_category_code` 없음 #64 — 슬라이스에서 판정) |
| A9·A10 | I-27 | `app.document_issue_log` · `app.printer` | 인쇄 결과 3칸 · 프린터 5칸(`status_code NOT NULL DEFAULT 'OFFLINE'`) |
| A7·A8 | I-28 | `app.notification_subscription` · **신설** `notification_subscription_recipient` | `zalo_enabled` · 수신자 표 |
| A15 | I-30 | `maintenance.breakdown` | `occurrence_state_code?` · `stopped_at?` · `notify_assignee?` |
| A16~A19 · V | I-31 | `maintenance.maintenance_order` · `maintenance_result` · **신설** `maintenance_result_line` · `maintenance_result_part` | 오더 5칸 · 실적 9칸 · 표 2 · `version_no` |
| V | I-32 | `maintenance.equipment_downtime` | `version_no` |
| A20~A22·M-g · V · T | I-33 | `tool_usage` · `collection_channel` · `equipment_calibration` · **신설** `collection_channel_observation` | 칸 4·5·8 · 부분 유일 인덱스 · `version_no` · 관측 표(영원히 빈 목록 — 문의) |
| — | I-35 | `audit` | jsonb 규약(§I-5, 마이그레이션 아닐 수 있음) |
| N | 해당 표 첫 슬라이스 | `x-no-code-key` 16자리 `status_code` | NOT NULL 해제(§0 #10) |

⚠ API 표 B — 계약이 「물리에 없다」 적었으나 **실제로는 있는 것**(`inventory_adjustment_line`·`goods_issue.approval_request_id`·알림·공지·`WorkCalendar` 등). 또 만들지 않는다.
⚠ `mdm.item.development_item` 은 만들지 않는다(계약이 「전건 적재」로 물러남).

## 5. 횡단 규칙 (슬라이스마다 적용 · API §5.3 요약)

1. **403 게이트** — 계약이 403 선언한 오퍼레이션은 `OPERATION_PERMISSIONS` 에 **같은 PR 에서** 등록(미등록 28건은 API §5.3 ①). 미등록이면 가드가 던져 500.
2. **멱등** — 쓰기 116건 전부 `runIdempotent`. 조회엔 안 붙인다. `recipients:preview` 도 감싼다.
3. **If-Match** — 필수 46/선택 28 을 가드 `requirement()` 그대로. 조이지도 풀지도 않는다. 다형 취소는 대상 문서 상세의 `version_no` 와 대조. `PUT .../lines` 는 부모 버전. `:acknowledge` 만 토큰 둘.
4. **ETag** — 42건 `setEtag`. 자식 컬렉션 GET 엔 안 붙인다(B-1-1 · 7건 명시).
5. **`@Contract`** — 249건 전건. 409 봉투는 도메인 전용 넷(`Production`·`Quality`·`Shipment`·`StockReinstatement`ConflictResponse) 을 계약대로 가른다. 422(보전 12건)는 슬라이스 시작 때 계약 문장 재확인.
6. **에러 코드** — 계약이 이름 적은 것(`SUCCESSOR_EXISTS`·`ROUTE_NOT_FOUND`·`OPEN_SESSION_EXISTS`(409)·`CANCEL_IN_PROGRESS`(409)…)은 그대로. 새로 짓는 것(API §5.4 둘째 표)은 §2 3단계 흔적 대상 — 조회의 `*BlockedReasonCode` 와 실행 오류가 **같은 문자열**.
7. **값 없는 칸** — 키 생략(널 금지). `businessDate`/`occurredAt` 는 원장 안 지나면 형식만 검증하고 저장 안 함(대기 15).
8. **원장 판별자 4값** 고정. 투입·실적·출하는 원장 안 지남(출하는 서버가 만든 `goods_issue`).
9. **주체는 계정 세션**(`계약-되돌림-mdm.md` Y-5 · 계약 `assignedToMe` 「지금은 계정 토큰에서만 풀린다」) — `X-Worker-No` 41건은 「누가 어느 단말에서」 덧붙임. 헤더가 없어도 400 을 내지 않는다(관리웹이 헤더 없이 부르는 것이 정상). 「내 요청」 필터의 축은 세션. ~~감사 칸이 아니라 주체~~(I-1 재수립에서 철회).
12. **승인 FK vs 다형 축** — 문서의 `approval_request_id` FK 는 **업무 승인 하나만**(`PURCHASE_ORDER`·`GOODS_ISSUE_DISPOSAL`·`INVENTORY_ADJUSTMENT`). `*_CANCEL`·`IQC_SKIP`·`PRODUCTION_RESULT_CORRECT` 는 FK 를 쓰지 않는다 — 정본은 `approval_request.(target_type_code, target_id, approval_type_code)`. 승인 판정은 언제나 다형 축으로 조회한다(I-5 가 I-4 의 품의 흔적을 덮지 않게).
10. **집계는 서버가** — 목록을 접지 않는다(L-1·L-2). `UNDETERMINABLE` 을 0/정상으로 접지 않는다.
11. **목록 「기간 필수」와 `openOnly` 공존**(L-3·L-12) — 계약 문장대로 둘 다.

## 6. 건너뜀 (루틴 끝 보고)

| 오퍼레이션 | 슬라이스 | 사유 |
|---|---|---|
| `POST /app/attachments` | I-34 | 바이너리 저장소(DB 밖) |
| `GET /app/attachments/{attachmentId}/content` | I-34 | 같음 |
| `POST /maintenance/breakdowns/{breakdownId}/attachments` | I-34 | 같음(+ `CD-ATTACHMENT-TARGET-TYPE` 에 고장 값 없음 — 문의) |
| `GET /app/document-issues/{documentIssueLogId}/rendition` | I-27 | 서버가 PDF/PNG 를 그린다 |

부분 건너뜀(구현은 함): `:resync` 202+아웃박스까지 · `work-orders:close`/`shipments:confirm` ERP 아웃박스까지 · `zaloEnabled` 칸만.
**목표 커버리지 483/487**(238 + 245).

배포 노트에 적을 것: 결재함 W-CO-09 「대상 화면에서 보기 ↗」는 9 유형 전건 `openable=false` 라 1차 내내 비활성(계약이 `screenId` 규칙을 준 유형이 없다 — 문의 019) · M-01-13 「내가 올린 요청」은 계정 세션 필요(단말 토큰 부재 → 401) · 라벨 POP 화면 8개는 「발행 기록은 남지만 종이가 안 나온다」 · 프린터는 보고 장치가 없어 `OFFLINE` 고정 · 한 화면이 여러 슬라이스에 걸치는 자리(M-01-08 · M-01-10 · W-02-05)는 마지막 슬라이스까지 반쯤 열림.

## 7. 설계 문의 후보 — 발생 슬라이스에서 단건 작성 (`docs/design-inquiries/018~`)

| 후보 | 슬라이스 | 출처 |
|---|---|---|
| `CD-ATTACHMENT-TARGET-TYPE` 에 `BREAKDOWN` 없음 | I-34 | API §3 |
| 프린터 상태를 올리는 주체·오퍼레이션 없음 | I-27 | §0 #7 |
| ~~승인 유형 9값에 특채 없음 — 결재함으로 찾는 길 확인~~ → **019 에 흡수**(I-1 에서 발행) | ~~I-21~~ I-1 | UI/UX M |
| **018** `inProgressCount` 연결 칸 없음 — 유형 축 근사 vs I-2 nullable `approval_route_id` | I-1 | I-1 재수립 R-11 |
| **019** `IQC_SKIP` 승인 화면 W-01-02/W-03-09 · 특채 9값 부재 · `screenId` 화면표 · `openable` 전건 false | I-1 | I-1 재수립 R-11 |
| **021** 승인 유형·대상 유형 표시명 원천 없음(`displayName` required · 끄기 경고 화면 목록 · `?q`) | I-1 | I-1 재수립 R-11 |
| **022** `GOODS_ISSUE_DISPOSAL` 결재선 `businessUnitId` 파생 매핑 없음 — 8자리 null | I-1(I-4 에서 드러남) | I-1 재수립 R-11 |
| **023** P/O 상태 축과 상신 뒤 잠금 — `REGISTERED` 밖으로 옮기는 오퍼레이션이 없다(화면의 상태 드롭다운도 갈 길이 없다 · 승인 대기 중 수정이 열려 있다) | I-2 | I-2 재수립 R-9 |
| **025** 등록한 P/O 를 다시 여는 화면이 없다 — 수정·라인 치환·재상신·「ERP 미매칭 배지」가 갈 곳이 없다 | I-2 | I-2 재수립 R-9 |
| ~~024~~ `erp_purchase_order_no` 유일 제약 → **철회·결번**(`W-01-11` §8 #3·#4 가 물음도 일정도 이미 세웠다). 우리가 부분 유일을 건 사실만 「알려둘 것」으로 | ~~I-2~~ | I-2 재수립 R-9 |
| 알려둘 것(번호 없음): (I-1) `PUT …/steps` ETag 내림(계약 미선언) · `?requestedByMe` 세션 필요 / **(I-2) `:request-approval` 이 `version_no` 를 안 올린다(8 상신자에 복사) · P/O 쓰기 3건 404 미선언인데 404 를 낸다 · `DEPARTMENT` 결재선을 사람으로 심는다 · `uq_purchase_order_erp_no` 를 걸었다 · 문의 14 표에 `purchase_order_no` 한 행 추가** | I-1 · I-2 | 다음 전달분 말미 |
| 처분 전이가 `transitionCode` 9종에 없음 | I-21 | UI/UX N |
| `lot-hold-events` vs `lot-status-events` — W-03-01 이 어느 쪽 | I-20 | UI/UX §9-3 |
| LOT 품질 판정 축(`lot.status_code` vs `inventory_balance.quality_status_code`) — #115 재판정 중 인용 | I-19/I-20 | UI/UX L · 아키텍처 §5 #1 |
| `POST /production/material-returns` 소유 화면 | I-10 | UI/UX §9-2 |
| 수리 `:return` 뒤 재투입 등록처 | I-25 | UI/UX §9-2 |
| 투입 정정(`:correct`) 부재 · 포장 해체 부재 | I-10 · I-16 | UI/UX E·F |
| 재생재/입하 오류의 «미등록 품목» 생성 경로 없음 | I-17 · I-3 | UI/UX B·C |
| 창고 «안» 위치 이동 업무 문서 없음 | I-13 | UI/UX A |
| 라벨 무효화 규칙 없음 | I-27 | UI/UX J |
| 출고·생산창고 입고 한 단말 오프라인 큐 순서 | I-9 | UI/UX K |
| `achievementRate` 분모 차이(LOT vs W/O) 화면 라벨 | I-7 | UI/UX §9-3 |
| M-01-08 결정 10 ↔ C-1 정면 충돌(열린 것 인용) | I-8 | UI/UX §9-3 |
| `collection_channel_observation` 영원히 빈 목록 | I-33 | UI/UX §9-2 |
| 값 목록 없는 코드(고장 원인·검교정 결과·알림 이벤트 문자열) | I-30·I-33·I-28 | UI/UX Q |
| `x-no-code-key` 16자리 nullable 처리 보고 | 첫 발생 | §0 #10 |
| 임박 임계 90 상수 · `businessDate` 미저장 건수 누적 | 누적 | 대기 6·15 |

## 8. 진행

병합마다 갱신한다. 커버리지 = 238 + 완료 슬라이스 건수 합.

| 슬라이스 | 상태 | PR | 커버리지 |
|---|---|---|---|
| I-1 | ✅ 2026-09-06 | #182(계획) · #183(① 코어) · #184(②a 조회 3) · #185(②b 쓰기 3 + A6) · #186(③b 결재함 2) · #187(③a 활성 전이 2) · #188(④ 결재 2) | **250** (12/12) |
| I-2 | ✅ 2026-09-06 | #189(계획) · #190(① 채번 코어) · #191(② 상신 코어 + 마이그) · #192(③ 조회 3) · #193(④ 등록·헤더 수정 2) · #194(⑤ 라인 치환·상신 2) | **257** (7/7) |
