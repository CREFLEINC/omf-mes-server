# I-25 재수립 — 독립 리뷰 **① API 설계**

> 대상: `.backend-dev/lane-a2/I-25-draft.md` **592줄 전문**. 브리프: `brief-I-25-review.md` §3 「API 설계」.
> 계약 사본 `contracts/COMMIT.txt` = `a6a87e144116ebaa32c01df5a12a0fd2924427e7` ✅ 실측 일치 · **읽기 전용으로만 다뤘다**.
> ⛔ `I-25-review-uiux.md`·`-integration.md` **열지 않았다**. ⛔ 코드·계약·문서 수정 0 · DB 쓰기 0 · `git`/`gh` 쓰기 0 · `pnpm exec` 0 · 게이트 재실행 0.
> 관측: `docker exec omf-mes-lane-a2-postgres psql -U omf_lane_a2 -d omf_mes_lane_a2 -X -c "<SELECT>"` **SELECT 3회만**.

---

## 1. 무엇을 직접 읽었나 (인용을 믿지 않았다)

### 1-1. 계약 — python 으로 직접 파싱

| 무엇 | 결과 |
|---|---|
| `production-02생산실행.json` 전체 | **37 path · 53 오퍼레이션** ✅ 초안 부록 #1 과 일치 |
| I-25 4 path / **6 오퍼레이션** | `/production/operation-handovers`{get,post} · `…/{operationHandoverId}`{get} · `/production/repair-executions`{get,post} · `…/{repairExecutionId}:return`{post} ✅ |
| `components.parameters` | `IdempotencyKey`(required **true**) · `IfMatchVersionOptional`(required **false**) · `WorkerNo`(required **true**) · `IfMatchVersion`(required true — 이 슬라이스 미사용) |
| `components.schemas` | `OperationHandover` · `OperationHandoverCreate` · `OperationHandoverLine` · `RepairExecution` · `RepairExecutionCreate` · `RepairExecutionReturn` · `RepairExecutionList` · `ProductionConflictResponse` · `PageMeta` · `ErrorResponse` 전문 |
| `x-no-code-key` · `x-internal-note` 4자리 | **전문**(POST /operation-handovers · POST /repair-executions · `:return` · `IdempotencyKey`) |

### 1-2. 소스 — 초안이 인용한 자리를 **한 줄씩 열었다**

| 초안 인용 | 실측 | 판정 |
|---|---|:-:|
| `work-order-release.service.ts:91` (`default_wip_location_id` 를 WIP 도착 위치로) | `const destination = plan.row.default_wip_location_id;` | ✅ |
| ↑ 그 **다음 줄** `:92-93` | `if (plan.issueRequestNo !== null && destination !== null) {…}` — **NULL 이면 건너뛴다(거부하지 않는다)** | ⚠ 초안 미인용 |
| `release-plan.ts:113` (계약이 적은 밖은 지어내는 것) | 정확히 그 줄 | ✅ |
| `work-session-query.service.ts:46-56` (`open` 여집합) | `:46` 주석 · `:56` `ended_at: open ? null : { not: null }` | ✅ |
| `work-session-query.service.ts:33-35` (**반대 선례** PK 역순) | `WORK_SESSION_ORDER_BY = [{ work_session_id: 'desc' }]` | ✅ |
| `material-return-query.service.ts:24-28` (시각 desc + PK desc · 동률은 PK 로 닫는다) | 정확히 그 줄 | ✅ |
| `material-return-query.service.ts:38-41`(반개구간) · `:45`(`statusCode` 문자 그대로) | 정확 | ✅ |
| `material-return-query.service.ts:55-57`(목록에도 라인) | ⭐ 주석은 **`:50-51`**, `include` 는 `:57` | ⚠ 줄 표기만 어긋남 |
| `work-session.service.ts:61-64` (`OPEN_SESSION_EXISTS` 409) | 정확 | ✅ |
| `work-session.service.ts:181-188` (`assertWorkerNo` · REQUIRED/INVALID) | 정확(`:180` 「다섯째 사본」) | ✅ |
| `work-session-end.service.ts:38-50`·`:79-88` (`FOR UPDATE` · CHECK 앞당김) | `lockSession` `:78-85` · 앞당김 `:49-51` | ✅ 실질 일치 |
| `terminal-token.ts:26-42` (헤더 없으면 `null`) | `:28 return null` · `:30·35·41 throw invalidToken()` | ✅ |
| `material-consumption.service.ts:80-82` (채번은 tx 밖) · `production-result.service.ts:79-82`(`plantId=null`) | 정확 | ✅ |
| `master-write.ts:58-60` (`runVersioned` 가 If-Match 없으면 던진다) | `:57-60` | ✅ |
| `idempotency.service.ts:45-48` `FAMILY_CONFLICT_CODE` | `{duplicate:'DUPLICATE_KEY', inProgress:'INVALID_STATE'}` | ✅ |
| `conflict.exception.ts:44-50` | `ConflictException(conflictCause, message, extra)` | ✅ |
| `pagination.ts:13-14`·`:44-45` (`MAX_SIZE=200` · 자른다) | 정확 | ✅ |
| `contract-validator.ts:125` · `contract-validator.spec.ts:61-63` (ajv 가 여분 칸을 안 막는다) | 정확 | ✅ |
| `derived-permissions.ts:112·230·235·236` | `GET /production/repair-executions`·`POST /production/operation-handovers`·`POST /production/repair-executions`·`…:return` | ✅ **네 줄 다 정확** |
| `permission.guard.ts:37-41` (계약이 403 선언한 자리에서만) | `:37-40` 주석 · `:41 if (!this.declaresForbidden(key)) return true;` | ✅ |
| `numbering.service.ts` `DEFAULT_PREFIX` 에 `OPERATION_HANDOVER` 없음 | ✅ 없다. `OH` 접두어 충돌도 **없다** | ✅ |
| ↑ 「**15개** 등재」 | 실측 **19개**(`:9-47`) | ❌ **틀렸다** |
| `plan.md:83`(전개분은 NULL) · `:48행`(PR **2**) · `§5 규칙 9` 목록에 `:request-iqc-skip` **없다** | 전건 정확 — 규칙 9 예외는 **열째까지**다 | ✅ |
| `plan-api.md:411~444` §S16 · `:437·442·443` · `:1117` 채번 표 | 전건 정확 | ✅ |
| `plan-integration.md:421~426` §I-25 | 정확. ⭐ **`:424` 에 초안이 안 옮긴 문장이 있다**(§3 M-1) | ⚠ |
| `lanes.md` §1-1(A2 = 150~179) · §3(질의만 선전달) · §1-4 | 정확 | ✅ |
| 문의 번호 실재 150·151·152·**154**·155·156 (153 결번) ⇒ 다음 **157** | 정확 | ✅ |
| `assignment.tsv` `$1=="I-25"` = **6행** | 정확 | ✅ |

### 1-3. 물리 — `schema.prisma` + DB `SELECT`(권한 범위 안)

```
information_schema.columns  →  operation_handover 12 · operation_handover_line 11 · repair_execution 13
pg_constraint (contype='c') →  CHECK 8건 — 초안 §2 표와 이름·정의 전건 일치 ✅
pg_indexes                  →  초안 §2 인덱스 표와 전건 일치 ✅
                               (ix_repair_execution_open = (started_at DESC) WHERE returned_at IS NULL)
production.work_order       →  0행(총 0 · WIP 위치 채워진 것 0) — 자리 1 의 400 빈도는 실측 불가
```

---

## 2. §0 다섯 판정 (API 설계 축)

| # | 자리 | 판정 | 근거 |
|:-:|---|---|---|
| **1** | 인계 라인 위치 두 칸 | **조건부 PASS** | 축 ⓐ 는 맞다 · 400 갈래의 «대가»를 초안이 축소해 적었다 |
| **2** | 계약 밖 칸 넷 | **PASS**(ⓓ 포함) | 넷 다 계약 위반 아님 · ⓓ 는 API 로 관측 불가라 되돌림 비용 0 |
| **3** | 구간형 `repair_execution` ⓒⓓ | **PASS** | 계약 문자와 **정확히** 맞는다. ⓓ 표의 ⑸ 한 줄만 사실이 아니다 |
| **4** | 재투입 LOT | **구현 PASS · 「질의」 판정은 뒤집는다 → 통보** | README §2 절차상 성립하지 않는다 |
| **5** | PR 3 · 파일 배치 | **PASS**(API 축에서 이견 없음) | 예산 산술 검산 통과 · 공용 파일 실측 일치. 최종 판정은 통합 관점 |

### 자리 1 — 「계약이 안 준 칸을 서버가 채우는 것」은 **계약 위반이 아니다**

계약 `POST /production/operation-handovers` 의 `x-internal-note` **원문**:

> `operation_handover_line.source_location_id·destination_location_id 는 NOT NULL 이지만 화면이 고르지 않는다 — 서버가 채운다. 무엇으로 채우는지는 미확정(미결-대장 277 · M-02-01 §8-1 라인사이드 위치 체계). 위치 체계가 정해지면 그때 필드로 올린다.`

- **서버가 채우는 것은 계약이 «시킨» 일이다.** 위반 아님. ✅
- **축 선택 ⓐ 도 맞다** — `work_order` 의 위치 칸은 셋(`default_wip_location_id`·`default_fg_location_id`·`default_scrap_location_id`)뿐이고 WIP 인계에 맞는 것은 하나다. `production_line_id`(nullable)로 라인사이드를 푸는 다섯째 후보는 계약이 「미확정」이라 못 박은 바로 그 체계라 **지어내면 안 된다**. ⇒ 초안의 후보 넷 밖에 더 나은 선이 없다. ✅
- **400 갈래도 규칙상 옳다** — README §2 2단계 **기준 2**(거부하는 쪽 · 거부→허용은 호환 완화). ✅
- ⚠ **그런데 초안이 두 가지를 빠뜨렸다** — §3 m-1·m-2.
- ⭐ 계약 마지막 문장 **「위치 체계가 정해지면 그때 필드로 올린다」**는 초안이 안 옮겼는데, 이것이 **「통보이지 질의가 아니다」를 계약 스스로 뒷받침하는 문장**이다. 통보 158 에 실려야 한다.

### 자리 2 — 넷 다 PASS · ⓓ 도 뒤집지 않는다

| | 계약이 뭐라 했나(실측 원문) | 판정 |
|:-:|---|---|
| ⓐ `status_code` | `required` 6에 `statusCode` 포함 + `x-no-code-key` ⌜코드 그룹을 세우지 않는다 … 전이가 0개다⌝ | 상수 강제. 선례 `CONSUMPTION_STATUS='RECORDED'`·`RESULT_STATUS='CONFIRMED'` **둘 다 실재 확인**. **PASS** |
| ⓑ `handover_no` | `required` + `example: "값"` + 형식 선언 0 · `plan-api.md:1117` 「규칙 ❌ · 형식 —」 | 서버 채번 강제. `OH` 접두어 미사용 확인. **PASS** |
| ⓒ `line_no` | 계약에 칸 0 | 1..N. **PASS**(선례는 초안이 든 `work-session.service.ts:68`(부모 잠금 뒤 max+1)보다 **`material-return.service.ts:90` `line_no: index + 1`** 이 같은 모양이다 — n-3) |
| ⓓ `received_qty` | `x-internal-note` ⌜화면을 따라 인계 확정 시 **두 시각을 함께 찍는다**⌝ — **수량은 한 글자도 없다** | **PASS.** 결정적 근거: 이 칸은 **어느 응답에도 나오지 않는다**(`OperationHandover`·`OperationHandoverLine` 프로퍼티 전수 확인). ⇒ 어느 값을 넣어도 **API 로는 관측 불가**하고, `handover_qty` 가 남아 있어 **나중에 결정적으로 back-fill 된다**. 「바꾸는 비용 낮다」가 확정적이므로 **통보가 맞다** |

⭐ 다만 초안이 `statusCode` 의 `x-no-code-key` 를 **두 번 인용하면서 두 번 다 마지막 문장을 잘라냈다**(§3 m-3).

### 자리 3 ⓒⓓ — 계약과 **정확히** 맞는다

- **ⓒ 409** — 계약 `POST /production/repair-executions` 의 409 description 원문 ⌜충돌 — **같은 불량에 열린 수리 건이 이미 있다**⌝ · `ProductionConflictResponse.code` enum 5값에 `OPEN_SESSION_EXISTS` 실재 · 그 설명이 ⌜열린 구간이 이미 있다는 뜻⌝ · `ERROR_CODE.OPEN_SESSION_EXISTS`(`error-codes.ts:71`) 실재 · 선례 `work-session.service.ts:61-64`. **판정 축을 `defect_record_id` + `returned_at IS NULL` 로 잡은 것까지 계약 문자 그대로다. PASS.**
- **ⓓ `:return` 재호출** — 계약 선언 **200 · 400 · 404 · 409**(403 없음 ✅ `plan-api.md:443` 과도 일치).
  - ⑴ 같은 키·같은 본문 → **200 재생** ✅ (`idempotency.service.ts:185-190`)
  - ⑵ 같은 키·다른 본문 → **409 `DUPLICATE_KEY` · conflictCause `'user'`** ✅ (`:159-168`)
  - ⑶ 다른 키·이미 반출 → **409 `INVALID_STATE`** ✅ 계약 409 원문 ⌜충돌 — 이미 반출됐다⌝ 와 정확히 대응.
    ⭐ **선례와 갈리는 것을 초안이 옳게 처리했다** — `work-session-end.service.ts:44-47` 은 같은 상황을 **400 `STATE_LOCKED`** 로 낸다. 이쪽을 409 로 가른 것은 «계약이 409 를 선언했기 때문»이고, 그것이 맞다.
    ⭐ **`INVALID_STATE` 의 두 뜻이 충돌하지 않는 것도 확인했다** — `idempotency.service.ts:39-43` 이 「`code` 가 아니라 `conflictCause` 가 가른다」고 못 박았고, 멱등 in-progress 는 `'workerLease'`(`:180`), 업무 거부는 `'user'` 다. **갈린다. PASS.**
  - ⑷ 없는 id → **404** ✅ (`FOR UPDATE` 0행)
  - ⑸ **72시간 뒤 재전송** → ❌ **사실이 아니다**(§3 m-4).
  - ⭐ **추가 확인** — 같은 키를 «다른 `repairExecutionId`»에 재사용하면? `runIdempotent` 의 지문이 `${request.method} ${request.path}`(**구체 경로**, `master-write.ts:37`)라 지문이 갈려 **409 `DUPLICATE_KEY`** 다. 조용한 오배송 없음. **안전.**

### 자리 4 — 구현은 PASS · **문의 구분은 뒤집는다**

계약 `RepairExecution.reintroducedLotId` description 원문(초안 인용과 **글자 그대로 일치**):

> `⚠ 지금은 채워지지 않는다 — 이 값을 실을 쓰기가 계약에 없다(:return 본문은 returnedAt·repairResultCode 둘뿐이고 이 자원에 PUT·PATCH 가 없다).`

`RepairExecutionReturn.required` = `returnedAt`·`repairResultCode` **둘뿐** ✅ · 이 자원에 `put`/`patch` **0** ✅ · `reintroducedLotId` 는 응답에만 있고 어느 요청 스키마에도 없다 ✅
⇒ **영구 NULL 은 유일한 구현이다. PASS.** 「질의」 판정은 §3 **M-1**.

### 자리 5 — API 축 검산 (판정은 통합 관점 몫)

- 예산 산술 재계산: ① `55+75+40+45+70+28+10 = 323` ✅ · ②+③ `220+218 = 438`(초안 433, 공용분 상쇄 감안 타당) · 자원 축 인계 `55+75+70+175+10+1 = 386`(초안 385) · 수리 `45+70+46+110+75+10 = 356`(초안 356) ✅ **「둘 다 350 초과」는 사실이다.**
- 공용 파일 실측 ✅ — `manual-permissions.ts` **0줄이 맞다**: 계약이 403 을 선언한 둘(`POST /operation-handovers`·`POST /repair-executions`)이 `derived-permissions.ts:230`·`:235` 에 실재하고, 403 미선언인 두 인계 GET 은 `permission.guard.ts:41` 이 **표를 보지도 않는다**(등재 누락이 500 을 내지 않는다). ✅
- `error-codes.ts` **0줄** ✅ — 쓰는 코드 전건(`REQUIRED`·`RANGE`·`INVALID`·`PERMISSION_DENIED`·`OPEN_SESSION_EXISTS`)이 이미 있고, `DUPLICATE_KEY`·`INVALID_STATE` 는 `FamilyConflictCode` 타입 값이라 `ERROR_CODE` 에 넣을 것이 아니다. **새 `ERROR_CODE` 0 — 확인.**

### ⭐ 마이그레이션 0 — **결론은 맞다. 대조표의 숫자는 넷 다 틀렸다**

계약 칸 ↔ 물리 칸을 **한 줄씩 다시 대조했다**(초안을 안 보고 독립으로).

| 계약 스키마 | 계약 칸 | 물리 대응 | 결손 |
|---|:-:|---|:-:|
| `OperationHandover` | 8 | `operation_handover_id`·`handover_no`·`from_work_order_id`·`to_work_order_id`·`status_code`·`handed_over_at`·`received_at` + `lines`→자식표 | **0** |
| `OperationHandoverLine` | 4 | `operation_handover_line_id`·**`source_lot_id`**(이름 다름)·`handover_qty`·`uom_id` | **0** |
| `RepairExecution` | **11** | `x-source-column` 11개 전건 실재(`repair_execution_id`…`worker_no`) | **0** |

⇒ **마이그 0 결론 PASS · `schema.prisma` 0줄 PASS.** 다만 초안이 적은 **칸 수 넷이 전부 틀렸다** — §3 m-5.

### ⭐ 문의 157 「질의」 판정 — **선다고 볼 수 없다**(§3 M-1)

---

## 3. Findings

> 심각도: CREFLE `pr-review` 4단계. **Blocker 0 · Major 2 · Minor 5 · Nit 4.**

### 🔴 Major

#### M-1. 문의 157 을 「질의」로 판정한 것이 **README §2 절차상 성립하지 않는다** — 「통보」로 뒤집는다

**초안**: §0 자리 4 · §9-1 #13 · §9-2 「157 · ⭐ **질의**」 · §10-1 #1 「질의 157 … **미루는 자리가 0**이다 — 6/6 전건을 구현한다」.

세 곳이 서로를 부순다.

1. **§2 절차는 «갈림길»에만 적용된다.** 0단계(선례 — 계약 본문)에서 답이 나오면 거기서 닫힌다. 계약은 침묵하지 않았다 — `reintroducedLotId` description 이 ⌜지금은 채워지지 않는다 — 이 값을 실을 쓰기가 계약에 없다⌝, `:return` 의 `x-internal-note` 가 ⌜**화면이 정해지기 전에는 `RepairExecution.reintroducedLotId` 가 늘 비어 있다**⌝ 라고 **답을 적었다**. 1단계·1-1단계에 내려갈 입구가 없다.
   **초안 자신이 §9-1 #13 에 「⛔ 갈림길이 «아니다» — 구현은 0단계에서 닫힌다」라고 적어 놓고 같은 행에서 질의로 보냈다.**
2. **`lanes.md` §2-1 이 질의를 정의한다** — 「⭐ **질의** — 그 «자리만» 미루고 나머지는 진행」. **미루는 자리가 0이면 질의가 아니다.** 초안의 §10-1 #1 이 그 모순을 그대로 문장으로 쓰고 있다.
3. **통합 계획서가 이미 이 자리를 분류해 놓았다.** `plan-integration.md:424` **원문** — ⌜수리된 물건이 «어느 LOT 으로 돌아가는가»는 계약이 「아직 정해지지 않았다」라 적었다(M-02-02 §8-3) → **본길이 아니라 뒤 이야기**이므로 그대로 두고 **요청서에 싣는다**⌝. **「본길이 아니다」**는 1-1단계 진입 자체를 부정한다. 초안은 §I-25 를 인용하면서 앞 두 문장(가지·원장 없음)만 옮기고 **이 문장을 옮기지 않았다.**

**실패 예** — 초안대로 가면: A2 가 `lanes.md` §3 마지막 항목을 근거로 사용자에게 「질의 157 을 설계팀에 먼저 보내 달라」고 한 줄 보고 → 사용자가 설계팀에 전달 → 설계팀은 **자기들이 이미 열어 둔 자기 항목**(M-02-02 §8-3 · 정본 미결 02-SI1 · REQ-OA-0004)을 되받는다. 계약이 후보 화면(`P-02-03`·`P-02-04`)까지 이미 적어 두었으므로 물어서 새로 얻는 것이 없고, 이 슬라이스는 6/6 을 그대로 구현하므로 **회신이 와도 바뀌는 코드가 0**이다. 남는 것은 선전달 비용뿐이다.

**고칠 것**(초안 자신이 「뒤집히면」 열에 적어 둔 그대로다 — 구현 변화 0):
- §9-2 157 의 구분 `질의 → **통보**` · 제목은 그대로 두어도 된다.
- 흔적 표기 `// 설계 미정 — 문의 157` → **`// 결정 — 통보 157`**(`lanes.md` §2-1).
- §10-1 #1 의 「회신을 기다리는 것이 아니라 미루는 자리가 0」 → 통보의 정의와 같아지므로 문장 자체가 필요 없다.
- §0 자리 4 「⇒ `lanes.md` §3 에 따라 사용자에게 한 줄 보고(질의만 먼저 보낼 수 있다)」 **삭제** — 루틴 끝 일괄로 간다.
- `plan.md` §7 230행 이행 표기는 「**통보 157 로 발행**」(같은 표의 선례가 「통보 089 로 발행」·「050 으로 발행」·「055 로 발행」 셋이다 — 통보로도 이행된다).
- ⇒ **신규 5건 = 질의 0 · 통보 5**(157~161). 마이그·PR 분할·e2e·예산 **변화 0**.

#### M-2. `POST /production/repair-executions` 의 **403 을 지켜보는 단언이 0건**이다 — 쌍둥이 오퍼레이션에는 있는데

**실측**: 계약이 이 오퍼레이션에 **403 을 선언**했다(`"403": {"description": "단말·권한 게이팅에 막혔다"}`) · `derived-permissions.ts:235` = `['M-02-02']` · `permission.guard.ts:41` 이 **실제로 본다**(선언한 자리이므로).
그런데 §7-3 **B1~B17 전수에 403 단언이 없다.** 같은 문서 §7-2 **A16** 은 인계 쪽 403 을 **「반증 가능하다」고 콕 집어** 세워 두었다. 비대칭이 근거 없이 생겼다.

**실패 예**: 구현자가 `derived-permissions.ts:235` 를 `['M-02-02']` → `['M-02-01']`(오타·복붙)로 바꾼다.
→ `M-02-01`(인계) 권한만 가진 계정이 **수리 투입을 등록할 수 있게 된다**. `M-02-02` 만 가진 정당한 수리 담당자는 **403 으로 막힌다**.
→ B1~B17 · A1~A16 · 단위 spec 14 **전부 초록**. (엔트리를 «지우는» 변이는 가드가 500 을 내 B8 이 잡지만, **값을 바꾸는** 변이는 아무도 못 본다.)
→ 초안 §7-5 「전수 변이 점검」의 대상 목록에도 권한 표가 없어 그 그물도 안 걸린다.

**고칠 것**: §7-3 에 **B18** 을 더한다 — 「`M-02-02` 미보유 계정으로 `POST /production/repair-executions` → **403**」. A16 과 같은 픽스처 방식이면 되고 **반증 가능**하다(계약이 403 을 선언한 자리라 가드가 실제로 돈다 — ⓖ 의 `:return`·조회와 다르다). 예산 +6줄, PR ③.
⛔ `:return` 과 `GET /repair-executions` 에는 **더하지 마라** — 초안 ⓖ 판정이 옳다(계약 미선언 ⇒ 가드가 통과시킨다 ⇒ 반증 불가).

### 🟡 Minor

#### m-1. 자리 1 의 근거 `work-order-release.service.ts:91` 이 **한 줄 짜리 인용**이다 — 바로 다음 줄이 반대 정책이다

초안 §0 자리 1 ⓐ-1: 「`:91` 이 `default_wip_location_id` 를 「이 W/O 의 WIP 도착 위치」로 삼아 **출고요청을 만든다**」. `:91` 은 맞다. 그러나 `:92`:

```
const destination = plan.row.default_wip_location_id;          // :91
if (plan.issueRequestNo !== null && destination !== null) {    // :92  ← NULL 이면 «건너뛴다»
```

`release-plan.ts:101` 도 같다(`row.default_wip_location_id === null` 이면 BOM 전개를 **빈 배열로 돌린다**).
⇒ **이 칸에 대한 저장소의 유일한 선례는 NULL 을 «정상으로 허용하고 조용히 건너뛰는» 것**이다. 초안은 그 선례를 「축이 같다」는 근거로만 쓰고 **NULL 정책이 반대라는 사실은 안 적었다.**

**실패 예**: 리뷰어(또는 설계팀)가 통보 158 을 읽고 「선례도 이 칸을 쓰니 400 도 선례를 따른 것」이라고 읽는다. 실제로는 정반대다 — 이 슬라이스가 **저장소에서 처음으로** 이 칸의 NULL 을 «거부»한다.

**고칠 것**: §0 자리 1 ⓐ-1 과 §4-2 에 `:92-93` 을 함께 적고, 「NOT NULL 자식 칸이라 건너뛸 수가 없다 ⇒ 선례와 갈린다」를 **명시**한다(결론은 안 바뀐다 — 기준 2 가 맞다).

#### m-2. 통보 158 이 **400 의 업무적 대가**를 적지 않았다

초안 §0 자리 1 과 §9-2 158 은 「못 풀면 400」과 「나중에 결정적 재계산 가능」만 적었다. 빠진 사실:

- `plan.md:83` 이 「계획 **전개분은 NULL**」이라 했고, `work_order.default_wip_location_id` 는 **W/O `PUT` 로만 채워진다**(M2 체인 e2e 가 `:release` 앞에 그 걸음을 따로 둔 이유다).
- ⇒ **그 `PUT` 을 안 거친 W/O 쌍에서는 `POST /production/operation-handovers` 가 «영구히» 400 이다.** 인계 화면(M-02-01)은 POP 단말이고 **W/O 기본 위치를 고칠 수단이 없다** — 계약 400 의 문구 ⌜검증 실패. **고쳐야 풀린다**⌝ 를 현장 작업자가 이행할 수 없다.
- DB 실측: `production.work_order` **0행**이라 실제 빈도는 **측정 불가**(§4 미수행).

**실패 예**: 하노이에서 전개분 W/O 로 공정 인계를 시도 → 400 `INVALID` `fromWorkOrderId` → 작업자는 자기가 보낸 값이 멀쩡한데 왜 막히는지 알 수 없고, 화면에서 풀 방법이 없다.
**고칠 것**: 통보 158 에 이 한 문장을 싣는다 — 「기본 WIP 위치가 없는 W/O 는 인계를 «전혀» 기록할 수 없다. 라인사이드 위치 체계가 정해지기 전까지 운영은 W/O `PUT` 로 그 칸을 채워 두어야 한다.」 인계 표(§10-1)에도 한 줄.

#### m-3. 계약 `x-no-code-key` 의 **마지막 문장을 두 번 다 잘랐다** — 그 문장이 `received_qty` 논쟁의 계약 근거다

`OperationHandover.statusCode.x-no-code-key` **원문 전체**:

> `코드 그룹을 세우지 않는다 — 계약이 인계·인수를 «한 행위»로 접어 (receivedAt 을 같은 시각에 찍는다) 전이가 0개다. 구간 형 리소스로 handedOverAt ↔ receivedAt 의 유무로 판정한다.` **`⚠ M-02-01 §8 미결 2 는 그 접기 자체를 열어 두었다 — 축이 갈리면 그때 다시 본다.`**

초안은 §0 자리 2 ⓐ 와 §1-5 에서 이것을 인용하며 **굵은 부분을 두 번 다 뺐다**. 그 문장이 말하는 것: **계약 스스로 「인계=인수 접기」가 미결이라고 적어 두었다.** 그리고 `received_qty`·`received_at` 은 정확히 그 접기 위에 있는 칸이다.

**실패 예**: 통보 159 가 「`received_qty` 를 0 으로 둔다 — 계약 x-internal-note 가 시각만 적었다」로만 나간다 → 설계팀은 이것을 **구현팀의 임의 선택**으로 읽는다. 실제로는 계약이 「이 접기 자체가 미결이니 축이 갈리면 다시 본다」고 예고해 둔 자리이고, 그 예고를 인용하면 통보의 성격이 「우리 결정」에서 「계약이 예고한 자리에 대한 보고」로 바뀐다.
**고칠 것**: 통보 159 에 이 문장을 **원문으로** 싣는다. 통보 158 에는 마찬가지로 계약이 잘라먹힌 「**위치 체계가 정해지면 그때 필드로 올린다**」를 싣는다 — 이것이 「소급 불가가 아니다 ⇒ 통보」의 계약 측 근거다.

#### m-4. §6-2 ⑸ 「72시간 뒤 재전송」은 **일어나지 않는 일**이다 — 통보 161 에 사실로 실린다

**실측**: `RETENTION_HOURS = 72` 는 `expires_at` 을 **쓰기만** 한다(`idempotency.service.ts:13`·`:125`). `grep -rn RETENTION_HOURS src` = **그 두 줄뿐** · `idempotency_record` 를 지우는 코드는 `src/` 전체에 **0건**(테스트의 `deleteMany` 는 픽스처 정리다). **만료 청소기가 없다.**
⇒ 72시간이 지나도 기록은 남아 있고, 같은 키·같은 지문이면 `replay()` 가 **200 을 재생**한다. 초안이 적은 「409 `INVALID_STATE`(⑶과 같아진다)」가 **아니다**.

**실패 예**: 통보 161 이 설계팀에 「`repair_execution` 에 `idempotency_key` 칸이 없어 72시간 뒤 재전송의 둘째 그물이 구간 판정뿐이다」로 나간다 → 설계팀이 **현재 시스템에 존재하지 않는 만료 시나리오**를 검토한다. 「알려둘 것」 ⓕ 도 같은 전제 위에 서 있다.
**고칠 것**: §6-2 ⑸ 를 지우거나 「⚠ 오늘은 만료 청소기가 없어 도달하지 않는다 — `expires_at` 은 기록만 된다」로 고친다. 통보 161 의 셋째 항목도 같이 고친다. ⓕ 는 「이 두 표에 `idempotency_key` 칸이 없다」까지만 사실이다(그 부분은 실측 확인 ✅).

#### m-5. **칸 수 네 개가 전부 틀렸다** — 마이그 0 의 대조표와 e2e 단언 하나

| 자리 | 초안 | 실측(`information_schema.columns` · `schema.prisma`) |
|---|:-:|:-:|
| `production.operation_handover` | **13** | **12** |
| `production.operation_handover_line` | **10** | **11**(그래서 「물리가 6칸 더 넓다」도 **7칸**이다) |
| `production.repair_execution` | **14** | **13** |
| 계약 `RepairExecution` 프로퍼티 | **12** | **11** |
| `DEFAULT_PREFIX` 등재 수(부록 #16) | **15** | **19** |

⚠ 초안의 **행 나열은 전부 맞다** — 틀린 것은 머리의 합계뿐이다(§1-4 두 표의 행을 세면 12·11 이 나온다). 그래서 **마이그 0 결론 자체는 흔들리지 않는다**(내가 독립으로 재대조해 확인했다 · §2).
**실패 예**: §7-3 **B1** 이 「키 집합 **12칸**」을 지켜보라고 적었다 → 구현자가 12개짜리 배열로 `Object.keys(row).sort()` 를 단언 → 계약 프로퍼티가 11개인 데다 널 6칸을 키 생략하므로 **첫 실행부터 RED**. 즉시 드러나지만, 「지켜보는 단언」의 값이 계획서에서 틀려 있으면 구현자가 계약 대신 계획서를 믿는 순간 그물이 헐거워진다.
**고칠 것**: §1-4 세 표의 머리 숫자, §2 대조표, §7-1 ⓐ②(「물리 10칸 중」), §7-3 B1(「12칸」), 부록 #16 을 정정한다.

### 🔵 Nit

- **n-1. GET 두 목록의 400 은 계약이 «선언하지 않은 응답»이다.** `GET /production/operation-handovers`·`GET /production/repair-executions` 는 **200 하나만** 선언한다(초안 §1-1 이 그렇게 적었다 ✅). 그런데 §7-3 **B6** 이 같은 오퍼레이션에서 `size=201 → 400`·`page=0 → 400` 을 단언하고, §3-1 이 `numeric()` 으로 400 을 낸다. 검증기는 실제로 그렇게 동작한다(`contract-validation.guard.ts:39-42` 가 질의 파라미터를 계약 스키마로 검증하고 `ContractException(400)` 을 던진다 — `parameterSchema()` 로 `minimum`/`maximum` 이 그대로 들어간다 ✅ 초안의 A6/B6 갈림은 **사실이다**). 계약이 `maximum: 200` 을 적어 놓고 400 을 선언하지 않은 것은 **계약 쪽 흠**이고 저장소 전역 동작이라 이 슬라이스가 만든 문제가 아니다. 다만 §1-1 표(「선언 응답 200」)와 §7-3 B6 이 **한 문서 안에서 어긋난 채**로 남는다 ⇒ 통보 160 에 한 줄로 싣기를 권한다.
- **n-2. `numeric()` 의 이유가 이 슬라이스에서는 절반만 맞다.** 초안 §3-1 「숫자 축의 글자를 400 으로 막는다 — 안 막으면 Prisma 검증 오류가 500 으로 샌다」. 실측: 질의용 ajv 는 `coerceTypes: true`(`contract-validator.ts:200`)라 `?fromWorkOrderId=abc` 는 **가드가 이미 400** 을 낸다. `numeric()` 이 실제로 잡는 것은 **음수**(`parsed >= 0` · `work-session-query.service.ts:131`)다. 헬퍼는 그대로 쓰되 사유를 고치면 된다. 줄 표기도 `:129-136` → **`:127-133`**.
- **n-3. 자리 2 ⓒ 의 선례가 더 가까운 것을 두고 먼 것을 골랐다.** 초안은 `work-session.service.ts:68`(부모를 잠근 뒤 `max(session_no)+1`)을 들었는데, 이 슬라이스가 복제 원본으로 삼은 바로 그 모듈에 **정확히 같은 모양**이 있다 — `material-return.service.ts:90` `line_no: index + 1`(주석 `:64` 「createMany(`line_no` 1..N)」). 후자가 「새 헤더에 배열 순서대로」라는 우리 상황과 일치한다(전자는 기존 부모에 이어 붙이는 순번이라 잠금이 필요한 다른 문제다).
- **n-4. `:return` 의 `@HttpCode(HttpStatus.OK)` 를 §8 이 안 적었다.** Nest `@Post` 기본값은 **201** 인데 계약은 **200 만** 선언했다 ⇒ 빠뜨리면 곧바로 「선언하지 않은 응답」이다. 선례에 주석까지 있다(`work-session.controller.ts:84` 「계약 응답이 200 이다 — Nest 의 `@Post` 기본값 201 을 되돌린다」). §7-3 **B13·B15 가 200 을 단언하므로 그물은 있다** — 그래서 Nit 이다. PR ③ 범위 설명에 한 단어만 더하면 된다.

### ✅ 명시적으로 **PASS** 로 확인한 것 (수행했다)

| 항목 | 확인 방법 |
|---|---|
| 6 오퍼레이션 **누락 0 · 여분 0** | 계약 직접 파싱 = 6 · `assignment.tsv` = 6 · `plan-api.md` 표 = 6행 |
| §1-1 횡단 4축 표 **전건 일치** | `IdempotencyKey`(3 쓰기 전부·required) · `IfMatchVersionOptional`(POST 인계에만) · `WorkerNo`(3 쓰기 전부·required) · `ETag`/`headers` **0** · 403 은 쓰기 둘에만 · `:return` **403 없음** |
| §1-2 질의 칸 전수 · 상·하한 | 인계 7축 **상·하한 0** · 수리 7축 `page.minimum 1` · `size.minimum 1 maximum 200` ✅ |
| §1-3 본문 `required` | `OperationHandoverCreate` 4 · `OperationHandoverLine` 3(+`minItems: 1`) · `RepairExecutionCreate` 4 · `RepairExecutionReturn` 2 ✅ 전건 일치 |
| `repairResultCode` 요청 enum 2값(닫힘) | `RepairExecutionReturn` = `["SUCCEEDED","FAILED"]` ⇒ **ajv 가 강제한다 ⇒ `assertCodeValues` 불필요** ✅ (응답 쪽 `RepairExecution` 은 `null` 포함 3값이다 — §1-5 의 「2값」은 요청 기준으로 읽어야 맞다) |
| **`businessDate` 프로퍼티 0건 ⇒ C-8 미해당** | `IdempotencyKey.x-internal-note` 원문이 이유까지 적었다 ✅ |
| **오프라인 아님** | 두 POST description 의 ⛔ 문장 원문 확인 ✅ ⇒ 아웃박스 0 |
| **새 `ERROR_CODE` 0** | 쓰는 코드 전건이 `error-codes.ts` 에 실재 · 409 두 값은 `FamilyConflictCode` 소관 ✅ |
| **마이그 0** | 계약 칸 ↔ 물리 칸 독립 재대조, 결손 **0** ✅ |
| **CHECK 8건 · 인덱스** | `pg_constraint`·`pg_indexes` SELECT — 이름·정의 **전건 일치** ✅ |
| 문의 번호 **157~161** · 대역 150~179 · **153 미사용** | `ls docs/design-inquiries/` 실측 ✅ |
| 커버리지 산술 407 + 6 = **413/487** | 산술만 확인(기준선 재측정은 §4) |
| e2e 개수 산술 | A 16(7+9) · B 17(7+10) · 단위 14(4+4+3+3) ✅ |

---

## 4. 미수행 (안 본 것은 「미수행」이라 적는다)

1. **커버리지 기준선 407/487 의 재측정** — 게이트 재실행이 브리프 §5 로 금지다. 산술(407+6=413)만 확인했다.
2. **UI/UX 정본**(`plan-uiux.md` §U26 · 1195 · 920 · 1131 · 1134 · 1210 · M-02-01/M-02-02 화면 원문) — 내 관점이 아니다. `received_qty` 의 **화면 측** 근거(`plan-uiux.md:1195`)는 **열지 않았다.** 내 PASS 는 **계약 축 하나로만** 선 것이다(계약 x-internal-note 가 시각만 적었고, 그 칸이 어느 응답에도 없어 API 로 관측 불가하다). 화면 정본이 수량을 요구한다면 그 관점이 뒤집을 자리다.
3. **자리 5 의 최종 판정**(PR 2→3 · ②③ 병렬 · 병합 창 · 공용 파일 충돌) — 예산 산술과 공용 파일 실측만 검산했고 판정은 통합 관점 몫이다.
4. **선행 I-7 이 실제로 병합됐는지** — `gh` 쓰기 금지라 이슈를 다시 열지 않았다. 소스에 `src/production/production-result/` 가 서 있는 것만 확인했다.
5. **`x-source-table`/`x-source-column` 이 없는 두 스키마**(`OperationHandover`·`OperationHandoverLine`) — 계약이 출처 표기를 안 달았다. 물리 매핑은 이름 대조로만 판정했다(`lotId` ↔ `source_lot_id` 는 이름이 달라 **대조가 아니라 추론**이다 — 초안의 §7-1 ⓑ② 방어가 이 자리를 정확히 겨눈 것은 맞다).
6. **400 갈래의 실제 빈도** — `production.work_order` **0행**이라 「전개분 NULL」의 비율을 잴 수 없었다.
7. **`x-internal-note` 가 인용한 외부 문서**(M-02-01 §8-1 · M-02-02 §5-4·§8-3 · 미결-대장 277 · 정본 미결 02-SI1) — 저장소 밖이다.

---

## 5. 한 줄 결론

**계약 축에서 이 초안은 튼튼하다** — 6 오퍼레이션의 헤더·질의·본문·응답·에러·멱등을 직접 파싱해 대조한 결과 §1-1~§1-6 이 **거의 전건 일치**했고, 자리 1·2 의 「서버가 채운다」는 **계약이 시킨 일이라 위반이 아니며**, 자리 3 ⓒⓓ 는 계약 문자와 정확히 맞고, **선언하지 않은 응답을 새로 만들지 않으며 새 `ERROR_CODE` 는 0**이고 **마이그 0 결론도 독립 재대조로 확인**했다. 뒤집는 것은 **하나** — **문의 157 의 「질의」 판정**(계약이 0단계에서 답했고 `plan-integration.md:424` 가 「본길이 아니다」라 적었으며 「미루는 자리 0」은 질의의 정의와 모순이다 ⇒ **통보**, 구현 변화 0)이고, 그 밖에 **`POST /production/repair-executions` 의 403 무단언(B18 추가)** 과 인용·숫자 **다섯 자리 정정**을 요구한다.

**Blocker 0 · Major 2 · Minor 5 · Nit 4.**
