# I-13 PR ④ 독립 리뷰 — **API 설계** 관점

> 대상: `.backend-dev/lane-a2/I-13-pr4-draft.md`(510줄 전문).
> 리뷰 브리프: `.backend-dev/lane-a2/brief-I-13-pr4-review.md` §4 「API 설계」.
> 실측: 워크트리 `designer-worktree-workspace-ff88ca` · 계약 사본 `contracts/COMMIT.txt` = `a6a87e1` · 실측일 **2026-09-09**.
> ⛔ 코드·계약·다른 문서 수정 0 · DB 쓰기 0 · `git`/`gh` **쓰기** 0 · 다른 관점 리뷰(`-uiux.md`·`-integration.md`) **열지 않았다**.

---

## 1. 무엇을 «직접» 읽었나 (인용을 믿지 않고 연 자리)

### 1-1. 계약 — `node -e` 직접 파싱

| # | 파싱 대상 | 결과 |
|:-:|---|---|
| C1 | `paths['/logistics/stock-transfers/{stockTransferId}/lines']` 전수 | path-item 키 `parameters`·`get`·`put` · `stockTransferId`(path·required·int64)는 **path-item 레벨** |
| C2 | `.put` 키 전수 | `tags`·`summary`·`description`·`parameters`·`requestBody`·`responses` **여섯뿐** — `operationId` **없음** · `x-internal-note` **없음** · `x-` 확장 **0건** |
| C3 | `.put.parameters` | `$ref` 둘 — `#/components/parameters/IdempotencyKey` · `#/components/parameters/**IfMatchVersion**` |
| C4 | `components.parameters.IdempotencyKey` | `Idempotency-Key` · header · **required: true** · `format: uuid` |
| C5 | `components.parameters.IfMatchVersion` | `If-Match` · header · **required: true** · `type: string`. ⭐ `IfMatchVersionOptional` 은 **별개 이름**으로 실재한다 — 이 오퍼레이션은 **필수본**이다 |
| C6 | `.put.requestBody` | `required: true` · 인라인 object · `required:["items"]` · `items: array<StockTransferLineUpsert>` · **`minItems` 없음** · `additionalProperties` 없음 |
| C7 | `.put.responses` | **200**(`StockTransferLineListResponse`) · **400**(`ErrorResponse`) · **403**(`ErrorResponse`) · **409**(`ConflictResponse`). ⛔ **`headers` 선언 0건**(200 에 ETag 없음) · **404 미선언** · ⭐ **5xx 미선언** |
| C8 | `StockTransferLineUpsert` | required **6**(`itemId`·`lotId`·`requestedQty`·`uomId`·`fromLocationId`·`toLocationId`) / 프로퍼티 **8** · `handlingUnitId`는 `[integer,null]` · description 「반출이 끝난 라인은 바꿀 수 없다 — **400 STATE_LOCKED**」 |
| C9 | ⭐ **계약 7파일 487 오퍼레이션 응답코드 히스토그램** | `200:397 · 201:75 · 202:7 · 204:9 · 400:229 · 401:2 · 403:250 · 404:123 · 409:176 · 413:1 · 422:20 · 423:1` — ⛔ **5xx 는 487건 중 0건이다** |
| C10 | ⭐ `PUT …/lines` **6형제 전수**(재고조정·재고실사·출고·입하·발주·재고이동) | **전원 200/400/403/409** · **404 를 선언한 형제 0건** · 재고실사만 `IfMatchVersionOptional`+`WorkerNoOptional`, 나머지 다섯은 `IdempotencyKey`+`IfMatchVersion` |
| C11 | ⭐ `components.schemas.StockTransfer` | **`shippedAt` 은 `["string","null"]` 이고 `required` 배열에 «없다»** · description 「반출 확정 시각」 |
| C12 | `GET /logistics/stock-transfers` 파라미터 | `inTransitOnly`(boolean · **default false** · 「반출됐으나 도착하지 않은 건만」) |
| C13 | `POST /logistics/stock-transfers` `x-internal-note` · `StockTransferCreate.description` | 「도출 단계의 `:depart` 를 두지 않는다」 · 「생성과 반출이 한 오퍼레이션이다」 |
| C14 | `shipment-04제품출하.json` `POST /logistics/stock-reinstatements` | 응답 201/400/403/409 · description 「반출·도착·보류 해제·Lot Status 전이를 **한 트랜잭션으로**」 · 「창고 간 이동의 2단계 스캔을 쓰지 않는다」 |
| C15 | `GET /logistics/document-progress/{documentTypeCode}/{documentId}` | `documentTypeCode` enum **9값** — `PUTAWAY_TASK` **없음** · 응답 **200/404** |
| C16 | `DocumentProgressStep` | required 는 `stepCode`·`occurredAt` 둘뿐 · `inventoryTransactionNo`·`businessDate` 는 **nullable** · `steps` 배열에 `minItems` 없음 |
| C17 | `ErrorItem` | required `scope`·`code`·`message` · **`field` 는 optional** · `code` 설명이 「… 등」으로 **열려 있다** |

### 1-2. 코드·물리 — 초안이 인용한 자리를 직접 열었다

`src/common/errors/error.filter.ts`(전문) · `src/common/errors/error-codes.ts`(전문) ·
`src/common/optimistic-lock/optimistic-lock.ts:1-80` · `optimistic-lock.guard.ts:25-85` ·
`src/app.module.ts:22-40` · `src/common/idempotency/idempotency.service.ts:95-155` · `src/common/master/master-write.ts:1-70` ·
`src/logistics/stock-transfer/stock-transfer.controller.ts`(전문 125줄) · `stock-transfer.service.ts:60-115` · `stock-transfer-query.service.ts:40-95` ·
`transfer-posting.ts:28,128-140,296-310` · `src/logistics/goods-issue/goods-issue-update.service.ts:40-60,215-245` · `goods-issue.controller.ts:140-160` ·
`src/common/permissions/manual-permissions.ts:255-265` · `src/core/numbering/numbering.service.ts:25-50,88-180` ·
`src/logistics/putaway/putaway-posting.ts:1-58` · `src/logistics/document-progress/document-progress-query.service.ts:60-100,212-250` ·
`document-type-registry.ts:60-80` · `cancel-eligibility.service.ts:45-60,150-190` ·
`prisma/schema.prisma`(model `inventory_transaction` 전수) ·
`test/logistics-stock-transfer.e2e-spec.ts:20-45,118-160,897-975,1130-1180` ·
`test/permission-gate.e2e-spec.ts:186-196` · `test/maintenance-inspection.e2e-spec.ts:344-360,538-560` ·
`docs/design-inquiries/059-…md`(머리) · `123-…md`(전문 상단) · `git show --stat 852294a` · `git log -- src/logistics/document-progress/` · `gh pr list --state open`(읽기).

---

## 2. §0 다섯 판정 (초안 §0-1 의 「반드시 볼 자리 5」 그대로)

| # | 자리 | 판정 | 한 줄 근거 |
|:-:|---|:-:|---|
| ① | 「도달 불가」의 뜻 | ✅ **PASS** | 계약 선언 응답 넷 중 **200 하나만** 도달 불가. 400·403·409 는 계약·가드·권한 실측으로 전부 도달 |
| ② ⭐ | `shipped_at IS NULL` 갈래를 무엇으로 닫는가 | ⚠ **조건부**(Major-1·Major-2) | 「400 으로 닫으면 안 된다」는 **선다**. 「그래서 `throw new Error`(500)」는 **저장소 선례는 있으나 계약 축에서 틀린 범주다** — 계약이 그 상태를 «선언»했다(C11·C12) |
| ③ | 판별자 축의 식 | ⚠ **조건부**(Minor-1) | `startsWith` 는 059 통보 문자와 다르나 계약 축에서 둘 다 적법. 단 **접두 겹침**(`SEQ4` 초과 시)이 실재한다 |
| ④ | 파일 배치 | ✅ **PASS** | 계약 축에서 중립. 실측 261+32≈293 · 125+26≈151 로 300줄 미만 유지. 형제 분리 사유(300줄 초과)가 여기엔 없다 |
| ⑤ | 판별자 수정의 소유 | ✅ **PASS**(근거 하나 정정 · Minor-3) | 계약 축에서 이 축은 **응답 표면을 안 넓힌다**(C16 — `steps` 에 `minItems` 없고 두 칸 다 nullable). 단 초안 실측 #34 「열린 PR 0건」은 **오늘 거짓**이다 |

### ① 「도달 불가」 — PASS

초안의 「절반만 사실 · 도달 불가는 «치환 본체» 하나」는 **계약 축에서 그대로 선다**.

- 계약이 선언한 응답은 **200·400·403·409 넷**(C7). 여기에 미선언 404 가 붙는다(C10 — 형제 6건 전원 미선언인데 `GET …/lines` 는 이미 404 를 낸다 · `stock-transfer-query.service.ts:76-83` 주석이 그 판정을 이미 적었다).
- **400 도달** — `POST /logistics/stock-transfers` 가 `shipped_at: occurredAt` 을 무조건 채운다(`stock-transfer.service.ts:101` 실측 · 주석 「태어나는 순간 반출이 끝나 있다」). 계약도 같은 말을 두 자리에서 한다(C13).
- **403 도달** — `manual-permissions.ts:260` 등록 실측(아래 ⓑ). 무권한 계정이면 `PermissionGuard` 가 낸다.
- **409 도달** — `IfMatchVersion`(**required** · C5)이라 어긋난 토큰이 언제나 실린다.
- **200 만 도달 불가** — `stock_transfer` 를 만드는 계약 오퍼레이션이 둘뿐이고(01 `POST` · 04 `POST /logistics/stock-reinstatements`), 둘째는 「한 트랜잭션으로 반출·도착까지」(C14)이며 오늘 **미구현**이다(`@Contract('POST /logistics/stock-reinstatements')` 0건 — `transitions.ts:224`·`derived-permissions.ts:187` 에 이름만 있다).

⇒ **e2e 가 400 갈래에 픽스처를 심을 필요가 없다**는 초안 결론도 선다.

### ② ⭐ `shipped_at IS NULL` — **조건부**(가장 무거운 자리)

**⛔ 먼저, 초안이 맞은 것 — 뒤집지 않는다.**
「널 갈래를 같은 400 `STATE_LOCKED` 로 닫으면 «`shipped_at` 을 아예 안 읽고 무조건 400» 구현과 관측이 0이 된다」는 **참이다.** 그 상태에서 §6-2 변이 ②는 전 스위트가 초록이다. 이 자리를 **갈라야 한다**는 판단은 유지한다.

**⚠ 그러나 「그러므로 `throw new Error` → 500」은 계약 축에서 다음 셋이 걸린다.**

1. ⭐ **계약이 이 상태를 «선언했다».** `StockTransfer.shippedAt` 은 `["string","null"]` 이고 **`required` 배열에 없다**(C11). 더해 `GET /logistics/stock-transfers` 의 `inTransitOnly` 는 **default false** 이고 설명이 「**반출됐으나** 도착하지 않은 건만」이다(C12) — 즉 «반출 전» 행이 기본 목록에 섞여 나오는 것을 계약이 전제한다. **계약이 표현하도록 선언한 상태를 서버가 「깨졌다」로 다루는 것**이 이 판정의 실체다.
2. ⭐ **같은 저장소가 그 행을 이미 200 으로 섬긴다.** `test/logistics-stock-transfer.e2e-spec.ts:897`(`srA` — `shippedAt` 미지정 ⇒ `shipped_at: null`, **`withLine: true`**)이 `:150-156` 에서 `GET /api/logistics/stock-transfers/${srA}` **200** 을 이미 초록으로 받고, `:120-131` 이 `statusCode=REGISTERED`·`inTransitOnly` 목록에서 그 행을 **정상 자원으로 단언**한다. ⇒ 같은 자원이 `GET` 에는 200, `PUT …/lines` 에는 **500** 이 된다.
3. ⭐ **`error.filter.ts` 가 그 갈래의 뜻을 스스로 못박았다.** 폴백 분기 주석은 「**여기까지 온 것은 우리가 의도한 적 없는 오류다**」이고, 그 자리는 `logger.error('처리되지 않은 예외', stack)` 로 **스택을 에러 레벨로 남긴다.** 「의도해서 설계한 갈래」를 그 통로에 넣으면 그 채널의 뜻이 흐려진다. `error-codes.ts` 마지막 줄도 「계약에 없는 응답이라 봉투만 맞춰 내보내는 자리. **근거: 계약에 5xx 정의가 없다**」다 — 히스토그램 실측(C9)이 그 말을 뒷받침한다(487/487 무선언).

**⛔ 반대로, 초안 편에 서는 실측도 크다 — 그래서 「뒤집는다」가 아니라 「조건부」다.**

- 이 저장소에는 **「API 가 만들 수 없는 DB 상태 → 500 `INTERNAL_ERROR`」를 e2e 로 단언하는 확립된 선례가 있다**:
  `test/permission-gate.e2e-spec.ts:187-193`(미등록 권한 · 주석 「사용자 문구가 아니라 «구현이 멈춰야 하는» 자리다」) · `test/maintenance-inspection.e2e-spec.ts:344-355`(손으로 심은 잘못된 `timezone_code` → `expect(500)` + `errors[0].code === 'INTERNAL_ERROR'`) · `:538-556`(손으로 심은 잘못된 저장값) · `test/maintenance-{result,order,breakdown}.e2e-spec.ts` · `app-document-issue-*.e2e-spec.ts`.
- 코어에도 같은 모양이 있다 — `src/core/inventory-posting/reversal.ts:65` 「⛔ 조용히 0 으로 대신하지 않는다 — 생성 컬럼이 비었다는 것은 물리가 어긋났다는 뜻이다」.
- 초안이 든 선례 둘도 **실재한다**(`master-write.ts:57-59` · `goods-issue.controller.ts:148-154` — 둘 다 「If-Match 가 없는데 가드를 지났다」). 다만 **그 둘은 «가드 대 계약» 불일치**라 데이터 상태가 아니다. 초안이 든 선례로는 이 자리를 못 덮는다(→ Major-2).

**⇒ 판정: 조건부.** 「400 으로 뭉치지 않는다」는 승인. 「무엇으로 가르는가」는 **아래 Major-1 의 조건을 채우고 다시 고르라**. 내 권고는 `NotImplementedException`(**501**)이다 — 근거는 Major-1 에 적었다. 500 을 유지하려면 Major-2 의 세 줄을 계획안에 적어야 한다.

**뒤집힘의 파급(브리프 요구)** — 어느 쪽을 골라도 **코드 형상·예산은 안 바뀐다**: 서비스 한 줄(`throw new Error(...)` ↔ `throw new NotImplementedException(...)`)과 **e2e 42 의 기대값 한 줄**(`expect(500)`+`INTERNAL_ERROR` ↔ `expect(501)`+`NOT_IMPLEMENTED`)뿐이다. 비테스트 ≈67 · PR 1개 · 마이그 0 · 커버리지 +1 **전부 그대로**. ⇒ 이 갈림길은 **예산이 아니라 뜻의 문제**다.

### ③ 판별자 축의 «식» — 조건부

- **계약 축에서는 둘 다 적법하다.** `transaction_no` 는 이 오퍼레이션의 **질의 축이 아니고**, 응답 `DocumentProgressStep.inventoryTransactionNo` 는 nullable이며 `steps` 배열에 `minItems` 가 없다(C16). ⇒ 축을 얹어 `POSTED` 줄이 사라져도 **계약 위반이 아니다.**
- 059 는 **통보(2026-09-08)**이고 본문이 규칙을 `LIKE 'PT-%'` / `NOT LIKE 'PT-%'` 로 못박았다(직접 열어 확인 · `putaway-posting.ts:5-17` 주석에도 같은 문장). 초안이 **다른 식**을 쓰면서 그 사실을 통보 162 로 알리겠다고 적은 것은 절차상 맞다.
- ⚠ **다만 `startsWith` 에 실재하는 겹침이 있다** → Minor-1.

### ④ 파일 배치 — PASS

계약 축 중립. 실측으로 `stock-transfer.service.ts` **261**, `.controller.ts` **125**(둘 다 실측 확인) — 초안 예상 후 293·151 로 CLAUDE.md 「파일 ~300줄」 안. 형제 `goods-issue-update.service.ts` 가 갈린 이유(등록·전기가 이미 300줄 초과)가 여기엔 없다. 컨트롤러가 이미 `ifMatchVersion` 을 import 하고 있어 `versionOf()` 도우미는 `goods-issue.controller.ts:148-154` 복제 그대로다. ✅

### ⑤ 소유 — PASS(근거 하나 정정)

- `git log -- src/logistics/document-progress/` → **커밋 8건 전부 I-5**(마지막 `2131c28` I-5 PR ⑤). ✅ 초안 그대로.
- ⛔ **`gh pr list --state open` 은 오늘 «빈 결과가 아니다»** — **#455·#456 두 건이 열려 있다**(둘 다 `[A]` I-21 quality). 파일 목록을 확인했다: `src/quality/**`·`quality.module.ts`·`src/common/idempotency/family-conflict-code.spec.ts`·`test/quality-*` 뿐 — **`document-progress/`·`stock-transfer/`·`manual-permissions.ts` 를 건드리는 열린 PR 은 0건**이다. ⇒ **결론은 살고 근거만 틀렸다**(→ Minor-3).

---

## 3. Findings

> 심각도: CREFLE `pr-review` 4단계. 각 건에 **실패 예**(구체적 입력 → 잘못된 출력).

### 🔴 Blocker — **0건**

### 🟠 Major

#### Major-1. 널 갈래를 `throw new Error`(500)로 닫는 근거가 **틀린 전제** 위에 서 있다 — 501 이 같은 값에 더 싸다

**어디** — 초안 §4-3 대안 표 마지막 행.

> `NotImplementedException`(501) | 계약 응답 선언(200/400/403/409) 밖의 «**정상**» 상태 코드를 새로 여는 것이다. 500 은 「서버가 스스로 깨졌다고 말하는 것」이라 선언 밖이어도 뜻이 맞는다

**무엇이 틀렸나** — **501 은 «정상» 상태 코드가 아니다. 5xx 서버 오류 계열이고 500 과 같은 계열이다.** 이 문장이 참이라면 500 도 같은 이유로 버려야 한다. 즉 초안은 **자기 선택을 버리는 논거로 대안을 버렸다.** 계약 축에서 둘은 **완전히 같은 지위**다 — 히스토그램 실측(C9)상 487 오퍼레이션에 5xx 선언이 **0건**이라, 500 도 501 도 「선언 밖」이다.

**501 이 더 나은 이유 셋(전부 실측)**

1. `error.filter.ts` 의 `HttpException` 분기를 타므로 봉투가 `ErrorResponse` 로 같고 `code` 는 `HttpStatus[501] = 'NOT_IMPLEMENTED'` 가 된다 — `ErrorItem.code` 설명이 「… 등」으로 **열려 있어**(C17) 계약 위반이 아니고, `error-codes.ts` 에 **상수를 더할 필요도 없다**(「새 `ERROR_CODE` 0」 유지).
2. `logger.error('처리되지 않은 예외', stack)` 를 **타지 않는다.** 500 은 탄다 — 의도한 갈래가 「의도한 적 없는 오류」 채널과 스택 로그를 영구히 공유한다.
3. 뜻이 정확하다 — 이 자리는 「물리가 어긋났다」가 아니라 「**계약이 허용한 상태인데 이 오퍼레이션이 아직 그 갈래를 안 지었다**」다(초안 §3-② 「치환 본체를 짓지 않는다」가 바로 그 말이다).

**반증력은 완전히 동일하다** — §6-2 변이 ②(「`shipped_at` 을 안 읽고 무조건 400」)는 e2e 42 가 `expect(501)` 이어도 그대로 빨개진다. 변이 ③(파열을 400 으로)도 마찬가지다.

**실패 예 (500 을 유지할 때)**
입력: I-23 이 `POST /logistics/stock-reinstatements` 를 구현하며 `shipped_at` 채우기를 빠뜨린다(초안 스스로 인계 ⑤ 에 이 위험을 적었다) → 그 전표로 `PUT /logistics/stock-transfers/{id}/lines`.
잘못된 출력: **HTTP 500 + `INTERNAL_ERROR`** + `처리되지 않은 예외` 스택 로그. 운영 알람이 「서버 장애」로 뜨고, 화면은 원인을 못 가른다. 501 이면 `NOT_IMPLEMENTED` 로 즉시 자리가 특정되고 알람 채널을 안 흐린다.

**고칠 것** — §4-3 의 대안 표에서 501 행의 사유를 **사실로 고치고**, 결론을 다시 고른다. 권고는 `throw new NotImplementedException('반출 전 재고 이동 전표가 실재한다 — 계약 전제가 깨졌다(문의 123).')` + e2e 42 를 `expect(501)` · `errors[0].code === 'NOT_IMPLEMENTED'` 로. **비테스트 줄 수 변화 0.**

---

#### Major-2. 500 을 유지한다면, 계획안이 **이 갈래가 선례와 다른 범주라는 사실 셋**을 안 적었다

**어디** — 초안 §0-1 ② · §4-3 · 실측 부록 #14.

**무엇이 빠졌나** — 초안이 든 선례 `master-write.ts:57-59` · `goods-issue.controller.ts:148-154` 는 직접 열어 확인했고 **둘 다 「가드가 If-Match 를 필수로 막았는데 값이 없다」** 다 — 즉 **«가드 대 계약» 배선 불일치**이지 데이터 상태가 아니다. 이 자리는 **데이터 상태**다. 그 차이가 만드는 사실 셋이 계획안에 없다:

| # | 빠진 사실 | 실측 자리 |
|:-:|---|---|
| ⓐ | **계약이 `shippedAt` 을 `["string","null"]` 로 선언했고 `required` 에 넣지 않았다** | `components.schemas.StockTransfer` 직접 파싱(C11) |
| ⓑ | **`inTransitOnly` 는 default false 이고 「반출됐으나…만」이라 «반출 전» 행이 기본 목록에 섞이는 것을 계약이 전제한다** | `GET /logistics/stock-transfers` 파라미터 파싱(C12) · 구현 `stock-transfer-query.service.ts:44` |
| ⓒ | **같은 스위트가 그 행을 이미 200 으로 단언한다** — `srA`(shipped_at null · `withLine: true`)가 `:150-156` 상세 GET 200 · `:107·112·122·145` 목록에 정상 자원으로 등장 | `test/logistics-stock-transfer.e2e-spec.ts` |

⇒ 이 셋이 있으면 「도달 불가한 상태」라는 말이 **「계약이 허용하되 오늘 어느 오퍼레이션도 만들지 않는 상태」**로 정확해지고, 파열 선택의 근거가 실제 근거 위에 선다. 지금 문장(「계약 전제가 깨졌다」)은 **계약 실측과 어긋난다** — 계약은 그 상태를 깨진 것으로 선언한 적이 없다.

**실패 예**
입력: 이 계획안을 근거로 다음 슬라이스가 「nullable 인데 오늘 안 만들어지는 칸은 500 으로 닫는다」를 일반 규칙으로 복제한다.
잘못된 출력: `receivedAt`(같은 표 · 같은 nullable · `GET` 이 200 으로 섬김)에도 같은 처방이 번져 **정상 상태에 5xx 를 내는 오퍼레이션이 늘어난다.** ⓐ~ⓒ 를 적어 두면 「계약이 선언한 상태」와 「물리가 어긋난 상태」가 갈려 복제가 막힌다.

**고칠 것** — §4-3 주석과 §0-1 ② 판정 칸에 ⓐⓑⓒ 를 넣고, 실측 부록 #14 에 「선례 둘은 **배선 불일치**다 — 데이터 상태 선례는 `reversal.ts:65`·`maintenance-inspection.e2e-spec.ts:344-355` 다」를 더한다. 그리고 **e2e 42 는 상태코드만이 아니라 봉투도 단언한다** — 저장소 선례가 전부 `errors[0].code` 를 함께 본다(`maintenance-inspection.e2e-spec.ts:355`·`:548`).

---

### 🟡 Minor

#### Minor-1. `startsWith(전표번호)` 는 **접두 겹침**이 실재한다 — 059 의 `NOT LIKE 'PT-%'` 에는 없는 결함이다

**어디** — 초안 §5-2 의 `{ transaction_no: { startsWith: String(row[mapping.noColumn]) } }`.

**실측** — 번호는 `ST-{YYYYMMDD}-{SEQ4}`(`numbering.service.ts:36-37`)인데 `render()` 주석이 **「자리를 넘으면 그대로 늘어난다 — 잘라 내면 번호가 겹친다」**(`:172` 부근 `padStart`)라 못박았다. ⇒ 하루 채번이 9999 를 넘으면 `ST-20260512-10001` 이 만들어지고, 이는 **`ST-20260512-1000` 의 접두다.**

**실패 예**
입력: 같은 날 전표 1000번(`ST-20260512-1000`)과 10001번(`ST-20260512-10001`)이 있고, 뒤엣것의 반출 원장 `occurred_at` 이 앞엣것보다 이르다.
잘못된 출력: `GET /logistics/document-progress/STOCK_TRANSFER/{1000번 id}` 의 `POSTED` 줄이 **10001번의 `inventoryTransactionNo`·`businessDate`** 를 그린다 — 이 PR 이 고치려던 바로 그 증상(남의 원장)이 형태만 바꿔 남는다.

**고칠 것**(계획안 §5-2 · 코드 2줄) — 접두를 **경계까지** 잠근다. 이동이 남기는 원장은 실측상 **정확히 둘**(`ST-…` 반출 · `ST-…-A` 도착 · `transfer-posting.ts:28,136,303`)이고 역행은 `reversal_of_transaction_id: null` 이 이미 뺀다:

```
? { OR: [{ transaction_no: no }, { transaction_no: { startsWith: `${no}-` } }] }
```

이러면 「거부 목록이 자란다」는 초안의 원래 논지도 유지된다(셋째 접미가 생겨도 잡힌다). 겹침만 사라진다. **변이 ⑩·⑪ 의 반증력은 그대로다.**

---

#### Minor-2. 409(버전)를 400 `STATE_LOCKED` «앞»에 두면, 이 오퍼레이션에서는 **풀리지 않는 것을 「다시 불러오면 풀린다」로** 안내한다

**어디** — 초안 §4-2 순서표 2단계 → 3단계 · §6-1 e2e 43.

**계약 축** — 계약 응답 설명이 둘을 갈라 적었다: 400 「검증 실패. **고쳐야 풀린다**」 · 409 「저장 충돌. **다시 읽어 오면 풀린다**」(C7). `ErrorItem.code` 설명도 「`STATE_LOCKED` 는 … **재로드해도 풀리지 않는다** — 재로드로 풀리는 저장 충돌(409)과 구분한다. 근거: 공유계약 G-1」(C17). 구현 쪽 `assertUpdated` 의 문구는 실측상 「**다시 불러온 뒤 저장하세요**」다(`optimistic-lock.ts:71`).

**왜 형제와 다른가** — 형제 `goods-issue-update.service.ts` 는 `lockHeader`(404→409) 뒤 `assertNotApproved`(400)인데, 그쪽 400 조건(승인 완료)은 **일부 전표에만** 참이다. 여기는 **오늘 존재하는 모든 전표에 언제나 참**이다(§3-① 실측). ⇒ 어긋난 토큰으로 온 호출은 **100% 「다시 불러오세요」를 받고, 다시 불러와도 400 을 받는다.**

**실패 예**
입력: 화면이 낡은 ETag `'1'` 로 `PUT …/lines`(전표는 `version_no=2`, `shipped_at` 차 있음).
잘못된 출력: `409 {conflictCause:'user', message:'다른 사용자가 먼저 저장했습니다. 다시 불러온 뒤 저장하세요.'}` → 화면이 재조회 후 재시도 → **400 `STATE_LOCKED`**. 왕복 두 번과 거짓 안내.

**고칠 것** — 순서를 뒤집으라는 것이 **아니다**(RFC 9110 의 선행조건 평가 순서와 형제 선례가 현행 순서를 받친다). 계획안이 **이 결과를 알고 골랐음을 적으면 된다**: ⓐ §4-2 순서표 2단계 칸에 「⚠ 이 오퍼레이션에서는 409 의 「다시 읽으면 풀린다」가 사실이 아니다 — 재조회 뒤에도 3단계가 400 이다(G-1 예외 자리)」 ⓑ **통보 162 ⓓ 에 한 줄** ⓒ e2e 43 에 「409 뒤 재조회 → 같은 호출이 400 `STATE_LOCKED`」 단언 한 줄(변이 ⑦ 「항상 409」를 **양방향**으로 못 박는 부수 효과도 있다).

---

#### Minor-3. 실측 부록 #34 「열린 PR 0건(`gh pr list --state open` → 빈 결과)」은 **오늘 거짓**이다

**실측(2026-09-09)** — `gh pr list --state open` → **#456 `[A] feat(quality): 부적합 등록 · 처분 판정 의뢰 (I-21 PR ⑥)`**, **#455 `[A] feat(quality): 특채 조회 2 (I-21 PR ⑤)`** 두 건.
파일까지 확인했다 — #455 `src/quality/concession/*`·`quality.module.ts`·`test/quality-concession.e2e-spec.ts` / #456 `src/quality/nonconformance/*`·`quality.module.ts`·`src/common/idempotency/family-conflict-code.spec.ts`·`test/quality-nonconformance-write.e2e-spec.ts`.
⇒ **자리 ⑤ 의 결론(충돌 창 0)은 산다.** 근거 문장만 「열린 PR 2건 · 둘 다 `src/quality/**` 뿐 — 이 PR 이 여는 세 파일과 겹침 0」으로 고치면 된다.

**실패 예** — 병합 시점에 통합자가 「PR 0건」을 그대로 믿고 `origin/main` merge 를 건너뛰면, `quality.module.ts` 처럼 두 열린 PR 이 함께 만지는 파일이 있는 사실 자체를 못 본다(이 PR 과는 겹치지 않으나 **근거가 틀린 채로 통과한다**).

---

#### Minor-4. 형제와 갈리는 **빈 `items` 응답**을 계획안이 명시하지 않았다 — 부록 #12 인용이 불완전하다

**실측** — 계약은 `minItems` 를 안 걸었는데(C6), 형제 `goods-issue-update.service.ts:56-60` 은 **`lockHeader` 보다 «먼저»** `items.length === 0` 을 400 `LINE_REQUIRED` 로 막고 주석까지 적었다(「계약이 `minItems` 를 안 걸었다 — … 치환도 0행을 막는다」). 초안 실측 부록 #12 은 「형제 순서 = 404 → 409 → 400 (`:224-238`)」이라 적어 **그 앞단을 뺐다.**

**실패 예**
입력: `PUT /logistics/stock-transfers/999999/lines`(없는 전표) with `{"items":[]}`.
출력 차이: 이 PR → **404**. 형제 출고 → **400 `LINE_REQUIRED`**. 같은 계약 형상의 두 오퍼레이션이 같은 입력에 다른 봉투를 낸다.

**판정** — 「본문을 한 칸도 안 읽는다」(§3-②)는 R-4 아래에서 **일관되고 방어 가능하다**(어차피 거절이므로 검증할 것이 없다). 다만 **의도적 차이임을 적어야** 한다: 부록 #12 을 「형제는 **빈 배열 400 → 404 → 409 → 400** 이다. 이 PR 은 앞의 한 단을 «일부러» 뺀다 — 치환 본체가 없어 `items` 를 볼 이유가 0이다」로 고치고, §3-② 「안 하는 것」에 「`items` 빈 배열도 안 본다(형제와 갈리는 유일한 자리)」를 더한다.

---

### ⚪ Nit

| # | 자리 | 내용 |
|:-:|---|---|
| N-1 | 부록 #17 | 「`row` 는 **`select` 없는** `findFirst`」 — 실제로는 `findFirst({ where, **include**: this.includeOf(mapping) })`(`document-progress-query.service.ts:93`). 스칼라가 전부 실린다는 **결론은 맞다**(Prisma `include` 는 스칼라를 지우지 않는다). 문구만 「`select` 를 안 써 스칼라 전건이 실린다(`include` 사용)」로. |
| N-2 | 부록 #26 | 「`:127-128,940-963`」 — 실측은 주석 **`:128-129`**, `makeTransfer` **`:938-975`**. 두 줄 차이. |
| N-3 | 부록 #3 | 「`putaway-posting.ts:6-13`」(§0-0) 과 「`:5-17`」(부록)이 서로 다르다. 실측 정본은 **`:5-17`**. |
| N-4 | §1-3 「새 `ERROR_CODE` 0」 | 500 을 유지하면 응답 `code` 는 `INTERNAL_ERROR`(`error-codes.ts` 마지막 줄 · `ERROR_CODE` 표 **밖**의 상수)다. 「새 값 0」은 맞지만 **표 밖의 상수 하나를 쓴다**는 사실을 §1-3 에 한 칸으로 적으면 셈이 닫힌다. |
| N-5 | §1-1 「404 미선언 … 형제 선례」 | 근거를 더 세게 적을 수 있다 — **`PUT …/lines` 6형제 전원(재고조정·재고실사·출고·입하·발주·재고이동)이 404 를 선언하지 않는다**(C10 · 계약 전수). 「형제 하나」가 아니라 「계약 전체의 관행」이다. |
| N-6 | §4-4 | `runIdempotent` 의 `work` 는 **`tx` 를 안 받는다**(`master-write.ts:26-44` — `() => work()`). 초안 코드가 `this.prisma` 를 쓰는 것은 **선례와 일치**한다(`stock-transfer.service.ts:68` 도 `runIdempotent` 안에서 `this.prisma.$transaction`). 지적이 아니라 **확인**이다 — 「`tx` 를 받아야 하나」라는 물음이 리뷰에서 다시 나오지 않게 한 줄 적어 두면 좋다. |

---

## 4. 검증했으나 **문제 없음**(PASS 로 적을 자격이 있는 것만)

| 축 | 판정 | 실측 |
|---|:-:|---|
| **멱등** | ✅ | `IdempotencyKey.required=true`(C4) ⇒ `runIdempotent(…, HttpStatus.OK, …)` 필수. **실패 시 기록 롤백** — `idempotency.service.ts:119-141` 이 `idempotency_record.create` 를 `work()` 와 **같은 `$transaction`** 안에서 한다(주석 「함께 롤백되어야 「안 한 일」이 된다」). ⇒ e2e 41 의 「같은 멱등키 재전송도 400」은 **참이고 반증력이 있다** |
| **If-Match** | ✅ | 계약 `$ref` 가 `IfMatchVersion`(**Optional 아님** · C5) ⇒ `optimistic-lock.guard.ts:73-77` 이 `'required'` 로 푼다. `POST`·`:arrive` 는 Optional 이라 **이 오퍼레이션만 필수**라는 초안 서술 ✅. 미실림 400 `REQUIRED` · 형식 오류 400 `INVALID`(guard `:39-60`) ✅ |
| **ETag** | ✅ | `.put.responses['200']` 에 `headers` **없음**(C7) ⇒ `setEtag` 미호출 판정 옳다. `setEtag` 는 따옴표 없이 `String(versionNo)` 를 쓰므로(`optimistic-lock.ts:21`) e2e 46 의 `ETag === '1'` 단언도 성립 |
| **400/404/409 순서** | ✅(단 Minor-2) | 가드단 400 이 서비스보다 앞선 것은 `app.module.ts:23-36` 등록 순서에 의해 **강제**된다(이 PR 의 선택이 아니다). 서비스단 404 → 409 는 형제 `lockHeader`(`goods-issue-update.service.ts:224-238`) 실측과 일치 |
| **새 `ERROR_CODE` 0** | ✅ | `STATE_LOCKED` 는 `error-codes.ts:17` 에 실재 · 계약 `ErrorItem.code` 예시에도 있다. 새 상수 추가 0 (N-4 는 표 밖 상수 셈 문제일 뿐) |
| **권한 diff 0** | ✅ | `manual-permissions.ts:260` = `'PUT /logistics/stock-transfers/{stockTransferId}/lines': ['M-01-10']` 실재. `git show 852294a` — 「feat(logistics): 재고 이동 :arrive·라인 치환 권한 등록」(2026-09-07 · hj.cho · +11줄)에서 들어왔다. **초안 「낡음 1」 참** |
| **059 「낡음 2」** | ✅ | `059-….md` 머리 = 「✅ **결정 (2026-09-08 · 통보)**」 + `LIKE 'PT-%'` 규칙 전문. `putaway-posting.ts:5-17` 주석이 같은 규칙을 담았다. **참** |
| **마이그 0** | ✅ | 계약 8칸이 물리에 전부 실재(`handling_unit_id` 포함 · A4 `20260908002517…` 디렉터리 실재). 이 PR 은 어느 표에도 쓰기 0 |
| **e2e 47 픽스처의 실행 가능성** | ✅ | `model inventory_transaction` 의 **NOT NULL·무기본값 칸 9개**(`business_date`·`transaction_no`·`transaction_type_code`·`plant_id`·`occurred_at`·`source_document_type_code`·`source_document_id`·`status_code`·`idempotency_key`)를 초안이 **정확히 9개 다 열거했다.** `@@unique([transaction_no, business_date])` 도 `PT-20260511-9999`/`2026-05-11` 로 안 부딪힌다 |
| **e2e 47 의 반증력** | ✅ | 축을 지우면 `occurred_at asc` 가 더 이른 `PT-` 행을 집는다 ⇒ 변이 ⑩ 빨개진다. **단 초안이 스스로 단 조건(「`AT` 보다 이르게」)이 필수다** — 초안이 §6-2 ⓒ 에 이미 적었다 ✅ |
| **e2e 49(403) 의 둘째 계정** | ✅ 가능 | 스위트 `login(loginId)` 이 **인자를 받는 함수**이고(`:1155`) `makeUsers()` 가 계정을 하나만 만든다(`:1139-1153`). 계정 하나 더 만드는 것은 픽스처 몇 줄 — 초안 판정과 일치 |
| **판별자 축이 API 표면을 안 넓힌다** | ✅ | `DocumentProgressStep` required 는 둘뿐이고 `inventoryTransactionNo`·`businessDate` 는 nullable · `steps` 에 `minItems` 없음(C16). `POSTED` 줄이 없어져도 계약 위반 아님 |
| **문서진행 목록이 `steps()` 를 안 부른다** | ✅ | `document-progress-query.service.ts:60-86` 직접 읽음 — `documentProgressView` 만 부른다 |
| **`lotAxis` 가 STOCK_TRANSFER 에 안 돈다** | ✅ | `cancel-eligibility.service.ts:51` `LOT_SOURCE_TYPES=['INBOUND_RECEIPT','GOODS_RECEIPT']` · `:156` 가 그 둘일 때만 호출 |
| **`PUTAWAY_TASK` 회귀 0** | ✅ | 계약 path enum 9값에 없음(C15) · `test/logistics-document-progress.e2e-spec.ts` 에 `STOCK_TRANSFER` **0건**(grep 실측) |
| **줄 수·건수 실측** | ✅ | `stock-transfer.service.ts` **261** · `.controller.ts` **125** · `document-progress-query.service.ts` **278** · `transfer-arrive.service.ts` **266** · e2e **1216줄 / `it(` 39건** — 초안 부록 #31·#32 전건 일치 |

---

## 5. 미수행 (⛔ PASS 로 적지 않는다)

| # | 항목 | 왜 |
|:-:|---|---|
| 1 | **커버리지 424 → 425 재측정** | 브리프 §5 「전체 게이트 재실행 금지」. `node_modules/.bin/jest contract-coverage` 를 **돌리지 않았다.** 초안 실측(2026-09-09)을 **그대로 인용**한다 — 내 다섯 판정 중 이 값을 뒤집는 것이 없다 |
| 2 | **`operation-permissions.spec.ts`·단위 스위트 실행** | 위와 같다. 다만 계약 실측으로 `declares403 = 250`(C9 히스토그램)이 초안 §6-4 의 「250」과 **일치**함은 확인했다 |
| 3 | **DB SELECT 재확인**(`stock_transfer` 0행 등) | 이 관점(API 설계)의 다섯 판정이 행 수에 걸리지 않는다. 초안 부록 #36 을 인용만 한다 |
| 4 | **psql 트리거·파티션 실측**(부록 #23·#24) | 위와 같다 — e2e 47 의 INSERT 가능성은 **schema.prisma 의 NOT NULL 칸 대조로만** 검증했고 트리거는 안 봤다 |
| 5 | **화면 원문(`M-01-10` 등)** | 저장소 밖 · UI/UX 관점의 몫 |
| 6 | **`docs/coverage-100/slices/I-13.md`·`lanes.md`·`plan-integration.md` 판독** | 브리프 §4 상 **통합 관점의 몫**이다. §0-2(문서에 §14 를 더해도 되는가)와 문의 162 번호·대역 판정은 **이 리뷰가 판정하지 않았다** |
| 7 | **다른 두 리뷰 파일** | 브리프 §1 ⛔ 독립성 — 열지 않았다 |

---

## 6. 한 줄 결론

**계약 축의 뼈대(요청·응답·헤더·순서·에러코드·404 관행·마이그 0)는 실측 전건이 초안과 일치해 PASS 이고, 하나 남은 갈림길인 「널 갈래를 무엇으로 닫는가」는 «400 으로 뭉치지 않는다»까지는 옳으나 그 선택을 «501 은 정상 코드」라는 틀린 전제로 정했으므로 — Major 2 (근거 교체 · 사실 셋 보강)와 Minor 4 를 반영한 뒤 착수하면 된다.**

| 심각도 | 건수 |
|---|:-:|
| 🔴 Blocker | **0** |
| 🟠 Major | **2** (Major-1 501 논거 · Major-2 500 유지 시 빠진 사실 셋) |
| 🟡 Minor | **4** (접두 겹침 · 409 문구 · 열린 PR 근거 · 빈 `items` 차이) |
| ⚪ Nit | **6** |
