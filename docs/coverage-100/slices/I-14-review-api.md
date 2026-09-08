# I-14 재수립 — **api 관점** 리뷰

> 대상 `slices/I-14.md`(854줄) · 실측 부록은 재측정하지 않았다(뒤집는 판정 2건만 재측정 — A-1·A-6).
> 근거는 전부 `파일:줄`. 판정 5 + 브리프 추가 4.

---

## 1. 「반드시 볼 자리 5」 판정

### ① 두 상태 칸을 등록·치환 때 잔액에서 읽어 저장 — **✏ 수정**(결론 유지 · 근거와 문의 등급 교체)

결론(저장 판정)은 유지한다. `PostingEndpoint.qualityStatusCode`·`inventoryStatusCode` 가 **옵셔널이 아니다**
(`src/core/inventory-posting/posting.types.ts:2-7`) — 전기 때 값이 반드시 있어야 하므로 「NOT NULL 완화」는 원장 쪽 구멍을 그대로 남긴다.
「전기 시점 재조회」도 뒤집지 못한다 — 계약 `PUT …/lines` 200 ETag 원문이 ⌜라인을 고치면 이 헤더의 값이 오르므로
다음 상태 전이는 이 값을 쓴다⌝ 라 **치환이 승인·전기의 입력을 확정하는 자리**로 계약이 이미 못 박았다.

✏ **고칠 것 두 가지.**
1. §2-4 의 ⛔ 논거가 **틀렸다**. 「기준 3(스키마를 안 늘리는 쪽)이 기준 4보다 앞」은 성립하지 않는다 —
   **완화는 칸을 늘리지 않아 기준 3 이 아예 안 걸린다.** 실제 근거는 ⓐ 기준 4(값을 조용히 도출하지 않는다)
   ⓑ 위 `posting.types.ts:2-7` 의 required 다. 그리고 ⭐ **계획안이 안 본 반례가 이 루틴 안에 있다** —
   `docs/design-inquiries/053-…md`(§③) 는 **똑같은 형상**(계약 라인 스키마에 칸 0 · 물리 NOT NULL · 코드 그룹 0행)에서
   **NOT NULL 을 «풀었다»**(I-10 M-2 `20260907700000` · `material_return_line.return_quality_status_code`).
   §2-4 는 I-3·I-5 두 완화만 갈라 두었는데, **가장 가까운 선례를 빠뜨렸다.** 053 과 갈리는 점(그 칸은 소비처가 0,
   이 칸은 원장 required)을 §2-4 에 한 줄로 적어야 판정이 선다.
2. ⭐ **증(+) 0행 → 400 `INVALID` 는 「가장자리」가 아니다.** 계약 `InventoryAdjustmentLine.adjustmentQty` 는
   ⌜증감 수량. 음수가 올 수 있다⌝ 뿐이고 위치 제한이 **0**이며, 사유 5값 중 `TRANSPORT_DAMAGE`·`SYSTEM_ERROR_CORRECTION`·`OTHER`
   는 빈 위치로의 증(+)을 자연히 부른다. 이 400 은 계약이 연 기능의 한 갈래를 **닫는다**. ⇒ 문의 130 을
   「권고안 + 통보」가 아니라 **답이 필요한 건**으로 올리고, 대안 두 개(ⓐ 계약에 두 칸 추가 ⓑ NOT NULL 완화 — 053 선례)를
   문의 본문에 명시한다. 흔적(§2 3단계)은 e2e #13 이름에 이미 있다.

### ② 마이그 1건(`inventory_count_line_id`) — **✅ 동의** (+ 통합자 작업 1건 누락)

계약 두 스키마가 그 칸을 정의한 것을 재확인했다 — `InventoryAdjustmentLine.inventoryCountLineId`(`['integer','null']`,
⌜실사 차이에서 불러온 경우의 원천 라인⌝)·`InventoryAdjustmentLineUpsert.inventoryCountLineId`. 「계약 칸을 버린다」는
README §2 2단계 기준 4 에 정면으로 걸리고, 기준 3 도 「늘려야 하면 nullable」이라 nullable 추가를 막지 않는다.
⛔ **다만 §12-1 #1 의 고칠 자리 목록이 한 칸 모자라다** — `plan-api.md` **§5.2 표 A**(886~910행 · 신설 칸 22행)에
조정 행이 **없다**. `plan-api.md:190` 한 줄만 고치면 표 A 와 어긋난 채 남는다. ⇒ **표 A 에 23번 행 신설**을 §12-1 #1 에 더한다.

### ③ 부호 가름 + `negative_stock_allowed` 를 본다 — **✅ 동의**

계약 실측으로 확인 — `adjustmentQty` description 에 「보유 이하」류 문장이 **0건**이다(I-4 는 `GoodsIssueLineUpsert.issueQty`
가 닫았고 `issue-posting.ts:155-156` 주석이 **그 문장을 근거로** 무시했다). 화면도 확인 —
`W-01-12-재고조정.md:226` ⌜음수 재고가 되는 조정 — `item.negative_stock_allowed` 참이면 허용⌝ · `:225` ⌜차이 0인 라인 자동 제외⌝.
⇒ 두 오퍼레이션이 갈리는 것은 **계약이 한쪽만 닫았기 때문**이라 옳다. 「알려둘 것」 ⓕ 로 남기는 처리에도 동의한다.

### ④ 원장 헤더 `plant_id` 를 라인 위치에서 역산 · 두 공장 400 — **✏ 수정**(판정 동의 · **오류 봉투 표기 정정**)

판정은 동의한다 — 조정 헤더에 공장·창고 축이 0 이고 계약 `InventoryAdjustment` 8칸에도 없다(실측 재확인). 기준 2.
✏ **`ErrorItem.field` 경로가 오퍼레이션마다 다르다.** 계약 본문 칸 이름이 등록은 `lines`, 치환은 **`items`** 다
(`PUT …/lines` requestBody = `{required:['items']}` 실측). 계획안 §3-3·§3-5·§5-4·§1-6 은 전부 `lines[i].locationId` 로
고정 표기했다 — 치환에서는 화면이 없는 경로를 받는다. ⇒ **`resolveLineDimensions()` 가 필드 접두어를 인자로 받는다**
(§6-5 가 이미 `'lines' | 'items'` 를 인자로 받는 모양을 적었으니 §1-6·§3-3·§3-5 표기만 맞추면 된다).

### ⑤ PR 4 분할 + `transitions.ts` A 소유 — **✅ 동의**(조회 PR ① 병렬 스폰 포함)

api 관점에서 PR ① 이 담는 것은 조회 3 · 뷰 · `manual-permissions.ts` 2줄이고, 위 판정 ①~④ 중 ① 에 닿는 것은 없다.
권한 2줄은 실측으로 재확인했다 — `derived-permissions.ts:162-163` 에 등록·상신 둘이 있고 `manual-permissions.ts` 에 조정 0건,
`operation-permissions.ts` 가 **합집합**이라 겹침 금지 검사(`operation-permissions.spec.ts` 「수동표가 도출표의 권한을 되풀이하지 않는다」)에도
안 걸린다(키 자체가 새것이다). ⭐ **그 spec 의 숫자는 손댈 필요가 없다** — `toHaveLength(250)` 은 계약 쪽 수치이고
등록 수는 `toBeGreaterThanOrEqual(152)` 라 하한이다. 계획안이 spec 변경을 안 적은 것이 맞다.

---

## 2. 브리프 추가 항목

### ⑥ 문의 6건(130~135) — **✏ 수정 · 최종 6건 유지**

`docs/design-inquiries/` 016~062 전건 파일명 + `README.md` 에 **「조정」이 걸린 건이 0건**이다 ⇒ 여섯 다 새 물음이 맞다.
`계약-되돌림-mdm.md`·README §0 대기 15 와도 안 겹친다(15 는 계획안이 「누적」으로 바르게 처리했다).
- **130** — ① 참조. 등급을 **답 필요**로 올리고 053 ③ 을 「같은 형상, 반대 판정」으로 인용한다.
- **131** — ✏ **셈 정정.** 「`x-internal-note` 셋이 낡았다」는 **넷**이다 — `POST /inventory/adjustments` · `PUT …/lines` ·
  `InventoryAdjustmentLine` · `InventoryAdjustmentLineUpsert`(스키마 둘이 각자 갖는다). 또 ⌜라인 사유를 담을 자리도
  함께 확정돼야 한다⌝ 문장은 **`InventoryAdjustmentLine` 에만** 있고 `Upsert` 에는 없다 — §2-3 표가 둘을 묶어 인용했다.
  `plan-api.md:915`(표 B)도 「2곳」이라 적었으니 함께 고친다.
- **132** — ⭐ **근거 직접 재확인 완료(재측정 예외 · 실측 부록 #9 를 뒤집지 않고 확증).**
  `/logistics/document-progress` `documentTypeCode` enum = `PURCHASE_ORDER`·`INBOUND_RECEIPT`·`GOODS_RECEIPT`·
  `MATERIAL_ISSUE_REQUEST`·`PICKING_ORDER`·`STOCK_TRANSFER`·`SUBCONTRACT_ISSUE`·`SUBCONTRACT_RECEIPT`·`GOODS_ISSUE`
  **9값 · 조정 없음**. 조정 경로 7건에 `:cancel`·`:reverse` **0건**(paths 전수). ⇒ `I-5.md:790-796` 의
  「I-14 = `reverse()` 둘째 사용처」는 **뒤집힌다**. §12-1 #12·§13 ⓒ 그대로 유지한다. ✅
- **133** — ✅ 동의(④ 의 field 표기만 정정).
- **134** — ✏ **인용 보강.** 계약 `sendToErp` description 이 ⌜⭐ 전역 송신 설정과 **논리곱**이다 … **켜고 끄기의 정본은
  전역 설정이다**⌝ 라 적었다(계획안 미인용). ⇒ 서버에 그 「전역 설정」을 담을 자리가 0 이라는 것도 함께 묻는다.
  또 `plan-api.md:930`(표 C)은 `erpMessageQueued` 를 ⌜아웃박스 행의 **존재 여부**⌝ 로 이미 정의했다 —
  §1-4 의 「담을 칸 0 이라 false 고정」은 「**아웃박스 행이 0건이라 오늘은 늘 false**」로 표현을 맞춘다(판정 동일).
- **135** — ✅ 동의.

### ⑦ 에러 코드 새 코드 0건 — **✅ 동의**(실측)

`src/common/errors/error-codes.ts` 실측 — `REQUIRED:9`·`INVALID:13`·`STATE_LOCKED:17`·`LINE_REQUIRED:24`·
`ROUTE_NOT_FOUND:30`·`ROUTE_AMBIGUOUS:31`·`APPROVAL_IN_PROGRESS:36`·`APPROVAL_REQUIRED:41`·`NEGATIVE_BALANCE:55`
**아홉 전부 기존**. 409 봉투도 확인 — `ConflictResponse{conflictCause(user·erpSync·workerLease), message}` 에 `code` 칸이
**없다**(§1-6 마지막 두 줄이 맞다). `ErrorItem.code` 는 enum 이 아니라 「등」으로 열린 설명이라 위 아홉이 다 통과한다.

### ⑧ 테스트 35+9 에서 **빠진 갈래 4** — ✏

1. ⭐ **`PUT …/lines` 를 `runVersioned` 로 못 쓴다는 §6-4 의 ⛔ 가 사실과 다르다.**
   `runVersioned<T,K>` 는 응답 필드 이름을 제네릭으로 받아 **컬렉션에 이미 세 곳이 쓰고 있다** —
   `mdm/organization/worker.controller.ts:76` · `mdm/terminal/terminal.controller.ts:126` · `mdm/spare-part/spare-part.controller.ts:122`
   (전부 `'items'`). `runVersioned` 는 `setEtag(response, result.versionNo)` 를 **서비스가 되읽은 실제 값**으로 걸어
   §6-4 의 「`setEtag(response, version + 1)`」(컨트롤러가 «추측»한 값)보다 안전하다. ⇒ **`runVersioned(…, 'items', …)` 로 바꾼다.**
   같은 결로 §5-1 6번의 `setEtag(response, 1)`(상수)도 형제 모양(`goods-issue.controller.ts:86` `result.versionNo`)으로 바꾼다.
2. 라인 `reasonCode` 에 **코드값 밖 문자**를 보내면 400 `INVALID` — §5-1 1번이 라인 전건 `assertCodeValues` 를 걸었는데
   e2e 35 에 그 갈래가 없다(헤더만 암묵). 계약이 라인에도 `x-code-key: CD-INVENTORY-ADJUSTMENT-REASON` 를 붙였다(실측).
3. `sendToErp: false` 를 실어도 201 이고 `erpMessageQueued` 가 false — 문의 134 판정을 못 박는 유일한 자리인데 e2e 0건.
4. 치환 응답 ETag 로 **`:request-approval`** 도 된다 — 계약 문장이 두 전이를 **둘 다** 지목했는데 e2e #18 은 `:post` 만 본다.

### ⑨ 자기 관점 계획서와의 어긋남 — 구현에 영향 주는 것만

- `plan-api.md` **S07 「마이그레이션 없음(실측)」(190행) + §5.2 표 A(886~910)** ⇒ ② 참조. 두 자리 다 고친다.
- `plan-api.md` **표 B(915행) 「2곳」** ⇒ **4곳**(131 참조).
- `plan-uiux.md:280-283` 의 ETag 표기 ⇒ 계약 실측이 이긴다(§12-1 #5 그대로 · 재확인 완료:
  응답 ETag 는 `POST` 201 · 상세 GET 200 · `PUT …/lines` 200 **셋**, `:post`·`:request-approval` 은 **요청 If-Match**).
- `plan-api.md:967` 권한 2건 ⇒ 실측 일치. 손댈 것 없음.

## 3. 결론

⛔ **반대 0건.** 멈춤 조건(README §3 셋) **미해당** — 물리 변경은 nullable 추가 1칸(삭제 0), 게이트 실패 없음,
계약끼리 모순 아님(계약 침묵과 물리 NOT NULL 의 어긋남이라 문의 130 으로 간다).
