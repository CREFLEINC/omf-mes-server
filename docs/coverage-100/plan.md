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
| 7 | `GET /app/printers` | 종전 칸5추가 제안 | 상태 원천 결손 | 종전 구현 제안 | **I-27 R15에서 유보로 재수립**. 관측 없음은 OFFLINE 사실이 아니다. 단말 매핑/식별명/명시 기본/지원종류/관측 producer 정본 전 handler·A10 0. active·첫행·같은공장·빈응답으로 대체하지 않는다 | 독립3리뷰·R1~R16·고정 요구서256 |
| 8 | 마이그레이션 수 | 22항목(앵커 실측) | 12 + 새 표 3 + `version_no` 4 | 7 | **API 표 A 를 목록 정본으로**(앵커에서 긁은 것) + 통합 7건(완화·인덱스) + UI/UX 의 `shipment.confirmed_*`·`version_no` 4표 → §4. 전부 추가·완화, 삭제 0 | 근거가 계약 문자인 것을 택함 |
| 9 | 새 표 3(UI/UX) | — | `work_order_resource_plan` · `handling_unit_repack_event` · `collection_channel_observation` | 기존 표 재사용(`work_order_resource_assignment` 인덱스 · `handling_unit_reconfiguration`) | **기존 표 우선**. `collection_channel_observation` 만 신설(계약 스키마가 실재하고 물리가 없다 — 「물리가 계약을 따른다」). 나머지 둘은 슬라이스 계획에서 기존 표로 안 되면 **3관점 재수립** 조건에 걸린다 | README §1-2 |
| 10 | `x-no-code-key` 16자리 `status_code` NOT NULL | 상수 하나 | — | — | **NOT NULL 해제(nullable)** — §2 2단계 ③ 이 「nullable」을 우선으로 적었다. 상수는 데이터에 남아 되돌리기 비싸다. 그 표를 처음 쓰는 슬라이스의 선행 마이그레이션에 싣는다. ⚠ **계약이 응답에 `required` 로 적은 자리에는 안 선다**(널이면 실을 값이 없다 — nullable 은 문제를 옮길 뿐) — 그 자리는 상수(`Asn.statusCode`·`InboundReceiptLine.statusCode` = `'REGISTERED'` · I-3 재수립 R-9) | README §2 2-3 |
| 11 | LOT 품질 축 전이 | 계약이 이름 적은 9줄만 등록, 나머지는 던짐 | 처분 전이 코드 없음 → 문의 | I-19 가 전이표를 채우고 뒤가 재사용 | **I-19 에서 계약이 이름 적은 전이만 등록**. ~~처분(I-21)은 … `transitionCode` 는 지어내지 않고 문의(§7)~~ ⇒ ⭐ **I-21 이 판정했다** — 계약이 도착 상태를 «적었고»(`quality-03품질.json:2460`) 없는 것은 코드뿐이라, README §2 1-1 「정하고 통보」로 **`C17`·`C18`·`C19` 를 정하고 통보 089** 를 낸다(I-21 §6-2 3안 비교표). ⛔ **`plan-api.md:871` 의 「계약이 `SCRAPPED` 전이를 안 적었다」는 실측으로 틀렸다** | API §6-3 · UI/UX §9-4 N |
| 12 | 알림 구독 축 | 새 표 `notification_subscription_recipient` | recipient 규칙 마이그 | — | **새 표** — 계약(이벤트별 수신자)이 물리(사용자별)와 반대 | API 위험 7 |
| 13 | I-9 생산창고 차이 | — | — | 기록만(뒤집히면 3관점 재수립) | **기록만** — I-9 계획서가 실측으로 확인(원장 FK 칸이 계약·물리 둘 다 0 · I-9.md §3-4 · R-17) | 통합 §9-6 |
| 14 | 출하의 원장 | — | — | `posting.post()` 직접, `GoodsIssueService` 안 부름 | 그대로 | 아키텍처 §1 |

## 1. 슬라이스 35 — 순서·선행·배분

순서는 통합 §4(M1 최단 → M2~M5), 병렬 레인은 통합 §6-2. **모델**: 코어/복합 = opus, 조회·복제 = sonnet (README §4).
**PR** 열은 예상(마이그레이션 선행 커밋은 같은 PR 안 별도 커밋).

| 순 | 슬라이스 | 건 | 선행 | 마이그(§4) | 코어 | 모델 | PR | 병렬 레인 |
|---:|---|--:|---|---|---|---|--:|---|
| 1 | **I-1** 승인 코어 — 결재선·결재함 | 12 | — | A6 | 승인(`src/core/approval/`) · `omitEmpty` 헬퍼 | opus(코어·결재) · sonnet(CRUD·조회) | 4 | ∥ I-30 |
| 2 | **I-2** P/O + 채번 코어 + 승인 상신 코어 | 7 | I-1 | A1·A2·M-b | 채번 · 승인 `request`/`assertNoOpenRequest`(별도 코어 PR) — `assertApproved` 는 **I-4 로 이관**(첫 사용처가 `goods-issues:post` · I-2 재수립 R-9) | opus(코어 2 · 마이그) · sonnet(P/O 조회·CRUD) | 5 | ∥ I-30/I-32 |
| 3 | **I-3** 입하 | 12 | I-2 | A3 + `inbound_variance.reason_code` 완화 + `ix_inbound_variance_line` | LOT 등록 `src/core/lot/`(코어 PR ≤200 · I-3 재수립 R-1) | sonnet(조회) · opus(마이그·LOT 코어·등록·치환·초과분리) | 6 | ∥ I-12 |
| 4 | **I-12** 적치 완료·임시적재 | 4 | 입고(구현됨) | — | — | opus(원장 STOCK_TRANSFER) | 2 | ∥ I-3 |
| 5 | **I-4** 출고 — 전표·전기 | 7 | I-3 | — (M-c 는 `20260901090000` 로 이미 적용됨 · I-4 재수립 R-11) | `assertApproved`(코어 PR) | opus(코어·원장·등록·치환) · sonnet(조회 3) | 5 | — |
| 6 | **I-5** 다형 취소 + 역트랜잭션 코어 | 4 | I-3·I-4 | `document_cancellation.reason_code` NOT NULL 해제(I-5 R-1) | `posting.reverse()` | opus · 조회 ③a③b sonnet | 6 | — |
| 7 | **I-6** W/O + 4M 배정 | 13 | I-2 | M-d | ERP 아웃박스(첫 사용처) · 생명주기 전이 | opus · ② sonnet | 7 | I-6 재수립 R-5 |
| 8 | **I-7** 생산 실적 + LOT 생명주기 L1 | 7 | I-6 | D1·**D2** | — | opus | **4** | — (I-7 재수립 R-5 · D2 는 R-1~R-20 참조) |
| — | **M1 체인 e2e** (통합 §4-1) | | I-7 | | | fable 통합 | 1 | |
| 9 | **I-8** 출고요청·피킹·예약 코어 | 8 | I-4 | — | `reserved_qty`/`picked_qty`(`pick()`·`consume()` 둘 — `reserve()` 는 사용처 0 이라 **I-22** · I-8 §3-7) | opus | ~~3~~ **5**(I-8 R-1 · ④ 선분할) | ⛔ I-5 와 직렬 |
| 10 | **I-9** 생산창고 입고 | 3 | I-8 | — | — | sonnet | 2 | — |
| 11 | **I-10** 자재 투입·반출 + 계보 | 6 | I-9·I-7 | **2** · `material_consumption.terminal_id`·`material_return.return_quality_status_code` NOT NULL 완화(I-10 재수립 R-3·R-4) | — | opus | 3 | ∥ I-11 |
| 12 | **I-11** 작업 세션·작업전점검 | 11 | I-6 | **1** · `work_session.shift_id` NOT NULL 완화(I-11 재수립 R-3 · D1 과 같은 모양) | — | sonnet ×2 · opus ×3(코어 `transitions.ts`·심장·events — R-15) | 5 | ∥ I-13 · ⚠ I-10 과 `production.module.ts` 같은 줄 |
| 13 | **I-24** 생산 계획·생산오더 | 10 | I-6 | A11(두 칸 — R-1) | `transitions.ts` 키 신설 1(R-12) · `src/core/work-order/defaults.ts` 신설(R-3) | opus(`:confirm` · `:acknowledge`/`:resync`) · sonnet(조회 · CRUD) | 4 | ① → {② → ③} ∥ ④(R-15) |
| 14 | **I-25** 공정 인계·수리 왕복 | 6 | I-7 | — | — | sonnet | 2 | — |
| — | **M2 체인 e2e** | | | | | fable | 1 | |
| 15 | **I-19** 검사 — 의뢰·결과·측정·확정 | 11 | I-7 | **M-e(항목 3)** | 품질 축 전이표(**액션별 `from`** — I-19 R-1) | opus | ~~4~~ **7** | M-e ∥ ②a(I-19 R-18) |
| 16 | **I-20** LOT 상태·보류 | 10 | I-19 | **M-f(항목 5)** — A12 **두 칸** · `version_no` 필수 · CHECK · 인덱스 2(I-20 R-1) | **`trace.lot_hold` 쓰기 코어**(I-20 R-4·R-5 — 잠금 순서) | opus | ~~3~~ **11~12**(I-20 R-17) | PR ⓪ = I-19 §12-1 ⓑ 상환 |
| 17 | **I-21** 부적합·처분·특채 | 11 | I-20 | **M-h(항목 3 · 파일 둘 — I-21 §2-5)** ⚠ ⓐ 는 **PR ④ 안**(R-8) | `transitions.ts` 키 신설 1 · 전이 5(**`C17`·`C18`·`C19` 신설**) · `document-state.spec.ts`·**`document-state.e2e-spec.ts`** · `numbering` `NC` 1줄 | opus · 조회 6 sonnet | ~~3~~ ~~9~~ **11**(I-21 §10 · 재수립 R-20) | — |
| 18 | **I-18** LOT 부가·상태 이력·IQC 생략 | 5 | I-1 | — | — | ① sonnet · ② opus | 2 | ∥ I-19 |
| — | **M3 체인 e2e** | | | | | fable | 1 | |
| 19 | **I-22** 출하지시·작업지시·제품 피킹 | 9 | I-8 | A13 | — | opus | 3 | — |
| 20 | **I-23** 출하·확정·취소 + 재등록 | 7 | I-22·I-5 · **I-19 품질 전이 코어(재등록, A)** | A14 · U-I(`confirmed_*`) | ERP 아웃박스 둘째 | opus | 4 | ⛔ I-4 와 직렬(이미 끝) · 재등록 전 A 코어 병합·동기화(`lanes.md` §0) |
| — | **M4 체인 e2e** | | | | | fable | 1 | |
| 21 | **I-13** 재고 이동 2단 | 6 | I-5 | A4 | `transitions.ts`(축 1·전이 2) | opus·sonnet | **4** | ∥ I-11 · ∥ I-14(같은 레인 C — `transitions.ts` 는 레인 «안에서» 직렬화 · I-13 R-10) |
| 22 | **I-14** 재고 조정 | 7 | I-1·I-5 | **N-1** | `transitions.ts`(키 1 · I-13 과 레인 안 직렬화) | opus·sonnet | **4** | C |
| 23 | **I-15** 실사 | 6 | I-14 | — | — | sonnet | 3 | — |
| 24 | **I-16** 취급 단위·포장·재구성 | 7 | I-12 | **N-2** | — | opus·sonnet | **4** | ∥ I-33 |
| 25 | **I-17** 재생재 등록 | 1 | I-3 | A5 | — | sonnet | 1 | — |
| 26 | **I-26** 제품 개체 조회·발번 | 2(진행1·보류1) | I-7 | 지금0 | 조건부 SERIAL_NUMBER 채번만 별도 코어≤200 | 조회/조건부 심장 분리 | 즉시 GET1 + 조건부 코어/쓰기 | I-26 R1~R10 · 문의104~107 |
| 27 | **I-27** 발행 이력·프린터 | 7(진행5·보류1·제외1) | I-26 저장조회 | A9 nullable6·A10 유보 | — | 물리/조회/쓰기 분리 | P0/P1/P2/P3·발행 규칙/잠금/배치 별도 | R1~R16·∥ I-28 |
| 28 | **I-28** 알림 | 8(즉시5·보류3) | I-1 | 지금0·A7/A8은 코드 정본 확인 뒤 | — | 조회 복제·쓰기 판단 분리 | 즉시3 + 조건부2 | `I-28.md` R-1~R-10 · 문의099~103 |
| 29 | **I-30** 설비 점검·고장 | 9(진행8·보류1) | — | A15 확장: nullable8추가·2완화 | EQI/MLF 채번2·고장 start 전이1(별도 코어 PR) | 조회/쓰기·코어 분리 | 실행8 + 조건부 완료 조각 | ∥ I-1 · I-30 R-1~R-14 |
| 30 | **I-31** 보전 지시·실적 | 8 | I-30·I-32 순간helper | order8추가/priority완화·result15추가/6완화·표2·trigger1:N/bigint | MO/cancel·부여탐색/PM사실 최소공유(core전체200) | 코어/마이그·조회·쓰기 분리 | 최소책임별·초과 때만 준비분할 | I-31 R1~R13·113~116, closed/reset true만422 |
| 31 | **I-32** 비가동 | 6(진행5·보류1) | I-11·I-30 날짜helper | 추가3/완화1·조건부 종료사번1 | 없음 | µs 준비/물리/조회/쓰기·summary 분리 | P0t+P1a물리/P1b조회+P2~P4, summary 재수립, 조건부close | I-32 R1~R16·문의108~112·재분류 정본 |
| 32 | **I-33** 툴 사용·계측기·수집 채널 | 12 | I31 reset경계·I32 순간helper | A20추가4/완화2·A21추가5/완화3·A22추가8·유일성·T | 새core0·누계NKU/실제FK writer회귀 | 물리/조회/쓰기 분리 | 10조각 후보·실제예산/A조율따라분할 | R1~R14·117~119, 정상12진행 |
| 33 | **I-34** 첨부(목록만) | 4 | — | — | — | sonnet | 1 | 3건 건너뜀 |
| 34 | **I-35** 변경 이력·예비품 엑셀 | 2 | — | audit jsonb 규약 | — | sonnet | 2 | — |
| 35 | **I-29** 통합 대시보드 | 1 | 전부 | — | — | opus(집계) | 1 | 맨 끝 |
| | **합계** | **249** | | | | | **~92** | |

⚠ 병렬 레인은 «허용»이지 «강제»가 아니다 — 게이트(`test:e2e`)는 한 번에 하나만 돌린다(간헐 실패 증거 #15).
병렬로 돌린 슬라이스는 앞 PR 병합 뒤 **`origin/main`을 merge**하고 게이트를 다시 탄다. 동기화·병합·브랜치 정리 절차는 **`lanes.md` §2**를 따른다(⛔ rebase·force-push 금지).

## 2. 마일스톤 완료 조건

| M | 슬라이스 | 체인 e2e (끝점 셋만 단언 — 통합 §5-3) |
|---|---|---|
| **M1** | I-1 → I-2 → I-3 (∥ I-12) → I-4 → I-5 → I-6 → I-7 (UI/UX U1 의 「상신 → 결재함 승인 → 전기」 한 줄 e2e 는 I-4 완료 시점에 선다 — I-1 은 원장 0건까지) | P/O 승인 → 입하 → 입고(기존) → 기타출고(`GOODS_RECEIPT` source, 피킹 없이) → W/O 발행·확정배포(선발행) → 실적(L1) → 제품 입고(기존) → balance 3행 → 입고 취소 요청·승인·실행 → 역트랜잭션 → balance 원복 |
| **M2** | I-8 → I-9 → I-10 ∥ I-11 → I-24 → I-25 | 계획 `:confirm` → W/O `PUT`(기본 WIP 위치 — 전개분은 NULL 이라 이 걸음 없이는 출고요청이 0건 · I-24 R-5) → W/O `:release`(출고요청 자동) → 피킹 → 출고 → 생산창고 입고 → 투입 → 세션 → 실적 → W/O `:cancel` 로 선발행 전건 폐번 |
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
| LOT 등록 | I-3 코어 PR ≤200줄 | `src/core/lot/` `createWithin(tx, …)` — `lot` + `lot_hold`, 읽기도 `tx`. `sourceTypeCode='INBOUND_RECEIPT_LINE'` 이면 `inbound_receipt_line.lot_id` 를 채운다(이미 있으면 400 `STATE_LOCKED`). 사용처 3(`POST /trace/lots` 구현됨 · I-3 입하 · I-17 재생재) — `server-architecture.md:67` 도메인 간 service 호출 금지 · §1 `lot-genealogy` 예고 자리(I-3 재수립 R-1) |
| 승인 완료 판정 | I-4 코어 PR ≤200줄 | `assertApproved(tx, targetTypeCode, targetId, approvalTypeCode)` — `approval_request` **다형 축**(FK `approval_request_id` 를 안 본다 · §5 #12). 요청 0건이면 통과(「승인이 필요한 전표」를 가르는 축이 데이터에 없어 상신 흔적으로 대신 가른다 — 문의 030 · I-4 재수립 R-4) · `PENDING` 400 `APPROVAL_IN_PROGRESS` · 거부/취소 400 `APPROVAL_REQUIRED`. 사용처 I-4 `goods-issues:post` · I-14 재고 조정. ⚠ **I-7 `:correct` 는 이 함수를 «쓰지 않는다»** — A급 정정은 「승인이 필수」라 0건 통과가 계약과 반대다 ⇒ 도메인이 5줄 판정을 둔다(코어 무변경 · I-7 §5-5). 030 이 답하면 두 자리를 함께 고친다 |
| 역트랜잭션 | I-5 코어 PR ≤200줄 | `InventoryPostingService.reverse()` — `reversal_of_transaction_id`·`reversal_of_business_date` 채움, `NEGATIVE_BALANCE` 400 |
| 다형 취소 | I-5 | `document-progress` 어댑터 — 유형↔표는 **코드의 정적 표**(등록부는 칸 4개라 `DocumentProgress` 를 못 채운다 · `entity_type_registry` 는 부팅 대조만 · I-5 R-6), 후속 판정 두 갈래(문서 역조회 + LOT 재고 사용), `SUCCESSOR_EXISTS` 요청·실행 시점 둘 다 |
| ERP 아웃박스 적재 함수 | I-6 (둘째 I-23) | **`src/core/outbox/`** 에 `enqueue()` 하나(사용처가 두 도메인 — I-6 R-11). `message_key` 규약 `{INTERFACE_CODE}:{문서번호}` · 버전 없음 · UNIQUE 충돌은 `alreadyQueued:true` |
| LOT 생명주기 전이 | I-6·I-7 | `transitions.ts` 에 이미 등록 + **`LotLifecycleService.moveWithin()`**(`lot_lifecycle_history` 를 쓰는 코어 · `{movedLotIds, skippedLotIds}` 반환)을 I-6 이 만들고 I-7 이 L1 로 재사용(I-6 R-12) |
| LOT 품질 축 전이 | I-19 | 계약이 이름 적은 전이만 등록. 미등록은 던진다(F-6). ⭐ **`from` 은 상수 하나가 아니라 액션별로 가른다**(I-19 R-1) — 계약이 「**불량(Hold)은 발신 전이가 0**」(`quality-03품질.json:4472`)과 「**이 경로에서만** Hold → 정상」(`shipment-04제품출하.json:431` · B-13)을 이름 적었다. `DEFECTIVE` 는 `stock-reinstate` 의 `from` 에만 |
| 예약/피킹 | I-8 코어 PR ≤200줄 | `posting` 이 ~~`reserved_qty`·~~`picked_qty` 를 올리고 내린다(`pick()`·`consume()` · `reserved_qty` 를 «거는» 오퍼레이션은 계약에 없다 — I-8 §5 · 문의 045). 도메인의 `inventory_balance` 직접 UPDATE 금지(~~e2e 감지~~ **정적 가드 spec** `balance-write-guard.spec.ts` — 잔액 UPDATE 트리거가 없고 코어 자신이 UPDATE 하므로 DB 층에서 주체를 못 가른다 · I-8 §3-8 · R-8) |
| 시리얼 | 코어 아님 | I-26 서비스 안 |

## 4. 마이그레이션 목록 (전부 추가·완화 — 삭제 0, 두 릴리스 규칙 미해당)

번호: `A*` = API 표 A · `M-*` = 통합 §6-3 · `D*` = API 표 D · `U-*` = UI/UX §9 · `V-*` = `version_no` 결손 · `T-*` = 표 신설.
슬라이스 첫 PR 의 **선행 커밋**으로 싣는다. 슬라이스 계획에서 여기 없는 표·칸이 나오면 README §1-2 「차이가 크다」다.

| # | 슬라이스 | 표 | 무엇 |
|---|---|---|---|
| A6 | I-1 | `app.approval_route` · `app.approval_request` | 부분 유일 인덱스 `(approval_type_code, COALESCE(business_unit_id,0)) WHERE is_active` **+ `ix_approval_request_target (target_type_code, target_id)`**(J-8 상태 조회 축 — 모든 `:post` 의 자물쇠 경로) · 같은 선행 커밋 |
| A1·A2·M-b | I-2 | `logistics.purchase_order` | `approval_request_id?` · `source_inbound_receipt_line_id?` · 유일 제약(§I-48) |
| A3 | I-3 | `logistics.inbound_receipt_line` | `lot_id?` + **같은 파일에** `inbound_variance.reason_code` NOT NULL 해제(계약 「⛔ 선택이다」) · `ix_inbound_variance_line`(I-3 재수립 R-9) |
| — | I-5 | `app.document_cancellation` | `reason_code` NOT NULL 해제(계약·화면에 사유 «코드» 축이 0 — I-3 A3 와 같은 모양 · I-5 재수립 R-1) |
| ~~M-c~~ | ~~I-4~~ | `logistics.goods_issue` | ✅ **이미 적용됨**(`20260901090000_goods_issue_destination_and_spare` · #44 ≡ #147 · `ck_goods_issue_destination`) — I-4 슬라이스 마이그 **0건**(I-4 재수립 R-11) |
| M-d | I-6 | `production.work_order_resource_assignment` | **식** 유일 인덱스 1건(`COALESCE(equipment_id, mold_id, worker_id, shift_id)` · I-6 R-9) — `remainder_disposition_code` 는 `close_disposition_code` 로 이미 있다 |
| D1 | I-7 | `production.production_result` | `shift_id` NOT NULL 해제 |
| **D2** | I-7 | `production.production_result` | **`correct_reason_code app.code_t` 추가**(nullable) — `ProductionResultCorrect.reasonCode` 가 required 인데 담을 칸이 없다(형제 `material_consumption.change_reason_code` 는 있다 · I-7 §2-2). D1 과 한 파일 |
| — | I-11 | `production.work_session` | `shift_id` NOT NULL 해제(계약 `WorkSession.shiftId` required 밖 · ⌜어느 교대에도 들지 않으면 비운 채 기록⌝ · D1 과 같은 근거 · I-11 재수립 R-3). ⛔ `terminal_id` 는 완화하지 않는다 — 세션 열기는 토큰 부재 403(R-1) |
| A11 | I-24 | `planning.production_plan` | `split_of_plan_id?` · `split_reason_code?`(app.code_t) · `ck_production_plan_split_self` · `ix_production_plan_split_of`(I-24 재수립 R-1 — 계약 `ProductionPlanSplitRef{sourcePlanId, reasonCode}` 두 칸) |
| M-e | I-19 | 검사 의뢰 · 검사 결과 | **항목 3**(I-19 R-2 · R-18 — **선행 단독 PR**): ⓐ `inspection_request.inspection_plan_version_id` NOT NULL 해제(#280) · ⓑ `ck_inspection_result_qty` 를 `status_code <> 'CONFIRMED' OR (합)` 으로 완화 · ⓒ `inspection_result.overall_judgment_code` NOT NULL 해제(⛔ ⓑ 만 풀면 임시 저장이 여전히 막힌다) |
| **M-f**(구 A12·V) | I-20 | `trace.lot_hold` | **항목 5**(I-20 R-1): 등록 도착 `target_lot_status_code?` · **해제 도착 `release_target_lot_status_code?`**(⭐ 한 칸이면 해제가 등록값을 덮는다 — 계약 `:4035` ↔ `:4191` 은 값 집합조차 안 겹치고, 부분 해제는 전이가 0건이라 도출할 원본이 없다) · ~~`version_no NOT NULL DEFAULT 1`(**조건부가 아니라 필수** — 물리에 칸이 없다)~~ ⛔ **I-20 R-24 가 폐기했다** — 계약(`:1950`·`:2058`)이 토큰은 **`trace.lot.version_no`** 라고 «명시»한다. 칸은 M-f 로 이미 섰으나 **읽는 코드가 0줄인 죽은 칸**이라 다음 릴리스 삭제 후보다(§6) · `ck_lot_hold_release_target` · 인덱스 2. 추가·완화만 · 삭제 0 · 백필 0 |
| **M-h** | **I-21** | **`mdm.code_value`**(`LOT_STATUS_TRANSITION`) · `quality.disposition_decision` · `quality.nonconformance_lot` | **항목 3 · 파일 둘**(I-21 §2-5 · 추가만 · 삭제 0 · 백필 0). ⛔ **`app.code_value` 는 없는 표다 — 정본은 `mdm`**(I-21 §0-재수립 **R-6**). ⓐ 처분 3전이 코드값 **`C17`·`C18`·`C19` INSERT**(`ON CONFLICT DO NOTHING` + `seed.ts` 동기) — ⛔ **이 항목은 «마이그 전용 PR» 이 아니라 코어 PR ④ 안에 든다**(**R-8** — `test/document-state.e2e-spec.ts` 가 양방향으로 단언해 따로 내면 어느 순서로도 `main` 이 빨갛다 · I-21 §10-0). ⭐ **베이스라인 밖에서 `code_value` 를 INSERT 하는 첫 사례**다(배포는 `migrate deploy` 만 돌고 시드를 안 돌린다) ⓑ **`ix_disposition_decision_nonconformance (nonconformance_id)`** — 그 표에 인덱스가 **0개**고 FK 에 자동 인덱스가 없다(**I-20 R-21 과 같은 자리**) ⓒ **`ix_nonconformance_lot_lot (lot_id)`** — `uq_nonconformance_lot` 은 선두가 `nonconformance_id` 라 `lotId` 축 질의 넷이 하나도 못 탄다 |
| A13 | I-22 | `logistics.shipment_request` | `sales_order_id?` |
| A14·M-f · U-I | I-23 | `logistics.shipment` | `expedited` · `expedite_reason?` · `confirmed_at?` · `confirmed_by?` |
| A4 | I-13 | `logistics.stock_transfer_line` | `handling_unit_id?` |
| **N-1** | **I-14** | `inventory.inventory_adjustment_line` | **`inventory_count_line_id BigInt?`** + FK + `ix_inventory_adjustment_line_count_line` — 계약 `InventoryAdjustmentLine.inventoryCountLineId`·`…LineUpsert.inventoryCountLineId` 둘 다 정의했는데 물리에 칸이 없다(I-14 재수립 R-4). ⭐ 이 칸이 **I-15 `:close` 의 「조정됨」을 라인 축으로** 재게 한다(§I-15 「라인 대응이 없다」를 연다) |
| **N-2** | **I-16** | **신설** `inventory.handling_unit_repack_event` · `handling_unit_repack_event_line` | 재포장 이벤트 헤더 + 라인(`role_code`·`qty_before`·`qty_after`) + 복합 인덱스 1. ⭐ **`plan.md` §0 #9 의 「기존 표 재사용」이 실측으로 뒤집혔다**(I-16 재수립 R-1) — `handling_unit_reconfiguration(+_line)` 은 라인 필수 6칸 중 4칸이 없고 `ck_handling_unit_reconfiguration_distinct(source ≠ target)` 가 계약 대표 경로(한 HU 의 `PUT …/contents`)를 **구조적으로 막는다**. 기존 표는 **손대지 않는다**(0행·참조 0) ⇒ 삭제 0 |
| A5 | I-17 | `logistics.recycle_entry` | `warehouse_id?` · `remarks?` (+ `item.mes_category_code` 없음 #64 — 슬라이스에서 판정) |
| A9 | I-27 | `app.document_issue_log` | 결과3+귀속3 nullable6, whole CHECK IS TRUE·FK NoAction. DEFAULT/백필0·구writer 종료/갱신→P5→환경별 응답 활성화 |
| A10 | I-27 | `app.printer` | **유보·적용0**. 단말 매핑/관측/기본/지원 원천 전 칸5 추가만으로 완료 불가. OFFLINE/false 기본값 제안 철회 |
| A7·A8 | I-28 | `app.notification_subscription` · **신설** `notification_subscription_recipient` | **조건부·지금 적용0**. zalo 칸·사용자/채널 nullable 완화·NULL/NULL 헤더 부분유일/짝 CHECK·규칙 표. 과거행 보존·백필0 (`I-28.md` R-2) |
| A15 | I-30 | `maintenance.breakdown`·`equipment_inspection` | 고장 nullable8추가: `occurrence_state_code`·`stopped_at`·`notify_assignee`·`reporter_worker_no`·`cause_code`·`handling_note`·`handled_by`·`handled_at`. 고장 `severity_code`·점검 `status_code` NOT NULL 완화. 삭제0/백필0, 과거 필수값·enum 사전조회는 조회 PR부터(`I-30.md` §2) |
| A16~A19 · V | I-31 | `maintenance.maintenance_order` · `maintenance_result` · **신설** `maintenance_result_line` · `maintenance_result_part` | order8추가(계정담당·계획/기준/메모·발행2·취소2)·priority완화. trigger order UNIQUE완화/shot snapshot2 bigint. result15추가(type+equipment/mold FK쌍·breakdown·계정수행자·본문/외주/reset/closed·version/audit)·구NOT NULL6완화·표2/FK역관계·CHECK·참조카운트. 삭제/백필0·required 구행 환경 활성화 제한(091) |
| V·물리 보완 | I-32 | `maintenance.equipment_downtime` | remarks text?·recorded_by_worker_no varchar(50)?·version_no default1/positive CHECK 추가3, downtime_type_code NOT NULL 완화1. close시각 해소 뒤 종료사번1 별도. 삭제/백필0·과거 required/구 작성자 배포검사(108) |
| A20~A22·M-g · T | I-33 | `tool_usage` · `collection_channel` · `equipment_calibration` · **신설** `collection_channel_observation` | nullable4/완화2·nullable5/완화3+네축NULL식유일·추가8(명시blocksfalse)+cal유형별/legacyNULL유일. cal version새칸0. T는설비/key실제최신관측,등록/활성연결두술어·수집자운영인수별도(118). 새FK참조보호A조율 |
| — | I-35 | `audit` | jsonb 규약(§I-5, 마이그레이션 아닐 수 있음) |
| N | 해당 표 첫 슬라이스 | `x-no-code-key` 16자리 `status_code` | NOT NULL 해제(§0 #10) — ⛔ 계약이 `required` 로 적은 자리는 제외(상수 · I-3 재수립 R-9) |

⚠ API 표 B — 계약이 「물리에 없다」 적었으나 **실제로는 있는 것**(`inventory_adjustment_line`·`goods_issue.approval_request_id`·알림·공지·`WorkCalendar` 등). 또 만들지 않는다.
⚠ `mdm.item.development_item` 은 만들지 않는다(계약이 「전건 적재」로 물러남).

## 5. 횡단 규칙 (슬라이스마다 적용 · API §5.3 요약)

1. **403 게이트** — 계약이 403 선언한 오퍼레이션은 `OPERATION_PERMISSIONS` 에 **같은 PR 에서** 등록(미등록 28건은 API §5.3 ①). 미등록이면 가드가 던져 500. ⚠ 가드는 계약이 403 을 «선언한» 자리에서만 검사한다(`permission.guard.ts:37-41`) — 표에 등재돼 있어도 미선언 오퍼레이션은 검사하지 않는다(I-6 R-22 ⓣ).
2. **멱등** — 쓰기 116건 전부 `runIdempotent`. 조회엔 안 붙인다. `recipients:preview` 도 감싼다.
3. **If-Match** — 필수 46/선택 28 을 가드 `requirement()` 그대로. 조이지도 풀지도 않는다. 다형 취소는 대상 문서 상세의 `version_no` 와 대조. `PUT .../lines` 는 부모 버전. `:acknowledge` 만 토큰 둘.
4. **ETag** — 42건 `setEtag`. 자식 컬렉션 GET 엔 안 붙인다(B-1-1 · 7건 명시).
5. **`@Contract`** — 249건 전건. 409 봉투는 도메인 전용 넷(`Production`·`Quality`·`Shipment`·`StockReinstatement`ConflictResponse) 을 계약대로 가른다. 422(보전 12건)는 슬라이스 시작 때 계약 문장 재확인.
6. **에러 코드** — 계약이 이름 적은 것(`SUCCESSOR_EXISTS`·`ROUTE_NOT_FOUND`·`OPEN_SESSION_EXISTS`(409)·`CANCEL_IN_PROGRESS`(S22 `:confirm` 만 409 · S06 다형 취소는 400 — I-5 R-9)…)은 그대로. 새로 짓는 것(API §5.4 둘째 표)은 §2 3단계 흔적 대상 — 조회의 `*BlockedReasonCode` 와 실행 오류가 **같은 문자열**.
7. **값 없는 칸** — 키 생략(널 금지). `businessDate`/`occurredAt` 는 원장 안 지나면 형식만 검증하고 저장 안 함(대기 15).
8. **원장 판별자 4값** 고정. 투입·실적·출하는 원장 안 지남(출하는 서버가 만든 `goods_issue`).
9. **주체는 계정 세션**(`계약-되돌림-mdm.md` Y-5 · 계약 `assignedToMe` 「지금은 계정 토큰에서만 풀린다」) — `X-Worker-No` 41건은 「누가 어느 단말에서」 덧붙임. 헤더가 없어도 400 을 내지 않는다(관리웹이 헤더 없이 부르는 것이 정상). ⚠ **예외 — 헤더가 «주체 칸의 유일한 원천»이고 POP 단말만 부르는 자리**: `POST /production/production-results`(`worker_id` NOT NULL) · `POST /trace/lots/{lotId}:complete` · **`POST /logistics/picking-orders/{id}/lines/{lineId}:pick`**(I-8 R-16 — 받아서 거부 판정에만 쓰고 버린다 · 담을 칸 0) · **`POST /logistics/shopfloor-receipts`**(I-9 R-11 — `received_by` 는 세션이 채우고 사번은 읽고 버린다 · 넷째) · **`POST /production/material-consumptions`**(I-10 §3-7 — `material_consumption.worker_id` NOT NULL 의 유일한 원천 · 저장형 · 다섯째) · **`POST /production/material-returns`**(I-10 §4-8 — 담을 칸 0 · 읽고 버림형 · 여섯째) · **`POST /production/work-sessions`**·**`…/{id}/events`**·**`…/{id}:end`**·**`POST /production/precheck-decisions`**(I-11 §3-7 · 담을 칸 0 · 존재 확인 후 버림 · 일곱째~열째) 는 없으면 400 `REQUIRED`(계약 `WorkerNo.required=true` ⌜없으면 서버가 거부한다⌝ · 계약이 관리웹이 부르는 `:correct`·`:request-approval` 에서 헤더를 걷어낸 것이 이 가름의 증거 2026-09-04 · I-7 R-18). 「내 요청」 필터의 축은 세션. ~~감사 칸이 아니라 주체~~(I-1 재수립에서 철회).
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
| `POST /trace/serial-numbers` | I-26 | LOT 배분 단위와 제품 개체 수 환산을 잘못 정하면 추적 관계를 되돌리기 어렵다. 105 회신 전까지 이 1건만 보류 |
| `POST /maintenance/downtimes/{downtimeId}:close` | I-32 | 오프라인 종료 발생시각의 입력 경로 결손. 단말 종료시각 전달 규약 또는 명시적 서버시각 예외가 필요하며 지금=서버로 추정하지 않음(109) |

부분 건너뜀(구현은 함): `:resync` 202+아웃박스까지 · `work-orders:close`/`shipments:confirm` ERP 아웃박스까지 · `zaloEnabled` 칸만.
**현재 목표 커버리지 481/487**(기술적 제외 I-34 3·I-27 rendition 1, 질의 대기 I-26 발번 1·I-32 종료 1). 2026-09-08 재분류에 따라 I-27 프린터·I-28 3건·I-30 완료·I-32 summary는 서버팀 결정·통보 후 진행 대상으로 복원했다. 배정/분모487은 불변이다. I-32 P4 #360 후보는 **378/487·4tests pass**이며 병합 전에는 main 수치로 쓰지 않는다.

I-28 배포 제한: 저장 알림 조회·읽음·수신자 preview 5건에 이어 이벤트·구독 3건도 서버팀 결정·통보로 진행한다. 알림 발생기·Zalo 전송기0은 그대로다. `openable=false`는 대상 삭제가 아니라 화면 매핑 부재일 수 있고 읽음은 가능하다. 목록 규칙 수와 preview 활성 인원수는 다르다(`I-28.md` R-5·R-7).

I-30 배포 제한: 점검·고장9건 전부 서버팀 결정·통보로 진행한다. 고장 PUT의 원인 nonnull만 명시 거부하고 생략 유지·null 해제·메모 저장은 가능하다. 보고 성공은 알림 발송·사진 업로드 성공이 아니다. 유효 계정 세션이 필요하며 X-Worker-No 교차 오리진 허용은 공용 담당 과제다(054·090~098). 과거 필수값/enum 결손 환경의 배포는 별도 판정한다. 날짜 조회는 설비 공장의 로컬 달력일이고 채번 기간은 기존 UTC 선례다.

I-31 배포 제한: R1~R13으로 GET4·쓰기4 정상 본길 진행. closed=true와 resetCounter=true만422·업무/자식/누계/lastPM/version/멱등 전건0이며 미마감 nonreset 기록·수정은 정상이다. finishedAt를 PM 완료로 해석하지 않는다. 구행 required 결손 또는 구 작성자 지속 환경만 활성화 유보, 개발 DDL/정상 구현 중단0. parts는 기존 출고 참조·unknown단위NULL이지 posting/환산이 아니다. 실제 부여·예비품 writer와 NKU/SHARE/UPDATE 경로 안정화·유한 run 재시도 인수, 상세/PUT·PM 날짜·마감/누적 의미·단위 확인 소비자 인수는 별도 미완(091·094·113~116). I-32 summary111은 설계 질의 대기가 아니라 서버팀 결정·통보 대상으로 재분류됐다.

배포 노트에 적을 것: ⛔ **(I-20 R-24) `trace.lot_hold.version_no` 는 «쓰이지 않는 죽은 칸»이다** — M-f(#351)가 세웠으나 계약이 ETag/If-Match 토큰을 `trace.lot.version_no` 로 «명시»한다(`:1950`·`:2058`). 읽는 코드가 **0줄**이라 「사용 제거」는 이미 끝났다 ⇒ **다음 릴리스에서 컬럼 삭제**(`CLAUDE.md` 두 릴리스 규칙). ⚠ `schema.prisma` 에 남아 있어 `runVersioned` 류가 실수로 집을 수 있다 · ⭐ **(통보 051) 자재 반출분은 재고 수불에 안 잡힌다 — 실사 시 라인 재고가 장부보다 적게 나오는 원인이다** · ⭐ **(통보 030) 폐기 출고는 「상신 흔적이 있는 전표」만 승인을 강제한다 — 「승인 없이 나간 건」을 세는 질의는 문의 030 파일에 있다** · ⭐ **(회신 052) LOT 계보는 W/O 단위다 — 리콜은 W/O 단위 회수를 전제한다** · 결재함 W-CO-09 「대상 화면에서 보기 ↗」는 9 유형 전건 `openable=false` 라 1차 내내 비활성(계약이 `screenId` 규칙을 준 유형이 없다 — 문의 019) · M-01-13 「내가 올린 요청」은 계정 세션 필요(단말 토큰 부재 → 401) · 라벨 POP 화면 8개는 「발행 기록은 남지만 종이가 안 나온다」 · 프린터는 보고 장치가 없어 `OFFLINE` 고정 · 한 화면이 여러 슬라이스에 걸치는 자리(M-01-08 · M-01-10 · W-02-05)는 마지막 슬라이스까지 반쯤 열림.

I-26 배포 제한: 저장 개체 조회1건만 진행하며 P-02-05·재사용 P-02-12의 새 발번은 미완이다. 수량 대응·상태 원천을 조용히 만들지 않는다. I-27의 기존 serial/LOT/HU 발행기록 경로는 별도 판정한다. 재개 때 발번 N개→단일 targets N개의 발행 요청으로 연결하고 단계별 키를 유지한다. 번호 결번/If-Match와 귀속·보존 한계는106·107에 인계했다.

I-27 배포 제한: 조회3/발행POST1/보고1과 프린터1까지 6건을 서버팀 결정·통보로 진행하되 문서9종 전체 지원이나 실물 인쇄 완료를 뜻하지 않는다. §0 지원표의 LOCATION·자재 초기검사대기/양품·완료생산양품·GI라인/HU·포장HU·확인CoA 정상가지는 진행한다. 개체양품/출하배분/PACKING+LOT는 이름 있는 거부, TOOL은 기존MOLD writer 소유조율/경합보완 전 조건부거부다. rendition1은 기술적 제외다. A9 구행required/구writer 환경 점검과 summary legacy NULL 정상 경로를 구분한다. MATERIAL PENDING/FAILED도labelIssued라는 기존규칙·실제화면 렌디션실패복구/51+페이지/대상화면 이동 미완을 인계하며 자동FAILED/상태도출0.

I-32 배포 제한: 목록·상세·생성·수정4건은 #353/#357/#359/#360으로 구현했고 summary는 서버팀 결정·통보로 재수립한다. close 1건만 109 회신 전까지 유보한다. µs를 저장/잠금/조회/재생까지 보존하며 화면의 단말 로컬 미래 검사를 서버 수신시각 검사로 대체하지 않는다. summary도 원천을 보존하는 교체 가능한 산식으로 구현하되 선택 필드를 상시 생략해 완료 처리하지 않는다. 기존 µs 행은 정상 자료, 필수 사유/사번 결손은 별도 배포검사다(108~112).

## 7. 설계 문의 후보 — 발생 슬라이스에서 단건 작성 (`docs/design-inquiries/018~`)

| 후보 | 슬라이스 | 출처 |
|---|---|---|
| **156** `CD-ATTACHMENT-TARGET-TYPE` 결손 **둘** — `BREAKDOWN`(고장 사진) · 입하 거래명세서 사진(`InboundReceiptCreate.deliveryNoteAttachmentId` 실재) | I-34 | API §3 · I-34 재수립 R-10 |
| 프린터 단말매핑·관측/기본/지원 정본 없음 | I-27 | §0 #7·I-27 R15, 해당 GET 유보·새 단건 번호 대기 |
| ~~승인 유형 9값에 특채 없음 — 결재함으로 찾는 길 확인~~ → **019 에 흡수**(I-1 에서 발행) | ~~I-21~~ I-1 | UI/UX M |
| **018** `inProgressCount` 연결 칸 없음 — 유형 축 근사 vs I-2 nullable `approval_route_id` | I-1 | I-1 재수립 R-11 |
| **019** `IQC_SKIP` 승인 화면 W-01-02/W-03-09 · 특채 9값 부재 · `screenId` 화면표 · `openable` 전건 false | I-1 | I-1 재수립 R-11 |
| **021** 승인 유형·대상 유형 표시명 원천 없음(`displayName` required · 끄기 경고 화면 목록 · `?q`) | I-1 | I-1 재수립 R-11 |
| **022** `GOODS_ISSUE_DISPOSAL` 결재선 `businessUnitId` 파생 매핑 없음 — 8자리 null | I-1(I-4 에서 드러남) | I-1 재수립 R-11 |
| **023** P/O 상태 축과 상신 뒤 잠금 — `REGISTERED` 밖으로 옮기는 오퍼레이션이 없다(화면의 상태 드롭다운도 갈 길이 없다 · 승인 대기 중 수정이 열려 있다) | I-2 | I-2 재수립 R-9 |
| **025** 등록한 P/O 를 다시 여는 화면이 없다 — 수정·라인 치환·재상신·「ERP 미매칭 배지」가 갈 곳이 없다 | I-2 | I-2 재수립 R-9 |
| **026** 입고가 소비한 입하를 «전기 완료»로 옮기는 주체가 없고, 저장된 입하를 다시 여는 화면도 없다 — 「작성중에서만」 가드가 늘 통과 · 두 PUT 을 부르는 화면 0건(`M-01-09` §8 #1 취소·재등록 선례를 따르는가) | I-3 | I-3 재수립 R-8 |
| **030** 폐기 출고의 승인 게이트를 걸 축이 데이터에 없다 — 「폐기」`reasonCode` 값이 아직 안 실렸고(고객 확장) 매핑은 데이터여야 한다 · 상신 뒤 라인 변경 · `postImmediately=true` 를 서버가 거부할 것인가(«고아 전표» — 한 버튼 두 호출의 둘째가 400 이면 승인 0건 전표가 남는다) | I-4 | I-4 재수립 R-5 |
| **031** 출고 라인이 잔액 차원 두 칸(`qualityStatusCode`·`inventoryStatusCode`)을 안 싣는다 — 한 (위치·LOT)에 품질 상태가 둘이면 어느 재고를 내는지 계약이 말하지 않는다(서버: 1행 채택 · 2행+ 400) | I-4 | I-4 재수립 R-5 |
| **027** 입하 오류를 기록한 뒤 담당자가 그것을 여는 화면·필터가 없다(입하 목록 10필터에 차이 축 0 · `W-01-05` 는 `inbound_variance` 를 안 본다) — 025 의 입하판 | I-3 | I-3 재수립 R-8 |
| ~~024~~ `erp_purchase_order_no` 유일 제약 → **철회·결번**(`W-01-11` §8 #3·#4 가 물음도 일정도 이미 세웠다). 우리가 부분 유일을 건 사실만 「알려둘 것」으로 | ~~I-2~~ | I-2 재수립 R-9 |
| **032** 취소 실행이 역트랜잭션의 영업일·시각·번호를 아무것도 안 받는다 — `:cancel` 본문 없음(04 `ShipmentCancel` 은 `businessDate`·`occurredAt` required) → 서버가 원 트랜잭션 영업일 + `{원 번호}-R` 로 채움(C-8 과의 정합) | I-5 | I-5 재수립 R-3·R-4 |
| **033** 취소 승인이 반려되면 `CANCEL_REQUESTED` 를 되돌릴 경로가 없다 — `W-CO-09` §5-5·J-6 은 «재상신»을 전제하는데 §4-4 순위 3 이 영구히 막는다(철회는 `W-04-10` §8 미결 5 둘째 사용처) | I-5 | I-5 재수립 R-2 |
| **034** 후속 판정 축이 계약 문자와 화면에서 어긋난다 — `cancelBlockedReasonCode` 5값·`successorCount` 두 갈래·`TYPE_NOT_CANCELABLE` 9종 중 6종 회색 | I-5 | I-5 재수립 R-6 |
| **035** `:hold`/`:resume` 을 부르는 화면이 0건인데 오퍼레이션이 서 있고 W/O 층 중단이 셋을 잃는다 — 사유 값 0건 · 구간 표 없음(`held` 근사) · 세션 없는 `IN_PROGRESS` | I-6 | I-6 재수립 R-19 |
| **036** 선발행 슬롯 `lot.source_type_code='WORK_ORDER'` 가 시스템 소유 그룹 `LOT_SOURCE_TYPE` 에 없다(코드는 이미 쓴다) | I-6 | I-6 재수립 R-1 |
| **037** `:release` BOM 소요 산정 규칙 부재 — `bom_component` 공정 칸 둘 중 어느 축 · `scrap_rate` | I-6 | I-6 재수립 R-3 |
| **038** `:cancel` 이 이미 발행된 출고요청을 어떻게 하는지 미기재 · `W-02-06` 에 사유 고르는 칸 없음 | I-6 | I-6 재수립 R-20 |
| **039** 마감 전 게이트 셋을 서버가 판정할 수단이 없다 | I-6 | I-6 재수립 R-2 |
| **040** 긴급 발행(계획 없는 `POST`)의 내부 P/O 공장·사업부를 풀 값이 어디에도 없다 — 답 전까지 400 | I-6 | I-6 재수립 R-6 |
| **041** 실적 정정 상신이 등급을 판정할 입력을 받지 않는다 — 「B급 400」 을 낼 축 없음 · 승인 1건이 정정 몇 건을 여는가 | I-7 | I-7 재수립 R-11 · §9-2 |
| **042** 병합된 I-6 코드가 정정 누계를 «합»으로 확정해 두었는데 I-7 이 «잎만»으로 뒤집는다 — `:close` 3분류·ERP 전송값의 정본 | I-7 | I-7 재수립 R-11 · §9-2 |
| **043** 생산 LOT 완료의 미달 사유를 담을 칸이 LOT 쪽에 없다 — `work_order` 한 칸을 슬롯 여럿이 덮는다 | I-7 | I-7 재수립 R-11 · §9-2 |
| **044** 정정이 실적-LOT 배분을 고칠 길이 없다 — LOT 축 누계·`:complete` 판정이 정정을 못 따라간다 | I-7 | I-7 재수립 R-11 · §9-2 |
| **045** 피킹 지시를 만드는 오퍼레이션이 계약에 0건이고 예약을 «거는» 자리도 없다 — 배정 축 3겹 부재 · `M-01-08` 반쯤 열림 · M2 「피킹」 마디가 서버로 안 이어진다 | I-8 | I-8 재수립 R-22 · §5 |
| **046** `issued_qty` 를 올리는 오퍼레이션이 없어 같은 「기출고」가 두 벌이 된다 — `ck_material_issue_line_qty` 무의미 | I-8 | I-8 재수립 R-23 · §7-4 |
| **047** 자재 출고요청 응답에 표시 라벨 칸이 0 — `PickingLine` 파생 9칸과 비대칭 · L-2 와 충돌 | I-8 | I-8 재수립 R-23 ⓒ |
| 알려둘 것(번호 없음): (I-1) `PUT …/steps` ETag 내림(계약 미선언) · `?requestedByMe` 세션 필요 / **(I-2) `:request-approval` 이 `version_no` 를 안 올린다(8 상신자에 복사) · P/O 쓰기 3건 404 미선언인데 404 를 낸다 · `DEPARTMENT` 결재선을 사람으로 심는다 · `uq_purchase_order_erp_no` 를 걸었다 · 문의 14 표에 `purchase_order_no` 한 행 추가** / **(I-3) `I-3.md` §7-5 ⓐ~ⓗ + 재수립 R-11 ⓘ~ⓡ 18건**(`reason_code` NOT NULL 해제 · 라인 `status_code` 상수 · 쓰기 3건 404 미선언 · `:split`·`variances` 409 미선언 · 첨부 id 버림 · `SplitPart` 차량번호 유실 · 동시 입하 400 화면 통지 · `W-01-09` 두 열 결손 · 문의 14 표에 `inbound_receipt_no`) / **(I-5) `I-5.md` §9-3 ⓐ~ⓤ 21건(R-12) + 구현 중 5건**: `previous_status_code` 는 언제나 `CANCEL_REQUESTED`(`reversed` 는 원장 0/1/2행+ 규칙) · 어댑터는 입하 하나뿐(입고·출고는 항등) · `NEGATIVE_BALANCE` 는 입고 취소에서 LOT 축 후속 판정에 먼저 막혀 사실상 도달 불가 · `:request-cancel` 채번이 존재 확인보다 앞이라 404/400 때 AP 번호 결번(후속 소형 PR 후보 · `purchase-order.service.ts:282` 선례) · 상세 `steps` 의 `POSTED` 줄은 원장 행이 있을 때만(입하는 영원히 없음) · 취소된 입고의 `putaway_task` 잔존 · `goods_issue` 취소 3칸 영원히 빔 · `reversal_of_transaction_id` 무인덱스 · 원장 마감 개념 부재 · 목록 판정 행당 최대 8쿼리 · e2e 시계 축(`occurred_at` 앱 시각 vs `created_at` DB 시각) 혼재 | I-1 · I-2 · I-3 · I-5 | 다음 전달분 말미 / **(I-6) `I-6.md` §9-3 ⓐ~ⓩ 25건(R-22) + 구현·리뷰 9건**: `:hold` `reasonCode` 공백 400 · `:hold`/`:resume` 403 e2e 없음 · `WO-`·`MIR-` 번호 날짜가 UTC(하노이 새벽 발행이 전날 번호) · 계획 없는 `POST` 400 `REQUIRED`(040 답 전까지) · `:cancel` 은 `note` 를 버리고 `remarks` 미갱신 · `moveWithin()` 이 LOT `version_no` 를 올린다(선발행 LOT 화면의 If-Match 가 확정배포 뒤 낡음) · CHECK 두 건은 서비스 손검사 400(R-28) · `:close`/`:cancel` If-Match 400/409 e2e 없음 · 멱등 재전송의 아웃박스 단일 적재 e2e 없음 / **(I-7) `:correct` 가 배분을 안 만들어 LOT 축 진척이 정정을 못 따라간다(044) · 이미 정정된 원본 400 `STATE_LOCKED`(R-21) · `CLOSED` W/O 에 실적·정정이 들어간다(재송신 축 없음) · 마감된 W/O 의 미달 완료 400 · `:complete` ETag 없음 · D2 `correct_reason_code` 우리가 만듦 · `PRODUCTION_RESULT_CORRECT_REASON` 값 0건 · Express 약한 ETag — 전체는 `design-inquiries/README.md` (I-7) 줄** / **(I-8) `I-8.md` §10-3 13건(R-22·R-23·R-24 로 ⓕ→045 · ⓗ→047 흡수 · ⓜⓝⓞ 추가) + 구현·리뷰 6건**: ETag 0건 · `X-Worker-No` 담을 칸 없음 · 취소된 피킹 출고 재출고 400 · 계획 BOM 변경 시 shortage 갈림 · `:release` 0건 사유 못 가름 · 피킹 목록 유형 질의 없음 · `:pick` 이 지시 상태를 안 옮김 · 0 되돌림 불가 · `held`≠`blocks_picking` · `lines: []` 는 `RANGE` · W/O 판정 tx 밖 · 피킹 소진 축은 출고 헤더 — 전체는 `design-inquiries/README.md` (I-8) 줄 |
| ~~처분 전이가 `transitionCode` 9종에 없음~~ → **통보 089 로 발행**(I-21 · `C17`·`C18`·`C19` 신설 · 재등록 자리와 함께 담았다) | I-21 | UI/UX N |
| `lot-hold-events` vs `lot-status-events` — W-03-01 이 어느 쪽 | I-20 | UI/UX §9-3 |
| LOT 품질 판정 축(`lot.status_code` vs `inventory_balance.quality_status_code`) — #115 재판정 중 인용 | I-19/I-20 | UI/UX L · 아키텍처 §5 #1 |
| `POST /production/material-returns` 소유 화면 | I-10 | UI/UX §9-2 · **050 으로 발행**(I-10 재수립 R-10·R-13) |
| 수리 `:return` 뒤 재투입 등록처 | I-25 | UI/UX §9-2 |
| 투입 정정(`:correct`) 부재 · 포장 해체 부재 | I-10 · I-16 | UI/UX E·F · E 는 **055 로 발행**(I-10 재수립 R-13) |
| 재생재/입하 오류의 «미등록 품목» 생성 경로 없음 | I-17 · I-3 | UI/UX B·C |
| 창고 «안» 위치 이동 업무 문서 없음 | I-13 | UI/UX A |
| 라벨 무효화 규칙 없음 | I-27 | UI/UX J |
| ~~출고·생산창고 입고 한 단말 오프라인 큐 순서~~ — **C-10 으로 해소**(공유계약 v0.7 「큐에 순서 의존이 있으면 묶음으로 거부」 · I-9 R-2) | I-9 | UI/UX K |
| `achievementRate` 분모 차이(LOT vs W/O) 화면 라벨 | I-7 | UI/UX §9-3 |
| M-01-08 결정 10 ↔ C-1 정면 충돌(열린 것 인용) | I-8 | UI/UX §9-3 |
| `collection_channel_observation` 실제최신저장소와수집자운영인수 | I-33 | R6·문의118: 저장값조회진행/수집자시계·역순·동률미완, 영구빈stub0 |
| 원인/이벤트 본길과 검교정확장 가장자리 | I-30·I-28·I-33 | 090/099유보·117기본3/nonCAL정상, unknownCAL만422 |
| `x-no-code-key` 16자리 nullable 처리 보고 | 첫 발생 | §0 #10 |
| 임박 임계 90 상수 · `businessDate` 미저장 건수 누적 | 누적 | 대기 6·15 |

## 8. 진행

병합마다 갱신한다. 커버리지는 실제 main의 계약 바인딩 수로 측정한다. 일부만 구현한 슬라이스도 병합된 operation만 더하며 계획·보류는 세지 않는다.

| 슬라이스 | 상태 | PR | 커버리지 |
|---|---|---|---|
| I-1 | ✅ 2026-09-06 | #182(계획) · #183(① 코어) · #184(②a 조회 3) · #185(②b 쓰기 3 + A6) · #186(③b 결재함 2) · #187(③a 활성 전이 2) · #188(④ 결재 2) | **250** (12/12) |
| I-2 | ✅ 2026-09-06 | #189(계획) · #190(① 채번 코어) · #191(② 상신 코어 + 마이그) · #192(③ 조회 3) · #193(④ 등록·헤더 수정 2) · #194(⑤ 라인 치환·상신 2) | **257** (7/7) |
| I-3 | ✅ 2026-09-06 | #195(계획) · #196(① ASN 3) · #197(②a 마이그+LOT 코어) · #198(도우미) · #199(②b-1 규칙) · #200(②b-2 등록 1) · #201(③ 조회 4) · #202(④ 수정·치환 2) · #203(⑤ 분리·차이 2) · #204(⑥ `:split` 겹침·선잠금 후속) | **269** (12/12) |
| I-4 | ✅ 2026-09-06 | #206(계획) · #207(문의 030·031) · #209(① 조회 3) · #208(② `assertApproved` 코어) · #211(③a `postIssue()`) · #210(③b `:post`) · #212(④ 등록 + `postImmediately`) · #213(⑤ 라인 치환·상신) | **276** (7/7) |
| I-5 | ✅ 2026-09-06 | #215(계획 R-1~R-14) · #216(문의 032·033·034) · #218(①a 선잠금 + 에러 코드 3) · #217(①b `reverse()` 코어) · #219(② 유형 매핑 + `evaluate()`) · #220(③a 목록) · #221(③b 상세) · #222(④ `:request-cancel`) · #223(⑤ `:cancel` + 마이그 `reason_code?`) | **280** (4/4) |
| I-6 | ✅ 2026-09-06 | #225(계획 R-1~R-26) · #226(문의 035~040) · #227(① 마이그·골격·상세·자원계획 GET) · #228(③ 4M 6규칙·배정) · #229(② 목록 23 질의) · #230(⑤a LOT 코어 `preIssueWithin`·`moveWithin`) · #231(④ 발행·수정) · #232(④b `:hold`/`:resume`) · #233(⑥a 아웃박스 코어) · #234(⑤b `:release`) · #235(⑥b `:close`/`:cancel`) | **293** (13/13) |
| I-7 | ✅ 2026-09-07 | #238(계획 R-1~R-20) · #239(① 마이그 D1·D2 + 골격 + 조회 3) · #240(② `POST` 실적 + 배분 + L1 + 누계) · #241(③ `:correct` + `:request-approval` · 리뷰 정정 R-21) · #242(④ `:complete` + `Lot.progress` + M1 마디 e2e) | **300** (7/7) |
| I-8 | ✅ 2026-09-07 | #244(계획 R-1~R-24) · #245(① 코어 `pick()`/`consume()` + 정적 가드) · #246(④a 피킹 조회 2) · #247(② 요청 조회 3 + `core/bom` 이관 + `REGISTERED` 정정) · #248(③ `POST` 요청 + 예약 목록) · #249(④b `:pick` + `consume()` 배선 + M2 마디 e2e) | **308** (8/8) |
| I-9 | ✅ 2026-09-07 | #251(계획 R-1~R-21) · #252(① 조회 2 + 뷰·include 상수) · #253(② `POST` + 채번 `SR` + e2e 17) | **311** (3/3) |
| I-10 | ✅ 2026-09-07 | #255(계획 R-1~R-18) · #257(① NOT NULL 완화 마이그 2 + 조회 4 + 뷰 2) · #260(② `POST` 투입 + `MC` 접두어 + M2 마디 ⑨→⑩ e2e) · #259(③ `POST` 반출 + `MR` 접두어 + 권한 잠정 등록) | **317** (6/6) |
| I-11 | ✅ 2026-09-07 | #256(계획 R-1~R-17) · #261(① 조회 5 + 뷰 2벌 + 골격) · #258(② 코어 전용 — 전이 4액션 + `shift-resolver` + 마이그 `20260907800000`) · #263(③ 세션 열기·닫기 + 단말 토큰 헬퍼 + M2 세션 마디 e2e) · #264(④ `/events`·`/workers`·`:leave` + 권한 등록 2) · #262(⑤ `POST` precheck 판정) | **328** (11/11) |
| I-12 | ✅ 2026-09-07 | #266(계획 R-1~R-14) · #267(① 조회 2 + 뷰 + 권한 2 + 전이표 2) · #268(② `:complete`·`:complete-temporary` + 원장 `STOCK_TRANSFER` + 잔액 하한 400) · #269(마감 docs · 문의 059~062) | **332** (4/4) |
| I-28 | 정상5건 병합 완료·③ **#313 MERGED** | 636a1f1·비테스트360/400·R-11 ID 정밀도 수정·독립 최종지적0. 최신main 반영 lint/tsc·unit103/1019·preview27·품질39·영향회귀49 exit0. 실제 자식315 main/OPEN·열린자식0·mainFF·자기branch정리 완료 | main직접357/487·4tests pass, ③+1·I-28 구현5/8·보류3 |
| I-30 | 계획·⓪·①·②·③ 병합 완료 | #297/#300/#305/#308/#310 MERGED·열린자식0/mainFF/자기브랜치정리. ③4cfe9a9·非test329·독립지적0·unit100/949·고장10·영향점검35/precheck12 exit0·DB56/drift0 | main355/487 직접4tests pass, I-30구현4/9·후속4·보류1 |
| I-26 | 계획 #301·조회 #307 병합 완료 | #301 f521a89·#307 d5979ca MERGED/열린자식0/자기브랜치정리. GET 비테스트157·독립 단위98/931·E2E14·root LOT20 pass, Minor1 보완 후 전부0. 발번1건 유보·마이그0 | main353/487 직접4 tests pass(+1) |
| I-27 | 계획 **#315 OPEN → main**, 독립3리뷰·R1~R16·root537줄 전건재독 완료 | 실제 반환315·`docs/coverage-100-b-i27-plan`·부모313 MERGED 뒤 main/OPEN 재지정검증. API82/UIUX94/통합70·CSV160/writer85/DB161 근거. 입력400/본문422·단말403 표현 정정. A9nullable6·정상5/프린터1유보/rendition1제외·번호승인미완 | 문서증분0·목표475/487·main직접357/487·실제구현0 |
| I-32 | 계획 #306·P0t #312·P1a #353·P1b #357·P2 #358·P3 #359 병합, P4 **#360** | 목록·상세·등록 구현3건과 물리/시간/쓰기규칙 준비 병합. #360은 수정1건, 설비→비가동 잠금·If-Match·선택4칸 생략/null·µs·멱등same tx·감사귀속을 E2E29로 검증. 새 재분류 정본에 따라 summary는 후속 서버결정, close만109 대기 | #360 후보 **378/487·4tests pass**, I-32 구현4/6·후속summary1·질의대기close1 |
| I-31 | 독립3리뷰·R1~R13 통합·全본문 재독 완료, 계획 **#309** 병합 완료 | #309 MERGED f85b0b2·열린자식0/mainFF/자기브랜치정리. API62/UIUX79/통합71줄·root832줄 재독. 마감/reset true만422·정상8유지·실제writer잠금·예산 정합. 문의113~116·기존문의 보강 | 문서 증분0·main353(선행 직접gate+이번source/test차이0), I-31 구현0/8 |
| I-33 | 독립3리뷰·root R1~R14·修正版808줄 전건재독·계획 #311 병합 완료 | MERGED2f846e4·열린자식0/mainFF/자기branch정리. API75/UIUX85/통합74·추가4/5/8+완화·T·실제writer잠금·기본CAL/확장분기·소비자 인수. 문의117~119·추가2단건 번호승인대기 | 계획증분0·정상12유지·실제구현0 |
