# 157. 수리 반출 뒤 «재투입» 등록처가 없어 `RepairExecution.reintroducedLotId` 가 영구 NULL 이다

> ⚠ **묻는 것이 아니라 알리는 것이다.** 계약이 이미 답을 적었고(⌜화면이 정해지기 전에는 늘 비어 있다⌝), 통합 정본이 이미 분류했으며(「본길이 아니라 **뒤 이야기**」), **같은 축의 문의 052 에 회신이 와 있다**(2026-09-08 · 「LOT 단위 정밀 추적은 1차에 필요 없다」). ⇒ 회신을 기다리지 않고 6/6 전건을 구현한다.
> ⚠ **I-21 의 처분 `REWORK` → 재작업 W/O 와 다른 경로다.** 둘을 섞으면 물음이 그대로 남는다(§ⓒ).

| 칸 | 내용 |
|---|---|
| **구분** | ⭐ **통보** — 계약에 없는 쓰기를 서버가 짓지 않는다. 그 결과 응답 칸 하나가 **영구 NULL** 로 남는다는 사실을 알린다. **회신을 기다리지 않는다** |
| 걸리는 오퍼레이션 | `POST /production/repair-executions/{repairExecutionId}:return` · `GET /production/repair-executions`(응답 `reintroducedLotId`) · ⛔ 계약에 **없는** 것: 재투입 등록 쓰기(계약이 후보 화면으로 `P-02-03`·`P-02-04` 를 적었다) |
| 구현 상태 | **구현 예정(I-25 · 계획 PR 만 · 오늘 코드 0줄)**. 계획서 `docs/coverage-100/slices/I-25.md` §0 자리 4 · §6 · §9-1 #13 |
| 판정 | `coverage-100/README.md` §2 **0단계에서 닫힌다** — 계약이 답을 «적었다»(⌜이 값을 실을 쓰기가 계약에 없다⌝). 갈림길이 아니므로 1단계·2단계로 내려가지 않는다. **1-1 로도 내려가지 않는다** — `plan-integration.md:424` 가 「**본길이 아니라 뒤 이야기**」라 분류했고, 미루는 자리가 **0**(6/6 전건 구현)이며, 질의의 정의는 「그 «자리만» 미룬다」다(`design-inquiries/README.md` §2 1-1 57·67행 · `lanes.md` §2-1 141행) |
| 되돌릴 때 | 재투입을 등록하는 오퍼레이션(또는 `:return` 본문에 `reintroducedLotId`)이 계약에 서면 **서비스 한 줄 + e2e 한 건**으로 열린다 — 물리 `repair_execution.reintroduced_lot_id` 는 **이미 실재하고 nullable** 이라 마이그레이션이 0이다. ⚠ **그 전에 지나간 수리 왕복은 소급되지 않는다**(합류는 현장에서 그 순간 일어난다) |

## 무엇이 문제인가

### ⓐ 계약이 값을 낼 자리는 열어 두고, 값을 넣을 자리는 열지 않았다

- 응답 스키마 `RepairExecution` 에 **`reintroducedLotId` 가 실재한다**(`[integer,null]` · required 밖 · `x-source-column: reintroduced_lot_id`). 물리 `production.repair_execution.reintroduced_lot_id` 도 **실재하고 nullable** 이다.
- 그런데 **그 값을 실을 쓰기가 계약에 0건**이다 — 계약이 그 사실을 스스로 적었다:

> ⌜⚠ 지금은 채워지지 않는다 — 이 값을 실을 쓰기가 계약에 없다(`:return` 본문은 `returnedAt`·`repairResultCode` 둘뿐이고 이 자원에 `PUT`·`PATCH` 가 없다).⌝

- `RepairExecutionReturn.required` = **`returnedAt`·`repairResultCode` 둘뿐**이고, 이 자원에 `put`/`patch` 가 **0**이다(계약 직접 파싱).
- `:return` 의 `x-internal-note` 가 이유까지 적었다:

> ⌜⭐ 재투입은 이 화면이 하지 않는다 — 수리된 물건은 **원 LOT 으로 돌아가지 않고** 그때 진행 중인 생산LOT 에 합류하며, 그 등록은 **P-02-03·P-02-04 가 후보다 — 아직 정해지지 않았다**(M-02-02 §5-4·§8-3 · 정본 미결 **02-SI1** · REQ-OA-0004).⌝
> ⌜**화면이 정해지기 전에는 `RepairExecution.reintroducedLotId` 가 늘 비어 있다.**⌝

⇒ **서버가 고를 것이 없다.** 값을 지어내면 계약에 없는 계보를 서버가 만드는 것이고, 그 링크는 어떤 화면도 만들지 않았다.

### ⓑ 그래서 잃는 것 — `repair_execution` → 합류 LOT 의 **역참조 하나**

수리 왕복 자체는 전부 남는다: 원 불량(`defect_record_id`) · 투입/반출 시각 · 수량 · 결과 코드 · 투입자 사번 · 단말. **끊기는 것은 「이 수리분이 어느 생산LOT 에 합류했는가」 한 줄**이다.

⚠ **그 한 줄은 소급이 안 된다** — 합류는 현장에서 그 순간 일어나고, 계약이 「**원 LOT 으로 돌아가지 «않는다»**」라 못 박았으므로 `defect_record` 로도 거꾸로 풀 수 없다.

### ⓒ ⭐ I-21 의 처분 `REWORK` 와 **다른 경로다**

`plan-integration.md:389`(§I-21) — 「부적합 → 처분(**REWORK**·SCRAP·NORMAL) → 각각 다른 하류로 갈린다 … **REWORK 은 I-6 의 재작업 W/O 를 부른다**」.

「불량품을 고쳐서 되돌린다」의 **다른 경로**가 레인 A 의 I-21 에 이미 서 있다. 두 경로는 물리·마이그가 갈라져 있고(I-21 의 마이그는 `mdm.code_value`·`disposition_decision`·`nonconformance_lot` 셋뿐 · `plan.md` §4) 앞지름이 없다.

⛔ **그러나 「REWORK 처분으로 재작업 W/O 를 내면 된다」는 이 물음의 답이 아니다.** 이쪽은 **`repair_execution` 왕복(M-02-02)** 이고, 채울 칸은 `repair_execution.reintroduced_lot_id` 다 — 재작업 W/O 를 내도 그 칸은 여전히 빈다.

### ⓓ 덤 — `plan-uiux.md` U26 의 화면 열에 붙은 `P-02-03,P-02-04` 는 **`:return` 의 호출자가 아니다**

`plan-uiux.md` §5-1(725~739행)이 밝히듯 화면 대응은 계약 `description`·`x-internal-note` 를 정규식으로 긁어 만들었다. `:return` 행의 `P-02-03`·`P-02-04` 는 위 ⓐ 인용문 — 즉 **「재투입 «등록»의 후보 화면」** 문맥에서 나온 것이고, `:return` 을 부르는 화면이 아니다. (같은 이유로 `POST /operation-handovers` 행의 `M-02-02` 도 오탐으로 보인다 — 그쪽 계약 근거는 「M-02-01 §1·§6」 하나다.)

## 지금 서버는

- **아직 없다.** 계획이 정한 동작: `repair_execution.reintroduced_lot_id` 를 **한 번도 쓰지 않는다**(투입 INSERT 에서 NULL · `:return` UPDATE 는 `returned_at`·`repair_result_code` 둘만 건드린다). 응답은 `plan.md` §5 규칙 7(값 없는 칸은 키 생략)에 따라 **`reintroducedLotId` 키를 아예 내지 않는다**.
- `trace.lot_relation`·`lot_lifecycle_history` 를 **만들지 않는다** — 계약에 축이 0이고, 문의 **052 회신**(「LOT 단위 정밀 추적은 1차에 필요 없다 · `lot_relation` 0행 유지 · 추가 구현 없음」)과 같은 방향이다.
- 6 오퍼레이션은 **전건 구현한다** — 이 결손 때문에 미루는 자리가 하나도 없다.

⇒ **알리는 것**: 1차에서 「수리분이 어느 생산LOT 에 합류했는가」가 **기록되지 않는다**. 그 등록처(P-02-03·P-02-04 중 어디인지, 혹은 `:return` 본문 확장인지)가 정해지면 그때 **새 슬라이스**로 선다. 정해지기 전에 지나간 왕복은 **소급되지 않는다**.

흔적: `docs/coverage-100/slices/I-25.md` §0 자리 4 · **§0-재수립 R-1** · §6-1 · §9-1 #13 · §9-2 · §11-1 #1 · `I-25-review-api.md` M-1 · `I-25-review-uiux.md` §2-3 · `I-25-review-integration.md` M-1·M-2·m-3 · `contracts/production-02생산실행.json`(`RepairExecution.reintroducedLotId` · `:return` `x-internal-note`) · `docs/coverage-100/plan.md:230` · `plan-integration.md:389`·**`:424`** · `plan-uiux.md:1210`·`:725-739` · `docs/design-inquiries/052-*.md`(✅ 회신 2026-09-08) · `design-inquiries/README.md` §2 1-1 · `lanes.md` §2-1.
