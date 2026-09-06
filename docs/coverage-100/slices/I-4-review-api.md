# I-4 재검토 — **api 관점**

대상: `docs/coverage-100/slices/I-4.md`(894줄) · 브리프 `brief-I-4-review.md` 「판정할 것」 7항목.
자기 관점 계획서: `plan-api.md` S04(111~141) · §5.1 A 표(744~760) · §5.3 ③(996~1000) · 1090행.
실측 기준: 브랜치 `docs/coverage-100-i4-plan` · `contracts/COMMIT.txt` = `a6a87e1`.

---

## 1. 문의 030·031 이 새 문의인가 — ✅ 동의 (+✏ 030 본문 한 줄)

- **030 신규 맞다.** 022(결재선 사업부)·023(P/O 상신 뒤 잠금)과 «축이 다르다» — 022 는 *어느 결재선인가*,
  023 은 *상신 뒤 잠글까*, 030 은 ***승인을 걸어야 하는 전표인지 가르는 축 자체가 없다***. 겹치지 않는다.
- ✏ **030 갈래 ① 의 문장을 바꿔야 한다.** I-4.md 는 「폐기를 가리키는 `reasonCode` 값이 없다」로 적었으나
  계약은 그 값 목록을 **닫지 않았다** — `GoodsIssue.reasonCode` description 실측:
  「값 = IQC_FAIL·…·OTHER (2026-09-03 코드 사전 등재) — ⭐ **고객이 늘린다** — 위 값은 초기 시드다(G-31)」.
  ⇒ 「없는 축」이 아니라 **「아직 안 실린 값」**이다. 두 가지가 따라온다:
  ① 문의는 「폐기 사유 코드값을 달라」로 좁혀 물어야 답이 온다.
  ② 서버는 그 값이 오면 **코드를 안 고치고** 게이트가 서야 한다 ⇒ 「어느 `reasonCode` 가 승인을 타는가」는
  **상수가 아니라 데이터**여야 한다(`judgment_type_control.requires_approval` 이 이미 같은 모양이다 —
  `schema.prisma` 실측). 030 에 이 요구를 적어 두면 재판정이 한 번으로 끝난다.
- **031 신규 맞다 — §3-2 되읽기로 끝나지 않는다.** `GoodsIssueLineUpsert.properties` 실측 7칸에
  `qualityStatusCode`·`inventoryStatusCode` 가 없고 `GoodsReceiptLineCreate` 에는 **둘 다 있다**(실측).
  입고는 싣고 출고는 안 싣는 «비대칭»이라 계약 쪽 판단이 필요하다.
- ✏ **「알려둘 것」 9건에 한 줄이 빠졌다** — ⓒ 가 404 만 다룬다. `GET /logistics/goods-issues` 와
  `GET …/lines` 는 **`responses` 에 200 하나뿐**(jq 실측)인데 PR① 단위 테스트가 「숫자 축에 글자면 400」을
  단언한다. 400 미선언 자리에서 400 을 내는 것도 ⓒ 와 같은 성격이다(GR 목록도 같아 선례는 있다).
  문의로 올릴 것은 없다 — 「알려둘 것」 ⓒ 를 「404·400 미선언」으로 넓히면 된다.

## 2. 마이그레이션 0 — ✅ 동의 (+✏ §10 에 api 정정 3건 추가)

M-c 이미 적용 ✅(`20260901090000` 실측) · `goods_issue_spare_line` 범위 밖 ✅(계약 스키마에 예비품 라인 0칸 — jq 확인).
§10 이 든 `plan.md` 4곳 · `plan-integration.md` 4곳은 빠짐없다. **api 계획서 쪽 정정 3건이 더 있다**:

| 자리 | 지금 | 고칠 것 |
|---|---|---|
| I-4.md §1-1 마지막 줄 | 「`plan-api.md` **§5.3** S04 표」 | S04 표는 **§1 슬라이스 목록**(111~141행)이다. §5.3 은 「횡단 관심사 적용표」(948행) — 인용 자리가 틀렸다 |
| `plan-api.md` 1090행 | `| 출고 | goods_issue_no | ❌ | **—** | S04 |` | 행이 **이미 있다**. I-4.md PR④ 의 「문의 14 표에 한 행을 더한다」가 아니라 **4열을 `GI-{YYYYMMDD}-{SEQ4}`(계약 example `GI-2026-000402`)로 채우는 것**이다 |
| `plan-api.md` §5.3 ③ (998행) | If-Match 선택 28건 = 「**있으면 걸고** 없으면 안 건다」 | I-4.md §6-3 은 `POST /logistics/goods-issues` 에서 **무시한다**로 갈랐다(새 자원이라 대조할 버전이 없다). I-3 에 이은 둘째 사례 ⇒ 그 행에 「⛔ 단, 새 자원을 만드는 POST 는 대조할 버전이 없어 무시한다」 한 줄 |

## 3. `:post` 전기 모양(§3) — ✅ 동의 · ✏ 2건

- 잔액 7칸 잠금·되읽기 / 1행·0행·2행+ 배치 ✅. `to`=`from` ✅ — 품질·재고 상태를 바꾸는 칸이
  `GoodsIssueCreate` 15칸(jq 실측)에 **0개**다.
- 음수 손검사를 도메인이 지고 `negative_stock_allowed` 를 무시하는 것 ✅ — 계약
  `GoodsIssueLineUpsert.issueQty` 가 「보유 수량 이하」로 예외 없이 닫았다.
- 이중 전기 세 겹 ✅ · `postImmediately` 가 `document-post` 를 안 부르는 것 ✅
  (`plan-api.md` §5.1 A 표 750행 「(전기와 동시) (없음)→POSTED」 와 같은 모양).
- ✏ **§3-7 의 「재전기 400 STATE_LOCKED」 근거를 바꿔 달아야 한다.** 지금은
  `GoodsIssueLineUpsert` 의 400 문장을 끌어썼는데 **그 문장은 `PUT …/lines` 것이지 `:post` 것이 아니다.**
  훨씬 강한 **저장소 선례**가 있다 — `src/core/approval/approval.service.ts:220` 이
  `POST /app/approval-requests/{id}:approve`(계약이 **409 를 선언한다** — `app-공통.json` jq 실측
  `resp=200,400,403,404,409`)에서 `HttpStatus.BAD_REQUEST` 를 골랐고 주석이
  「409 는 이 자리(STATE_LOCKED)가 아니라 If-Match 저장 충돌이 쓴다」로 못박았다.
  ⇒ 「409 를 선언했어도 STATE_LOCKED 는 400」이 I-1 이 이미 세운 정본이다. 판정은 그대로, 근거만 교체.
  (`document-state.service.ts:32-37` 주석의 「409 자체가 없는 자리는 400」만으로는 `:post`·`PUT …/lines`
  둘 다 409 를 «선언»하므로 오히려 409 로 읽힌다 — 근거를 바꾸지 않으면 구현자가 뒤집는다.)
- ✏ **`NEGATIVE_BALANCE` 를 `ERROR_CODE` 에 더하는 자리가 다섯 PR 어디에도 없다.**
  실측: `error-codes.ts` 에 `APPROVAL_REQUIRED`·`NEGATIVE_BALANCE` **둘 다 없다**(주석 :34 에 이름만 나온다).
  PR② 파일표는 `APPROVAL_REQUIRED` 만 더하고(+5), PR③ 파일표는 `issue-posting.ts`·`goods-issue.service.ts`·
  컨트롤러·`transitions.ts` 넷뿐이다 ⇒ **PR③ 이 컴파일되지 않는다.**
  ⇒ PR③ 파일표에 `src/common/errors/error-codes.ts` **+5** 한 줄(또는 PR② 에서 둘을 함께).
- 데드락·경합 ✅(오름차순 한 문장) · 오프라인 큐 ✅(③ 상태 잠금이 영업일 구멍을 덮는다) ·
  되돌림은 I-5 로 미룬 경계 ✅.

## 4. 승인 게이트(§4) — 시그니처 ✅ · 초안 기각 ✅ · ✏ 판정 «등급» 하나

- **`assertApproved(tx, targetTypeCode, targetId, approvalTypeCode)` 는 기존 모양과 정확히 맞다.**
  실측 `approval.service.ts:102-107` `assertNoOpenRequest(tx: Tx, targetTypeCode: string, targetId: bigint,
  approvalTypeCode: string): Promise<void>` — 인자 순서·타입·`type Tx = Prisma.TransactionClient`(:43)까지 같다.
  `PENDING` → 400 `APPROVAL_IN_PROGRESS` 도 그 함수가 이미 던지는 코드 그대로다(:117).
- **S04 초안(결재선 존재 = 승인 필수) 기각 ✅ — 근거가 선다.** `selectRoute` 는
  `OR: [{business_unit_id: businessUnitId}, {business_unit_id: null}]`(:143) 이고 8 상신자가 `null` 을 준다
  ⇒ 「그 유형·사업부로」가 «그 유형으로»만 남아 **전표와 무관한 전역 조건**이 된다. 결재선 한 벌이 서는
  순간 `M-01-08` 생산 투입 출고까지 400 — `derived-permissions.ts:169` 가 그 화면을 등록자로 적은 것과 모순.
  022 권고안 ② 도 불가 ✅(`awk '/^model item /,/^}/' prisma/schema.prisma | grep -c business_unit` → **0**).
- ⛔→✏ **§4-2 의 「§2 **0단계 선례**(판단이 아니라 계약 문장 인용)」 라벨은 과장이다.**
  인용한 `approvalRequestId` 문장(「비어 있으면 승인을 타지 않은 출고다」)이 세우는 것은
  **「서버가 전건을 사전에 막지 않는다」까지**다. 「그 전표에 `GOODS_ISSUE_DISPOSAL` 요청이 있으면 승인
  전표다」는 계약에 없는 문장이고, 오히려 계약 `issueTypeCode` description 은
  「**승인 게이트도 사유를 보고 건다**」로 **다른 축**을 명시했다(jq 실측).
  ⇒ 판정 자체는 유지(다른 길이 없다)하되 등급을 **1단계 가장자리 → 2단계 기준 5(새 개념 0)** 로 다시 달고,
  주석 문구를 「계약이 세운 축(`reasonCode`)의 값이 아직 없어 **상신 흔적으로 대신 가른다** — 값이 오면
  이 자리를 바꾼다(문의 030)」로 적는다. 지금 라벨대로 두면 값이 온 뒤에도 「계약이 그렇게 적었다」로 남는다.
- **뒤집을 수 있는가 — 있다.** 통과→거부는 조이는 방향이고 데이터를 안 늘린다. §2 2단계 비용 판정 ✅.
- **승인 대기 중 `PUT …/lines` 400 `APPROVAL_IN_PROGRESS` ✅ · 023 과 갈리는 이유도 선다** —
  P/O 계약에는 `:post` 가 없고 출고는 `:post` 가 원장을 움직인다(계약 `:post` description 「재고가 움직이는
  순간이다」). 되돌림 비용이 다르므로 같은 구멍에 다른 판정이 정당하다.

## 5. LOT 차단 뒤집기(§5) — ✅ 동의

`mdm.judgment_type_control.blocks_issue` 실재 확인(`schema.prisma` awk 실측 — `blocks_issue`·`blocks_shipment`·
`blocks_picking`·`lot_status_code`). 문자열 집합을 안 박는 것 ✅ · `lot_hold` 무시 ✅ · `blocks_picking` 을
I-8 로 미루는 경계 ✅. api 관점에서 봉투도 맞다 — 400 `STATE_LOCKED`(「재로드해도 풀리지 않는다」)가
`error-codes.ts:5` 주석의 뜻과 같다. 「오늘 아무것도 안 막는다」가 M1 최단 경로를 살린다는 판단 ✅.

## 6. PR 5개·순서·모델 배분(§9) — ✅ 동의 · ✏ 단위 테스트 4칸이 비었다

분할 5 ✅(등록이 전기를 부르므로 전기가 먼저) · ② ≤200 ✅(~45) · ③ 이 전표를 직접 INSERT 하는 순서 ✅
(I-3 ASN 선례) · §7-1 「타입만 export」 ✅ — `server-architecture.md` §1 이 막은 것은 **service** 이고
`import type` 은 SWC 가 지워 DI 그래프에 선이 안 생긴다. 브리프가 든 가드 7종 중 **덮이는 것 5**,
아래 **4칸이 비어 e2e 로도 못 간다**:

| 빠진 가드 | 왜 e2e 로 못 가나 | 넣을 자리 |
|---|---|---|
| `ROUTE_AMBIGUOUS` 400 | `selectRoute` 가 «활성 결재선 2벌»에서 던진다(:139). **계약은 `ROUTE_NOT_FOUND` 만 이름 적었다** ⇒ I-4.md §1-5 표에도 없고 테스트도 없다 | PR⑤ 단위 `상신 — 활성 결재선이 둘이면 400 ROUTE_AMBIGUOUS 다` + §1-5 표 한 행 |
| `PUT …/lines`·`:request-approval` 404 | 둘 다 **404 미선언**인데 우리는 낸다(§8-3 ⓒ). `:post` 만 e2e 에 있다 | PR⑤ 단위 2줄 |
| `:request-approval` 409(낡은 If-Match) | If-Match **필수** 3건 중 이 하나만 409 테스트가 없다 | PR⑤ e2e 1줄 |
| `:post` 200 본문이 `GoodsIssue` **헤더 하나**다 | 상세(`GoodsIssueDetailResponse`)를 내면 계약 위반인데 아무 데도 안 단언한다(jq: `r200 → #/components/schemas/GoodsIssue`) | PR③ e2e `…:post — 200 본문에 lines 가 없다(GoodsIssue 헤더다)` |

모델 배분 ✅(①만 sonnet · 코어·원장·상태기계는 opus).

## 7. `plan-api.md` 와 어긋나 **구현에 영향 주는** 자리 — 3건 (§2 표에 실었다)

§10 대조표의 api 행 실측 결과: 「S04 마이그 = 없음(실측)」 ✅ **맞다**(3관점 중 api 만 맞았다) ·
「S04 설계 미정 초안 교체」 ✅ · 「S04 PR 4→ I-4 만 5」 ✅ · 「§5.1 A 표 (전기와 동시) 행에 출고
`postImmediately` 갈래를 더한다」 ✅ **필요하다** — 750행이 `POST /logistics/goods-receipts` 하나뿐이고,
그 행이 없으면 「`from` 이 없는 전이는 표에 안 담는다」는 §3-9 의 판정이 계획서에서 사라진다.
S04 op 표(124~141) 4축은 계약과 **전건 일치**(jq 실측: 멱등 4 · If-Match 필수 3/선택 1 · ETag 2 · 403 4 · 404 1 · 409 4).

---

### 재수립 결과

1. **I-4.md 에 반영할 수정 — 6건**: ⓐ §3-7 재전기 400 근거를 `approval.service.ts:220`(409 선언 자리에서 400 을 고른 I-1 선례)로 교체 ⓑ PR③ 파일표에 `error-codes.ts` +5(`NEGATIVE_BALANCE` 를 더하는 PR 이 없다) ⓒ §4-2 판정 등급을 「0단계 계약 인용」→「2단계 기준 5」로 재라벨(계약은 `reasonCode` 축을 명시했다) ⓓ 문의 030 갈래 ①을 「값이 없다」→「값이 아직 안 실렸다 · 매핑은 데이터여야 한다」로 ⓔ §1-5·PR⑤ 에 `ROUTE_AMBIGUOUS` 와 404·409·`:post` 200 본문 테스트 4칸 보충 ⓕ §1-1 의 「`plan-api.md` §5.3 S04 표」를 「§1 S04 표」로, §8-3 ⓒ 를 「404·400 미선언」으로.
2. **plan-api.md 에 반영할 것 — 4건**: §5.1 A 표 750행 「(전기와 동시)」에 출고 `postImmediately` 갈래 추가 · S04 「설계 미정」 초안(결재선 존재=승인 필수) 기각 후 교체 · §5.3 ③ If-Match 선택 행에 「새 자원 POST 는 무시」 예외 한 줄 · 1090행 출고 채번 4열을 `GI-{YYYYMMDD}-{SEQ4}` 로 채움(행 추가가 아니다).
3. **plan.md·plan-integration.md 는 I-4.md §10 목록 그대로** — 마이그 M-c 이미 적용, PR 3→5, 코어 열 `assertApproved`, LOT 차단 절 교체. api 관점에서 더할 것 없음.
4. **반대(⛔) 0건** — 세 핵심 판정(마이그 0 · 상신 흔적 게이트 · `judgment_type_control` 읽기)에 모두 동의한다. 라벨·근거·테스트 구멍만 고친다.
5. **문의 최종 2건**(030 · 031 신규) + 기존 **022 정정 1건**(권고안 ② 는 `mdm.item.business_unit_id` 가 없어 불가 → 갈래 ④). 023·026 은 인용만, 승격 없음.
