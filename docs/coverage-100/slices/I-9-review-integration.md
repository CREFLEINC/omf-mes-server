# I-9 개별 계획안 — **통합 관점** 재검토 (`plan-integration.md` 저자 입장)

> 대상 `slices/I-9.md`(625행) · 실측 worktree `docs/coverage-100-i9-plan` · main `abf8ab4` · 계약 `a6a87e1`.
> 판정 11건: ✅ 5 · ✏ 5 · ⛔ 1. **구현 착수 전 반드시 닫을 것은 판정 2 하나**다.

## 1. 문의 3건 — ✏

- **048 ✅ 새 문의가 맞다.** `plan.md:216` 이 「출고·생산창고 입고 한 단말 오프라인 큐 순서 | **I-9** | UI/UX K」로 이 슬라이스를 **발행처로 이미 지목**했다 — 지목은 「누가 쓰나」이지 「이미 냈다」가 아니다. 서버 몫(「앞이 없으면 400」)이 충분한지는 서버가 판정할 수 없다(단말 회수 축 0건) ⇒ 논지가 선다.
- **049 ✅ 문의다.** 반론(「등록이 곧 확정」 = `POSTED`)은 실측으로 선다: `transitions.ts:196~213` 에 `logistics.shopfloor_receipt.status_code` 키 없음 · `document-type-registry.ts:44~88` `DOCUMENT_TYPES` 9종에 없음 ⇒ 옮길 액션이 코드에도 계약에도 0. 그리고 계약 `statusCode.description` 이 `POSTED`=「**전기완료**」라 못박았다(jq 실측) — 원장 0 인 전표에 쓰면 거짓이다(I-5 「`POSTED` 줄은 원장 행이 있을 때만」과 충돌). `'REGISTERED'` 유지 ✅.
- ✏ **「차이 0 인데 사유」를 049 에 묶는 것은 축이 다르다** — 049 는 «상태 축», 그것은 «라인 검증 축»이다. **050 으로 옮긴다**(050 이 이미 라인 수량 의미론이다).
- **050 ✅ 046 과 안 겹친다.** 046 은 `material_issue_request_line.issued_qty` 를 **올리는 오퍼레이션이 0건**(`material-issue-request.service.ts:96` 주석)이고, 050 은 서버가 아는 값을 클라이언트가 **보낸다**다. 표도 문제도 다르다 ⇒ 별건 ⭕.
- ✏ **문의로 올릴 것 하나가 빠졌다** — 판정 4 의 실측(수령 전표가 취소 후속 판정에 안 잡힌다). **049 ⓒ 를 그 실측으로 바꿔 쓴다**(추정이 아니라 코드 실측이 된다).
- 해소 보고(`M-01-09` §8 #3 절반) ✅ — 시드 `VARIANCE_REASON` 6행 실재. 대기 15 누적 10 ✅.

## 2. ⭐ 「한 출고 = 수령 하나」 ↔ 「라인 일부만」 — **⛔ 양립하지 않는다. 계획을 고쳐야 한다**

실측:
- `M-01-09` §3 레이아웃이 **출고의 전 라인을 편다**(「GI-…0042 · **5라인**」 + 라인마다 수령 입력칸).
- §5-6 「입고 확정 | **1라인 이상 수령**」은 «활성 조건» 열이다 — 버튼 활성 규칙(«수령 수량이 든 라인 ≥ 1»)이지 «본문에 실을 라인 수»가 아니다. 「일부만 실어도 된다」는 문장은 화면 어디에도 없다.
- §5-2 가 부족 수령을 **`variance_qty` + 사유**로 닫았고, `ck_shopfloor_receipt_qty`(baseline `:1522`)가 `received_qty >= 0` 이라 **「하나도 못 받은 라인」도 0 + 사유로 실린다**.

⇒ §3-3 ⓐ 의 「다 실을 필요 없다」는 §5-6 오독이고, §3-8 의 「둘째 수령 400」과 겹치면 **빠진 라인은 영원히 수령 불가**다(재수령 업무가 없다고 계획이 스스로 적었다).

**대안 판정**
| | §2 판정 | 결론 |
|---|---|---|
| ⓐ **전 라인 필수**(그 출고의 `goods_issue_line` 전건이 각 1회) | 1단계 가장자리 → **기준 2**(거부) + **기준 4**(라인 생략 = 차이를 조용히 없앤다 · `variance_qty` 가 아예 안 남는다) + **기준 5**(새 개념 0) | ⭕ **채택 권고** |
| ⓑ 라인 축 중복 금지(둘째 전표 허용) | 기준 2 동률이나 **기준 5 에서 진다** — 「한 출고 여러 수령」이라는 개념이 새로 생기고 `M-01-09` §4-B 「FK NOT NULL — **1:1**」·§8 #2 「**1:1 로 시작**」과 정면 충돌 | 예비안(§8 #2 회신이 「분할 허용」이면 이쪽) |
| ⓒ 계획자안 유지 | 업무가 죽는다 — 거부가 아니라 «구멍»이다 | ✕ |

**⇒ ⓐ 로 고친다**: 라인 검증에 「그 출고의 라인 전건이 정확히 한 번씩 실려야 한다(빠지면 400 `LINE_REQUIRED`)」를 더하고, §3-3 ⓐ 의 ⭐ 문장을 「1라인 이상 = **수령 수량 > 0 인 라인이 1 이상**」으로 고쳐 적는다. §3-8 은 그대로 선다.
⚠ 남는 위험은 문의에 실는다 — 계약 `ShopfloorReceipt.lines.description` 이 「한 **W/O** 에 수령 전표가 여러 건 선다」라 적었고 `M-01-09` §5-5 ⚠ 가 「한 출고가 여러 W/O 를 담으면 수령을 나눠야 한다」를 남겼다(§8 #2 미결). ⓐ 는 그 형상을 담지 못한다 ⇒ **049/050 과 별도로 §8 #2 를 인용해 명시**한다.

## 3. `issuedQty` 대조 400 — ✏(판정은 ✅, 근거 하나를 바꾼다)

칸 이름 ✅ **`goods_issue_line.issue_qty`**(`schema.prisma:781`). 에러 코드 5종 전건 실재 ✅ — `error-codes.ts:9`(`REQUIRED`)·`:10`(`RANGE`)·`:13`(`INVALID`)·`:15`(`STATE_LOCKED`)·`:23`(`LINE_REQUIRED`).
대조 400 ✅ — 기준 2·4 가 같은 답. ✏ **「출고 정정으로 낡은 값」 우려는 실측상 안 난다**: `M-01-09` §8 #1 이 ⌜라인 치환(`PUT …/lines`)은 **쓸 수 없다** — `postImmediately` 라 전표가 항상 전기완료⌝ 라 적었다 ⇒ 전기된 출고 라인의 `issue_qty` 는 안 바뀐다. 그러므로 **「업무를 없애는 거부」에 안 걸린다**(대조가 더 강해진다). 대신 **문의 050 ⓒ 의 「출고 라인이 나중에 정정되면 둘이 갈린다」 문장을 고쳐야 한다** — 오늘 그 경로가 0건이다(취소→재출고면 수령도 새 전표다).

## 4. 출고 상태 게이트 — ⛔ **빠진 실측이 있다**

`POSTED` 만 ✅ — `transitions.ts:12~22` 가 `POSTED → CANCEL_REQUESTED → CANCELLED` 를 열어 두므로 그 둘도 게이트가 함께 막는다(맞는 처리). 400 vs 404 ✅ — 계약 `POST` responses = `201,400,403,409`(jq 실측 · 404 없음), I-3·I-4·I-8 과 같은 선례.
✏ `M-01-09` §6 은 갈래가 **둘**이다 — 「출고 전표를 못 찾음」(행 없음 → 400 `INVALID`)과 「등록만 된 출고」(행 있음 → 400 `STATE_LOCKED`). 둘 다 400 이므로 **`field`·`code` 로 갈라야** 화면이 §6 의 두 안내를 가른다. 계획에 그 문장을 명시할 것.
⛔ **수령 뒤 출고 취소가 열려 있다.** `cancel-eligibility.service.ts:141~157` 의 후속 판정은 `(source_document_type_code, source_document_id)` 축의 세 표(입고·출고·피킹)만 세고, LOT 축은 `:51` 이 `GOODS_ISSUE` 를 **명시적으로 뺐다**. `shopfloor_receipt` 는 원천 다형 축이 아니라 **직접 FK** 라 어느 프로브에도 안 잡힌다 ⇒ **수령 전표가 붙은 `POSTED` 출고를 I-5 가 그대로 취소하고 역트랜잭션까지 낸다. 남은 수령 전표는 영원히 `REGISTERED` 이고(취소 경로 0) I-10 투입이 그 위에 붙는다.**
⇒ 이 슬라이스가 고칠 자리는 아니다(코어/I-5 파일 · 모델 상향). **§8-3 알려둘 것에 실측으로 추가 + §9 인계표의 I-5/I-13 행에 추가 + 049 ⓒ 의 근거로 교체.**

## 5. `FOR UPDATE` 원시 SQL · `runIdempotent` — ✅(단서 한 줄)

선례 ✅ 도메인 서비스가 직접 쓰는 것이 관행이다 — `lot-complete.service.ts:115~121`(**헤더 행 잠금 + 게이트** · 가장 가까운 모양) · `work-order-write.service.ts:64~75` · `purchase-order.service.ts:274~304` · `document-cancel.service.ts:150~176` · `picking-pick.service.ts:77`.
`runIdempotent` ✏ **반만 맞다** — `idempotency.service.ts:68` 이 `$transaction` 을 여는 것은 사실이나 `master-write.ts:33` 이 `() => work()` 로 **tx 클라이언트를 버린다**. 커넥션 2 라는 셈은 ✅ 이지만 §3-1 의 문장만 읽으면 구현자가 tx 를 물려받는 줄 알 수 있다 ⇒ 「**tx 를 넘겨받지 못하므로 서비스가 자기 `$transaction` 을 연다**」를 한 줄 더 적을 것(MIR `:63` 과 같은 모양). 덤: `idempotency.service.ts:52~56` 주석(「기록이 업무와 같은 트랜잭션에 든다」)이 `runIdempotent` 경로에서는 사실이 아니다 — 저장소 차원 자리라 알려둘 것 후보.
UNIQUE 부분 인덱스 대안 ✅ **안 거는 것이 맞다** — README §5 「물리를 고친다」는 «계약과 물리가 다를 때»의 규칙이고 계약·화면 어디에도 유일성 문장이 없다(§8 #2 는 미결) ⇒ §2 기준 3 이 이긴다. 판정 2 를 ⓐ 로 닫아 「한 출고 = 수령 하나」가 업무 규칙으로 서면 **UNIQUE(`goods_issue_id`) 는 후속 마이그 후보**로 §8-3 ⓕ 에 남긴다.

## 6. `received_by` · `X-Worker-No` — ✅(문서 반영 하나 누락)

`plan.md` §5 규칙 9 원문 실측: 예외 조건이 「헤더가 «주체 칸의 유일한 원천»이고 POP 단말만 부르는 자리」다. I-9 는 `received_by` FK 가 `app_user`(`schema.prisma:1377`)라 **첫 조건에 안 맞는다**. 그러나 같은 규칙이 `:pick`(담을 칸 **0**)을 I-8 R-16 으로 이미 예외에 넣어 「계약 `required` + POP 전용」으로 넓혔다 ⇒ **일관 ✅**. `mdm.worker` 미조회 ✅(`picking-pick.service.ts:158~166` 주석 그대로) · 셋째 사본 ✅(5줄 · 두 벌이 글자 그대로 같다 — 공용화는 도메인 둘을 이 PR 이 함께 고치게 만든다).
✏ **§10 「함께 고칠 자리」에 `plan.md` §5 규칙 9 예외 목록 3→4자리 추가가 빠졌다.**

## 7. 채번 — ✅

계약 `shopfloorReceiptNo.example` = `SR-2026-000077`(jq 실측) ⇒ **접두어 `SR` 의 근거로 충분**하다(패턴이 다른 것은 무관 — `GI`·`WO`·`MIR` 도 같은 등급으로 들어왔다). `plantId` 왕복 ✅ — `work_order.production_plan_id` 가 **nullable**(`schema.prisma:2880`)이라 못 푸는 W/O 가 실재하고 400 `INVALID`(문의 040) 가 맞다. `DEFAULT_PREFIX` 한 줄은 **코어 파일**이지 README §4 의 코어 4축(원장 쓰기·상태기계·posting·마이그)이 아니다 ⇒ 모델 상향 없음 ✅.

## 8. 조회 2 — ✏(선례 모양 하나 정정)

where 4 매핑 ✅(`picking-query.service.ts:37~43` 그대로) · `statusCode` 문자 그대로 ✅(`:40` 주석) · PK 역순 ✅(`:49`) · 상세 두 벌 ✅ · 라벨 3칸 조인 ✅(계약이 readOnly 로 실재).
목록 `include` 의 N ✅ — `size` 상한은 **`MAX_SIZE = 200`**(`pagination.ts:14`·`:45`), Prisma 중첩 include 는 관계마다 한 문장이라 **왕복은 상수**다.
✏ 선례 인용이 틀렸다 — `PICKING_LINE_INCLUDE`(`picking-view.ts:15~19`)는 **라인 조회에 붙는 include** 이고 계획의 `SHOPFLOOR_RECEIPT_LINE_INCLUDE` 는 **헤더에 붙는 중첩 include** 다. 이름을 `SHOPFLOOR_RECEIPT_INCLUDE`(헤더용)로 하고 **라벨 include 를 라인용으로 따로 두면** 상세(라인만 다시 읽는 자리)와 `POST` 되읽기가 같은 상수를 쓴다.

## 9. e2e — ✏(네 자리)

- ✏ **픽스처 사슬 인용이 틀렸다.** `logistics-picking.e2e-spec.ts:517~613` 에는 **`production_order`·`production_plan` 이 없고 `work_order.production_plan_id` 도 안 채운다**(실측). 그대로 복제하면 §3-7 의 `plantId` 가 안 풀려 **모든 `POST` 가 400** 이다. 인용할 선례는 **`logistics-material-issue-request.e2e-spec.ts:520~549`**(`production_order` → `production_plan`(bom·routing) → `work_order.production_plan_id`).
- ✏ **출고 직접 INSERT 의 NOT NULL·CHECK 를 다 안 적었다.** `goods_issue` NOT NULL 7칸(`goods_issue_no`·`issue_type_code`·`source_document_type_code`·`source_document_id`·`source_warehouse_id`·`issued_at`·`status_code` — baseline DDL) + **`ck_goods_issue_destination`**(`20260901090000…:25~26` — 도착지 두 칸이 함께 널이거나 함께 값) + `goods_issue_line` NOT NULL 7칸(**`line_no`·`source_location_id` 포함** · `uq_goods_issue_line`). §7-1 이 둘만 적었다 ⇒ 전건 열거로 고친다.
- ✏ **「원장 무변화」 단언이 지금 상태로는 공허하다.** 픽스처가 `inventory_balance` 행을 **안 세운다**(정리 순서에만 있다) ⇒ 「`on_hand`·`version_no` 가 그대로」를 비교할 대상이 없다. 잔액 행 하나를 직접 INSERT 하고 전후 비교할 것. 그리고 `inventory_transaction` 은 **전역 count 0 이 아니라 픽스처 `lot_id` 로 좁혀** 센다(동시 스위트가 남의 원장을 남긴다).
- **TRUNCATE 안 쓰는 판정 ✅** — 이 스위트가 원장 행을 0건으로 유지하면 `DELETE LIKE` 로 닫히고, `logistics-picking.e2e-spec.ts:670~672` 의 TRUNCATE 가 남의 스위트를 비우는 문제(I-8 §11-3)를 안 늘린다.
- **M2 ⑧→⑨ 를 통합자에게 넘기는 것 ✅** — `plan.md` §1 이 「M2 체인 e2e | **fable**」로 소유자를 못박았고 §2 M2 행이 그 체인을 적었다. ⛔ **대안(이 스위트에 `postImmediately` 한 케이스 추가)은 반대** — 원장이 생겨 같은 파일의 「원장 무변화」 단언과 정리(TRUNCATE 부활)를 동시에 깬다. ✏ 다만 §7-3 의 이름 「⭐ **M2 마디** — …」는 픽스처 출고(원장 0)라 실제 마디가 아니다 ⇒ 이름에서 「M2 마디」를 빼고 §9 통합자 행만 남긴다.
- 이름 커버 ✏ — §3-3 8검사는 단위 13 이 덮는다. **빠진 셋**: 「`CANCELLED`/`CANCEL_REQUESTED` 출고면 400 `STATE_LOCKED`」·「없는 `destinationLocationId` 면 400 `INVALID`」·(판정 2 를 ⓐ 로 닫으면)「출고 라인이 빠지면 400」.

## 10. PR 분할·모델 — ✏

스택 ①→② ✅ — ② 의 201 이 `ShopfloorReceiptDetailResponse` 라 ①의 매퍼·include 를 **전부 현역으로** 쓴다(독립이면 매퍼 두 벌 → 병합 시 합침). 예산 ~226/~199 ✅(350·400 아래).
**sonnet ×2 ✅** — README §4 의 「구현 — 코어(원장 쓰기·상태기계·posting·마이그레이션)」 네 축이 전부 0이고, ②의 15갈래는 `material-issue-request.service.ts:117~176`(검증 모아 던지기 · FK 그물 · `assertCodeValues`)과 `lot-complete.service.ts:115~121`(행 잠금)의 **복제**다. 단서: **판정 2 를 ⓐ 로 닫은 뒤에 스폰한다** — ⓒ 로 두면 ②가 「영원히 못 받는 라인」을 코드로 굳힌다(README §6 「리뷰 Major 가 계획서 구멍이면 판정을 먼저 적는다」).
✏ **「함께 고칠 통합 계획서 자리」가 6 이 아니라 9 다** — 빠진 셋: ⓐ `plan.md` §5 규칙 9 예외 목록 **3→4자리** ⓑ `plan-integration.md` §1-5 머리 「원장을 실제로 지나는 **17건**」 → **16** (`shopfloor-receipts` 를 그 표에서 빼야 133행 수정이 완성된다) ⓒ `plan.md` §7 216행 을 「**048 발행**」으로 표시.
인계 6행 ✅ — 단 I-5/I-13 행에 판정 4 의 실측을 더한다.

## 11. 통합 계획서와 어긋나는 자리 중 **구현에 영향 주는 것**

| `plan-integration.md` | 실측 | 처리 |
|---|---|---|
| 36~44행 체인 ⑨ (`goods_issue_line_id` 축 · `variance_qty` 파생) | ✅ 그대로 선다 | 판정 2 를 ⓐ 로 닫으면 ⑨ 가 **1:1 로 굳는다** — 그 문장을 ⑨ 에 적는다 |
| 107행 「투입은 원장을 안 지난다 — 재고는 앞의 출고에서 이미 움직였다」 | ✅ | 무변경 |
| **133행** — `POST /logistics/shopfloor-receipts` 가 **「원장을 실제로 지나는 17건」 표 안에** 있다 | ⛔ I-9 판정으로 **그 표에서 빠진다** | 표에서 제거 + 머리 17→16 + ⚠ 6건 목록에 추가(6→7) · 계획 §10 #6·#7 이 절반만 지목했다 |
| 286~296 「기록만 · 뒤집히면 3관점 재수립」 | ✅ 뒤집을 근거 0(원장 FK 칸이 계약·물리 둘 다 0) | `plan.md` §0 #13 유지 + 「실측 확인」 한 줄 |
| **322행** 「I-13 의 `IN_TRANSIT` 가 **I-9 판정의 선례**가 된다」 | I-9 가 먼저 서고 **선례 없이** 기준 1 로 닫았다 | ✏ 계획이 「방향이 반대」라 적었으나 정확히는 **문장을 지운다**(I-13 은 더 이상 I-9 의 선례가 아니다) |
| 779~783 I-9 3건 목록 | ✅ 계약 실측과 일치 | 무변경 |
