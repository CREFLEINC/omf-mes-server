# I-10 개별 계획안 재검토 — **API 설계 관점**

> 대상 `slices/I-10.md`(992줄) · 브리프 `brief-I-10-review.md` · worktree `docs/coverage-100-i10-plan` · 계약 `a6a87e1` · 실측일 2026-09-07.
> 이 파일만 쓴다(구현·다른 문서·`git` 쓰기 0). 판정 13건 — ✅ 7 · ✏ 6 · ⛔ 0.
> ⚠ 통합자 정정(단말 토큰 발급 실재)을 항목 3·8·11 에 반영했다.

## 1. ⭐⭐ 계보 `lot_relation` 을 안 만든다(§3-9) — ✅ 동의

- **CHECK 원문 실측** — `baseline:1696-1698` `ck_material_usage_target CHECK (production_result_id IS NOT NULL OR output_lot_id IS NOT NULL)`. 계획안 인용이 정확하다. 대안 (ii) 는 INSERT 자체가 불가 ✅.
- `grep -rn 'lot_relation' src/ test/` **0건** 재확인 · `shipment-lot-allocation` 을 문 코드 셋 중 `lot_relation` 을 읽는 것은 **0**(04 종결점이 오늘 이 표에 의존하지 않는다) ⇒ 안 만들어도 오늘 깨지는 코드가 없다.
- **예비안(슬롯 1개일 때만)을 화면이 지지하지 않는다** — `P-02-03` §5-4 정합주(2026-09-03) 원문이 ⌜화면이 **보내지도 받지도 않는다** · `MaterialConsumptionCreate` 에 계보 칸 0 · **계보를 내리는 응답 0**⌝ 이다. 「1:1 스캔만 우선 지원」은 «스캔 UI 의 범위» 문장이고, 슬롯 수는 확정배포가 받은 `lotNos` 길이라 화면이 못 정한다 — 두 축이 다르다. ⇒ 기각 유지, 예비안은 052 회신용으로만 남긴다.
- 대안 (iii) — 계약 문자는 ⌜이 등록과 **한 트랜잭션**⌝ 이라 «시점»을 못박았고, 게다가 후속을 실행할 오퍼레이션이 계약에 0건이라 «계보의 존재»로 읽어도 실행처가 없다. 기각 유지 ✅.

## 2. ⭐⭐ 반출 원장 0(§4-4) — ✅ 동의 · ✏ 근거 한 줄 교체

- **계약 전문 실측** — `MaterialReturn`·`MaterialReturnCreate`·`MaterialReturnLine` 세 스키마와 `POST` description 어디에도 「원장」·「재고를 옮긴다」·`inventoryTransactionLineId` 가 **없다**. `MaterialReturnLine` 속성은 5칸(`materialReturnLineId`·`itemId`·`lotId`·`returnQty`·`uomId`)뿐 ⇒ **멈춤 조건 3 미발동 판정 ✅ 정확**하다(계약은 스스로 일관되고, 어긋나는 것은 물리 칸 + 통합 추론이다).
- ✏ **`requested_at = now()` 의 근거 문장을 바꾼다.** 계획안 §4-5 는 ⌜값이 몇 초 다를 뿐⌝ 이라 가장자리로 갈랐는데, 같은 오퍼레이션 description 이 ⌜**오프라인 대상**이다 — 셸의 outbox 가 들고 있다가 연결되면 그때 보낸다⌝ 라 적었다. 자정을 넘긴 재전송이면 **하루**가 밀린다(C-8 이 막으려던 바로 그 형상). 담을 칸이 없어 결론(서버 시각)은 유지하되, 051 과 대기 15 에 이 문장을 인용해야 해악이 제대로 전달된다.

## 3. 마이그 2(§2-5) — ✅ M-1·M-2 유지 · ✏ 근거 교체(통합자 정정 반영)

**M-1 은 세 안 중 둘에서 필요하고, 필요 없는 한 안은 기각된다** ⇒ 결론 유지.

| 안 | §2 판정 |
|---|---|
| A 계획안 — nullable 완화 + 값 생략 | **채택.** 1단계 본길이나 계약이 침묵 ⇒ 계약 문자 그대로(요구하지 않는다) · 2단계 기준 5(새 개념 0) |
| B I-11 안 — Bearer 단말 토큰을 검증해 채우고 **없으면 400 `REQUIRED`** | ⛔ **반대.** 실측: `terminalToken` 은 `app-공통.json` 에만 정의돼 있고 **`security` 가 계약 7벌의 «0» 오퍼레이션**에 걸려 있다(top-level 도 없음). 계약이 요구하지 않은 인증을 서버가 새로 요구하는 것이고, 오늘 그 헤더를 보내는 클라이언트가 0이라 **투입 전건이 400** 이 된다 — I-4 §5-3 「업무를 없애는 거부」 · `authentication.guard.ts:24-28` 주석도 ⌜계약이 `security` 를 어디에도 걸지 않아 어느 오퍼레이션이 단말용인지 계약만으로 못 가른다⌝ 로 같은 자리를 이미 적었다 |
| C 절충 — 토큰이 오면 채우고 없으면 비운다 | 가능하나 **M-1 이 그대로 필요**하고, 오늘 값은 언제나 NULL 이라 이득이 0이다. I-10 이 헬퍼를 «만들지» 않는다(I-11 과 ∥ 이라 의존을 만들면 안 된다) — I-11 이 `src/auth/terminal-token.ts` 를 세운 뒤 한 줄로 붙이는 것이 싸다(기준 5) |

- ✏ **M-1 의 근거에서 「단말 토큰 발급 축 0건」과 「`mdm.terminal` 0행」을 뺀다.** 발급은 실재한다 — `mdm/terminal/terminal.service.ts:200-223` `issueToken()` 이 `{sub, typ:'terminal', tv}` 를 서명해 낸다(⌜관리웹이 **QR 로 그려** 보이고 기기가 스캔 · **기기는 서버를 부르지 않는다**⌝ · TTL 1년). 남는 근거는 셋이다 — ⓐ 쓰기 스키마에 `terminalId` 칸 0 ⓑ 계약 `security` 0 오퍼레이션 ⓒ 검증 축 0건(`session-resolver` 는 쿠키 `typ:'session'` 만) + 선례 I-7 D1.
- ✏ **M-2 ↔ 상수 셋의 «일관성» 축을 명시한다**(브리프 3·4 가 물은 자리). 가르는 것은 「값 문자열이 있나」가 아니라 **응답에 그 칸이 있나**다: 응답 required 면 값이 있어야 하고(규칙 7 로 키를 생략하면 required 결손이 하나 더 는다 — `terminalId` 로 이미 하나 낸다), 응답에 칸조차 없으면 지어낼 이유가 0이다. 이 한 줄을 §2-5 M-2 와 §8-1 #2·#9 에 적는다.
- 두 릴리스 규칙 **미해당 ✅**(삭제 0 · 완화만) · `npx prisma generate` 필요 ✅ · 드리프트는 `--from-schema-datasource` ✅.

## 4. 상수 셋(ⓚ · 053) — ✏ 하나를 바꾼다

- `material_consumption.status_code='RECORDED'` · `material_return.status_code='REQUESTED'` **✅** — 다만 선례를 고쳐 적는다. I-9 의 `REGISTERED`(시드 실재값)가 아니라 **I-7 `RESULT_STATUS='CONFIRMED'`** 가 같은 등급의 선례다(코드 그룹 0 · 응답 required · 판정에 안 씀 · `production-result.service.ts:143` · `plan-api.md` 418절이 ⌜상수 `'CONFIRMED'`⌝ 로 명시). ⇒ §2 **0단계**로 닫히고 「지어냈다」가 아니다.
- `consumption_type_code='NORMAL'` **⛔ 이 문자열은 안 된다.** 계약이 같은 칸에 `x-no-example` 로 ⌜값 목록이 미확정이라 코드 문자열을 못 박지 않는다 — **임의 코드를 example 로 넣으면 확정값처럼 읽힌다(omf-mes#252 가 실제로 그렇게 읽었다)**⌝ 를, `x-internal-note` 로 ⌜**이 자리가 #252 오독의 원천이다** — 요청자가 읽기 스키마의 `example: NORMAL` 을 정본으로 읽었다⌝ 를 적었다. 응답 required 라 화면이 그 값을 그대로 표시하므로 **서버가 #252 를 재생산**한다. ⇒ 「정상」임을 주장하지 않는 잠정 문자열(예 `UNSPECIFIED`)로 두고 053 에 「축 정합화 뒤 되돌린다」를 적는다. nullable 완화는 ✕ — 계약이 ⌜보내지 않으면 서버가 기본 투입 유형으로 **기록한다**⌝ 라 값을 요구한다(3번의 응답-노출 축과도 맞다).

## 5. 긴급 W/O 투입 전건 400(§3-4 ⓐ) — ✏ 근거·영향 문구 교체(결론 유지)

- 홉 판정 ✅ — `work_order` 에 **`bom_id` 도 `plant_id` 도 없다**(모델 전건 확인). BOM 은 `production_plan.bom_id` 하나뿐이고 공장은 `production_order.plant_id` 하나뿐이다.
- ⭐ **오늘 계획 없는 W/O 를 만들 API 경로가 0이다** — `work-order-write.service.ts:124-131` 이 `productionPlanId` 부재를 **400 `REQUIRED`**(⌜긴급 발행 경로는 공장 컨텍스트 확정(문의 040) 뒤 연다⌝)로 이미 막았고 `release-plan.ts:64` 도 같다. ⇒ §3-4 ⓐ 의 400 은 **I-6 400 의 하류 거울**이지 새 거부가 아니고, 채번 `plantId` 도 언제나 풀린다.
- ✏ 그러므로 **알려둘 것 ⓒ 의 「`P-02-12` 의 주 시나리오가 막힌다」는 과장**이다 — 그 화면(§4-A ⌜`production_plan_id` 를 비우면 **서버가 자동 생성**⌝)은 W/O 발행 단계에서 이미 막혀 있다. 문구를 「**040 이 풀리면 발행과 투입이 함께 열린다** — 같은 문의의 상·하류다」로 고친다. 대안(`bom_component_id` NULL 로 기록만)은 계약 ⌜못 찾으면 거절한다⌝ 와 정면으로 다르므로 ✕.

## 6. 오투입 검사 나머지(§3-4 ⓒ~ⓕ) — ✏ ⓕ 를 뺀다

- ⛔ **ⓕ `uomId ≠ bom_component.uom_id` → 400 은 근거가 서지 않는다.** 계약 `uomId` 는 **설명이 없다**(`example: 1001` 뿐). 정의를 준 것은 화면 §5-6 이고 ⌜`input_qty` + `uom_id` ← **저장(기준단위)**⌝ 이라 «품목의 저장 단위»로 못박았다 — `bom_component.uom_id` 는 «명세 단위»이고 물리적으로 다른 칸이다(`item.base_uom_id` 실재 · 두 칸이 갈릴 수 있게 설계돼 있다). 두 축이 다른 BOM 이 하나라도 있으면 가장자리가 아니라 **본길 400** 이 된다. `planning.bom_component` **0행**이라 같은지 실측할 수도 없다. ⇒ **uom 존재 검사만** 하고 정합 400 은 빼며, 알려둘 것에 한 줄(「BOM 단위와 저장 단위의 관계를 서버가 보지 않는다」)을 더한다. ⓕ 를 남긴다면 e2e 는 픽스처가 같은 uom 을 심어 **절대 못 잡으므로** 단위 테스트 이름으로 반드시 박아야 한다.
- ⓒ ✅ — `BOM_COMPONENT_SELECT`(4칸) 무변경으로 되고 `sequence_no` 는 `orderBy` 라 select 가 필요 없다(코어 무변경 ✅). ⓓ ✅ · ⓔ ✅ — `LOT_STATUS` 4값(`DEFECTIVE`·`INSPECTION_PENDING`·`NORMAL`·`SCRAPPED`) psql 실재 확인, 화면 문장과 일치한다. ⓖⓗ 안 본다 ✅.
- ✏ **알려둘 것 한 줄 추가** — `bom_component` 에 `actual_use_process_id`·`routing_operation_id` 가 **실재**하는데 §3-6 ⓒ 가 `actual_use_process_id` 를 «W/O 의 공정»으로 채우면 값이 언제나 W/O 공정과 같아진다 ⇒ 화면 §5-3 이 요구한 「교차 투입을 기록한다 · 통과한 것 중 **기록만 되는 것을 표시한다**」가 데이터로 성립하지 않는다. 계약 문자는 그대로 따르되(⌜서버가 이 W/O 의 공정으로 채운다⌝) 이 사실을 알려야 한다.

## 7. 수령 라인 귀속·상한(§3-5) — ✅ 동의

최신 PK 귀속 ✅(화면이 이 축을 ⌜무관⌝ 으로 못박아 틀려도 업무가 안 갈린다) · 상한 ✕ ✅(누계 칸 0 · A-21) · `material_consumption` 의 인덱스는 `(lot_id, occurred_at)`·`(work_order_id, occurred_at)` **둘뿐**이라 `shopfloor_receipt_line_id` 무인덱스 ✅.

## 8. 주체·멱등·409(§3-7·§3-12) — ✅ 셋 · ✏ 409 의 «미루는 사유»

- `terminalId` 키 생략 ✅ — `plan.md` §5 규칙 7 그대로다. 응답이 계약 required 를 못 맞추는 것은 오늘 검사에 안 걸린다(실측: `contract-validator.ts` 는 `requestBody` 만 본다 — 응답 검증 코드 0).
- `resolveWorker` 둘째 사본 ✅ / `assertWorkerNo` 넷째에서 공용화 — I-9 가 세운 「셋째까지 기다린다」와 어긋나지 않는다(전자는 둘째, 후자는 넷째).
- 멱등 둘 다 ✅ — `plan-integration.md` 303 이 `work_session`(전역 UNIQUE) 문장이라는 가름이 맞다. I-7 `production-result.service.ts:144-145` 가 같은 처리 + 같은 주석이다.
- ✏ **409 `code` 결손을 미루는 사유를 바꾼다.** 실측하니 「코어라서 못 고친다」가 아니다 — `ConflictException` 이 **이미 선택 `code` 를 받고**(`ConflictExtra`), `DUPLICATE_KEY`·`VERSION_CONFLICT`·`INVALID_STATE` 는 **네 계열 enum 에 공통**이며 `code` 를 required 로 안 쓴 계열(app·logistics·mdm·equipment)도 `additionalProperties` 를 닫지 않았다 ⇒ 전역 기본값 **두 줄**로 고쳐진다. 진짜 비용은 **`conflictCause` 를 단언하는 e2e 가 33파일**이라는 회귀 면이다. 후속 소형 PR 브리프에 그 문장으로 적어야 크기를 옳게 잡는다.

## 9. 반출 권한 `P-02-03` 임시 등록(§4-1) — ✅ 채택 · ✏ 근거를 «선례»로 승격

- ⭐ `manual-permissions.ts` 에 **같은 형상의 선례가 둘** 있다: `PUT /logistics/goods-issues/{id}/lines`(⌜부르는 화면이 실제로 0건이나 `PermissionGuard` 가 등록을 요구한다(**미등록이면 500**)⌝) · `PUT /logistics/inbound-receipts/{id}`(⌜부르는 화면이 «없다»(**문의 026**) — 화면이 정해지기 전까지 **등록 화면으로 잠정 등록**한다⌝). ⇒ 이 판정은 §2 **0단계에서 닫힌다.** 「본길 · 인가 정책을 임의로 지음」이 아니라 「저장소가 이미 두 번 한 잠정 등록의 셋째」다 — §4-1 의 「가장 좁은 문」 문구를 이 선례 인용으로 바꾸면 050 도 «지어냄 고백»이 아니라 «세 번째 같은 요청»이 된다.
- 대안(가드가 예외 통과) ⛔ — 계약이 403 을 선언한 오퍼레이션을 무권한 통과시키면 그 403 이 영원히 안 나고, 「등록 안 하면 500」이라는 가드의 존재 이유가 사라진다. `operation-permissions.spec.ts` 도 빈 배열을 막는다(실측) · `covered.length` 하한은 152 라 +1 은 통과 ✅.

## 10. 반출 기타(ⓙ) — ✅ 대부분 · ✏ 둘

- ✏ **「같은 공장 검사」는 계약 근거가 0이다** — `sourceLocationId`·`destinationWarehouseId` 둘 다 description 이 없다(실측). 결론(400)은 §2 기준 2·5 로 서지만 **계약 밖 거부**이므로 **알려둘 것에 한 줄**을 더한다(오늘 18건에 이 자리가 없다). `line_no` 서버 1..N ✅ · `(item,lot)` 중복 400 ✅ · 잔량 대조 ✕ ✅ · 목록 `lines` 실음 ✅ · 창고 유형 ✕ ✅.
- ✏ **공용화 둘을 처음부터 후속 소형 PR 로 뗀다.** ① 은 ~332 로 예산 350 에 18 밖에 안 남는데 사본 8벌 회수는 **여덟 파일**을 함께 고쳐 리뷰 면이 는다. 계획안의 「초과 위험이 실측되면 떼어낸다」는 이미 8파일을 고친 뒤라 되돌리기가 비싸다 ⇒ ① 을 **~322 로 시작**한다(`worker-no.ts`·`query-cast.ts` 는 반출 `assertWorkerNo` 넷째가 들어간 «뒤» 소형 PR).

## 11. 문의 6건(§8-2) — ✏ 054 를 고쳐 쓴다

- **054 — 본문의 전제 하나가 틀렸다.** 「발급·검증 축이 0건」이 아니라 **발급은 있고 검증만 없다**(3번 실측). 새로 물을 것 셋: ⓐ 계약이 `terminalToken` 을 **정의만** 하고 `security` 를 7벌 **0 오퍼레이션**에 걸었다 — 어느 경로가 단말 인증을 요구하는지 계약이 말하지 않는다 ⓑ `issueToken()` 이 내는 것은 **QR 등록 토큰**(1년·`tv` 회전 · ⌜기기는 서버를 부르지 않는다⌝)인데, 그것이 곧 API 의 `Authorization: Bearer` 인지 계약·화면 어디에도 없다 ⓒ 같은 계약 안의 **required 비대칭**(`ProductionResult.terminalId` ✕ / `MaterialConsumption`·`WorkSession` ✓). `mdm.terminal` 0행은 개발 DB 사정이라 뺀다. 또 I-7 이 이미 알려둘 것으로 보고한 자리다(`design-inquiries/README.md` (I-7) 줄 ⌜`terminal_id` 영원히 NULL(단말 토큰 없음 · 게이팅 2플래그 미검사)⌝) ⇒ 054 는 「승격」으로 적는다.
- ✏ **I-11 과의 정합을 통합자에게 보고할 것** — I-11 이 `POST /production/work-sessions` 에서 「토큰 없으면 400 `REQUIRED`」로 가면 같은 «계약 밖 인증 요구»가 되고, 두 슬라이스가 같은 칸을 반대로 처리한다. 054 는 두 오퍼레이션을 **함께** 걸어야 한다.
- 050 ✅ 신규(9번의 선례 인용을 얹어서) · 051 ✅(2번의 오프라인 문장 추가) · 052 ✅ — 셋을 묶는 것이 맞다(뿌리가 `output_lot_id` 하나다) · 053 ✅(4번의 `x-no-example` 인용을 얹는다) · 055 ✅. 문의 14 표에 두 행 추가는 I-2(`purchase_order_no`)·I-3(`inbound_receipt_no`)·I-6(두 행) 선례와 같다 ✅.

## 12. e2e·PR·모델(§7·§11) — ✅ 분할 · ✏ ① 의 모델

- PR 3 · 스택 ① → (② ∥ ③) ✅ · ②·③ **opus ✅**(계보·원장·권한 판정이 든다).
- ✏ **① 은 sonnet 이 맞다.** 마이그가 `ALTER … DROP NOT NULL` **두 줄**이고 나머지는 조회 4 · 뷰 2 · 배선(README §4 의 「구현 — 조회 GET·뷰·컨트롤러·기존 패턴 복제 = sonnet」에 정확히 든다). §4 의 「마이그레이션 = opus」는 «원장·상태기계»와 묶인 항목이지 NOT NULL 완화를 겨눈 것이 아니다. 10번의 ✏(공용화 분리)를 함께 받으면 ① 은 ~322 의 순수 복제라 sonnet 로 충분하고, 마이그 커밋만 병합 전 한 줄 보고(README §1-5)로 덮인다.
- e2e ✅ — DB 직접 단언 셋 · `TRUNCATE` 금지 ✅. ⚠ 픽스처가 `bom_component.uom_id` 와 투입 `uomId` 를 같은 값으로 심으므로 6번 ⓕ 의 위험은 **e2e 로 절대 안 잡힌다**. 「수령 없이 투입」(귀속 NULL)과 「귀속 있음」 둘 다 이름에 있다 ✅.

## 13. `plan-api.md` 와 어긋나는 자리 — 실측 3

- ⭐ **§1-7 의 근거를 `plan.md` §5 규칙 8 로 바꾼다** — 통합 정본이 이미 ⌜원장 판별자 4값 고정. **투입**·실적·출하는 **원장 안 지남**⌝ 이라 적었다. 계획안은 `plan-integration.md` 107 만 인용했는데, 규칙 8 을 인용하면 이 자리는 「통합 계획서를 뒤집는다」가 아니라 「`plan-api.md` 418 한 줄이 통합 정본과도 어긋난다」가 된다(고칠 곳도 한 줄로 줄어든다).
- ⭐ **§10 대조표에 빠진 행 하나** — `plan.md` §5 **규칙 9 의 예외 목록**(⌜헤더가 주체 칸의 «유일한 원천»이고 POP 단말만 부르는 자리⌝)에 오늘 4건(`production-results`·`lots:complete`·`:pick`·`shopfloor-receipts`)이 열거돼 있고 `POST /production/material-consumptions` 가 **없다**. 이 슬라이스가 다섯째(저장형)와 여섯째(반출 — 읽고 버림형)를 더하므로 **계획 PR 이 규칙 9 문장을 함께 고쳐야 한다**. §10 말미의 「함께 고칠 자리 10」에 이 한 줄을 더한다.
- `plan-api.md` 425~436 S16 표의 ETag 열은 **맞다**(`POST` 둘 「—」) — 어긋난 것은 `plan-uiux.md` U23 뿐이다(§10 #7 정확) · 1104·1105 채번 「❌」 ✅ · 418 은 위 첫 줄대로 삭제.

---

**재수립 결과(5줄)**
1. **I-10.md 에 반영할 수정 8건** — ① `consumption_type_code` 상수를 `NORMAL` 에서 빼기(계약 `x-no-example`·#252) ② 오투입 ⓕ(`uomId≠bom_component.uom_id` 400) 삭제 + 알려둘 것 2줄(BOM 단위 축 · 교차 투입 축 미기록) ③ M-1 근거에서 「발급 축 0건·`terminal` 0행」 빼고 「`security` 0 오퍼레이션·검증 0건」으로 교체 + 안 B/C 기각표 ④ 긴급 W/O 400 을 「I-6 400 의 하류 거울」로 재서술하고 알려둘 것 ⓒ 과장 수정 ⑤ §4-1 근거를 `manual-permissions.ts` 선례 둘로 승격 ⑥ 상수 둘의 선례를 I-7 `CONFIRMED` 로 교체 + 「응답 노출 여부」가 상수/완화를 가른다는 한 줄 ⑦ 공용화 둘을 후속 소형 PR 로 선분리(① ~322) ⑧ 409 미루는 사유를 「e2e 33파일 회귀 면」으로 교체 · 알려둘 것 **18 → 21**(같은 공장 검사 포함).
2. **plan.md 에 반영할 것** — 45행 마이그 「—」→「2(NOT NULL 완화)」 및 모델 「opus」→「① sonnet · ②③ opus」 · **§5 규칙 9 예외 목록에 두 줄 추가**(투입 저장형 · 반출 읽고 버림형) · §5 규칙 8 은 그대로 두고 `plan-api.md` 418 한 줄을 삭제 · 210·212행을 「050·055 로 발행」으로.
3. **문의 최종 6건**(050~055 유지) — 단 **054 는 전제를 고쳐 다시 쓴다**(발급 실재 · 없는 것은 검증과 `security` 선언 · QR 등록 토큰이 API Bearer 인지 미정 · required 비대칭 셋)이고 `POST /production/work-sessions` 를 **함께** 건다. 051 에 오프라인 재전송 문장, 053 에 `x-no-example` 인용을 얹는다. 기존 인용 4(대기 15 누적 11 · 문의 14 두 행 · 040 · `P-02-03` §8 미결)는 그대로.
4. **PR 분할·모델 최종안** — **3개 · 스택 ① → (② ∥ ③)** 유지. ① 마이그2+조회4+뷰2+배선 **~322 · sonnet**(공용화 둘은 후속 소형 PR) · ② `POST` 투입 ~263 · **opus** · ③ `POST` 반출+권한 ~189 · **opus**. 후속 소형 PR 둘 예고(공용화 · 409 `code`).
5. **멈춤 조건 — 미발동 ✅.** ① 마이그 2 는 삭제 0·완화만이라 두 릴리스 규칙 미해당 ② 게이트 미실행 ③ **계약끼리의 모순 0** — 반출 세 스키마와 `POST` description 전문을 훑어 「원장」·「재고를 옮긴다」·`inventoryTransactionLineId` 가 **한 자리도 없음**을 실측했다(계약은 스스로 일관되고, 어긋나는 것은 물리 칸 + 통합 추론이다).
