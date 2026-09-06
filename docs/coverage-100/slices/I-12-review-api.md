# I-12 재검토 — **api 관점**

> 대상 `docs/coverage-100/slices/I-12.md`(637줄) · worktree `docs/coverage-100-i12-plan` · 계약 `contracts/COMMIT.txt` = `a6a87e1` · 실측일 2026-09-07.
> 모든 판정은 파일:라인 실측. 구현·계약·다른 문서 수정 0.

## 1. ⭐⭐ 판별자 `STOCK_TRANSFER` + `sourceDocumentId = putaway_task_id` (§3-6) — ✅ **채택 유지 · 근거 3건 정정·보강**

- ⓐ **✅** 계약 문자 둘이 실제로 갈린다(실측 · `contracts/logistics-01자재창고.json` `InventoryTransaction.sourceDocumentTypeCode`): `enum` 4값 + ⌜값은 «대상 테이블 이름»이다 … 가리킬 표가 늘면 계약을 고친다⌝. README §5(계약 읽기 전용)가 다섯째 값을 막으므로 **enum 안에 남는 쪽이 절차에 맞다.** ⭐ 같은 칸이 ⌜`STOCK_TRANSFER` 는 «재고를 움직이므로 원장을 남긴다»는 **추론**이다 — 다른 셋보다 근거가 얕다⌝ 라고 스스로 적었다 — 계획서가 이 문장을 안 인용했다. **059+1 의 가장 센 물증이므로 §3-6·059+1 에 넣는다.**
- ✏ **정정 1** — 「응답 칸은 `string` 이라 새 값이 조용히 통과한다」는 **사실과 다르다**: 응답 스키마 `InventoryTransaction.sourceDocumentTypeCode` 에 `enum` 4값이 실재하고(python 실측), `test/inventory-transaction.e2e-spec.ts:159-160·238-240` 이 AJV 로 응답을 검증한다 ⇒ `PUTAWAY_TASK` 는 **응답 검증에서 잡힌다**. ✕ 판정은 그대로, 근거 문장만 바꾼다.
- ⓑ **✅ 유혹 1 탈출구는 여기 없다.** I-10 §4-4 가 물러날 수 있었던 이유는 계약이 넷(`businessDate`·`occurredAt`·목적 위치·판별자)을 **다 안 줬기** 때문인데, I-12 는 `PutawayTaskComplete` 가 `businessDate`·`occurredAt`·`actualLocationId` 를 required 로 주고 `PutawayTask.actualLocationId` 가 ⌜재고 잔액의 위치 축이 이 값을 따른다⌝ 라 적었다(계약 실측). `inventory_balance` 직접 UPDATE 는 **정적 가드가 막는다** — `src/core/inventory-posting/balance-write-guard.spec.ts:20-33`(코어 밖 파일이 잔액을 쓰면 spec 실패). ⇒ 원장을 지나는 것 말고 길이 없다.
- ⓒ **✅ 실측 확인** — `src/logistics/document-progress/document-cancel-execute.service.ts:148-150` ⌜`if (rows.length > 1) throw new Error(...)`⌝ · 조회 축은 `:140-144` 의 `(source_document_type_code, source_document_id, reversal_of_transaction_id: null)`. `GOODS_RECEIPT` 안은 입고 1행 + 적치 1행 = 2행 ⇒ **이미 선 입고 취소가 500 으로 죽는다.** `document-type-registry.ts:56-58` `GOODS_RECEIPT.cancelable: true` 라 실제로 도달한다. ✕ 확정.
- ✏ **정정 2 — 「오늘은 안 터진다」의 근거가 부족하다.** `STOCK_TRANSFER.cancelable: false`(`document-type-registry.ts:68-70`)는 **취소 경로만** 막는다. `src/logistics/document-progress/document-progress-query.service.ts:225-228` 은 `cancelable` 을 보지 않고 `(type, id)` 로 원장을 찾아 `POSTED` 단계를 만든다 — `STOCK_TRANSFER` 는 조회 축 9종 안이다(`document-type-registry.ts:8-11`). ⇒ **I-13 이 `stock_transfer` 행을 만드는 순간 `GET /logistics/document-progress/STOCK_TRANSFER/{id}` 가 남의 적치 원장을 「전기됨」으로 읽는다.** 059+1 본문과 인계 ① 에 이 두 번째 충돌 지점을 더한다.
- ✏ **보강 — 오늘 이미 새는 자리가 하나 있다.** `GET /inventory/transactions?sourceDocumentTypeCode=STOCK_TRANSFER`(계약 질의 파라미터 enum 4값 · `src/inventory/transaction/inventory-transaction.service.ts:104`)가 **적치 행을 낸다**. 응답은 계약을 지나지만 `sourceDocumentId` 가 존재하지 않는 `stock_transfer` 를 가리킨다 — I-13 을 기다리지 않고 **첫 적치부터** 참이다. 059+1 에 싣는다.
- ⓓ **✅ 되돌릴 수 없다는 판단이 맞다** — baseline `migration.sql:2960-2975`(`block_ledger_header_mutation`)가 `status_code` **외 UPDATE 를 전부 막고** DELETE 도 막는다(`:2988-2993` BEFORE UPDATE OR DELETE). 나중에 `PUTAWAY_TASK` 로 바꾸는 UPDATE 도, 지우고 다시 쌓는 길도 없다. ⇒ **그래도 채택이 옳다**: 대안 셋 중 둘(다섯째 값 · `GOODS_RECEIPT`)은 오늘 깨지고, 넷째(헤더 전표 신설)는 계약 밖 개념 넷을 만든다. 2단계 기준 2 로 재면 「틀린 판별자로 쌓은 행」보다 「입고 취소가 죽는 것」이 비싸다. 다만 되돌릴 수 없다는 사실 자체를 **059+1 의 첫 문장**으로 올려야 한다(지금은 「남는 위험」에 묻혀 있다).
- ⓔ **✅** `transactionTypeCode` = source 와 같은 값 — 선례 `src/logistics/goods-receipt/receipt-posting.ts:115` 그대로. `transactionNo = putaway_task_no` — `NumberingService` 의 `DEFAULT_PREFIX.PUTAWAY_TASK = 'PT'`(`src/core/numbering/numbering.service.ts:12`) 실측 · `uq_inventory_transaction_no (transaction_no, business_date)`(baseline `:1157`)와 `GR-` 이 갈린다 ⇒ **채번 신설 0 확정.**
- ⓕ 059+1 질문은 정확하다. 위 정정 2·보강·ⓓ 세 문장만 더한다.

## 2. `warehouseId` 파생 원천 (§2-2 ⓐ) — ✅ **동의 · 계약 원문 일치**

`PutawayTask.x-internal-note` 원문 실측: ⌜`warehouseId` 도 같은 이유로 실어 내린다 … **원천은 `goods_receipt.warehouse_id` 다**(`W-01-10` §5-2 가 건별로 정한다)⌝ · 본문 description ⌜`fromLocationId`(입하장·하역장)는 다른 창고일 수 있어 대신 쓸 수 없다⌝. ⇒ `plan-api.md:98` 의 `from_location → warehouse` 는 **폐기가 맞다**(대조표 #1 ⭕).
⭐ **코드가 한 번 더 증언한다** — `receipt-posting.ts:200-207` 의 권장 규칙 조회가 `warehouse_id: receipt.warehouse_id` 로 건다. 즉 `recommended_location_id` 는 **이미 `goods_receipt.warehouse_id` 의 창고 안**이다. §3-3 셋째 검사(`location.warehouse_id = goods_receipt.warehouse_id`)는 그 사실과 일관되며 **「업무를 없애는 거부」가 아니다**(I-4 §5-3 기준) — 계약이 `GET /mdm/locations` 의 `warehouseId` 를 `required: true` 로 못 박아(`contracts/mdm-기준정보.json` 실측) 화면이 그 창고 밖 위치를 고를 길 자체가 없다. 두 홉 조인 성능은 0행이라 무시 가능.

## 3. 권장 판정 2×2 (§3-4) — ✅ **동의 · ⓔ 만 ⚠**

계약 오퍼레이션 description 실측 ⌜권장 위치가 있는데 다른 위치로 적치하면 400 으로 막는다 … `confirmedNoRule` 을 참으로 보내면 통과⌝ ⇒ ⓐ~ⓓ 는 0단계로 끝난다. 순서 ⓑ→ⓔ ✅.
⚠ ⓔ(권장 있음 + `confirmedNoRule=true` → 400)는 넷 중 **가장 얇다** — 위치가 권장과 «같은데» 여분 플래그 하나로 거부한다. 기준 2(거부→허용이 완화)로 지지되나 오프라인 큐가 낡은 플래그를 실어 보내면 현장이 선다. **채택하되 059 의 답으로 가장 싸게 뒤집힐 자리라고 §3-4 에 적는다.**
`INVALID`(field `actualLocationId`/`confirmedNoRule`) ✅ — `RECOMMENDED_LOCATION_MISMATCH` 는 `src/common/errors/error-codes.ts` 에 **부재**(grep 0건) · 브리프가 새 코드를 금했다(`brief-I-12.md:39`) · `plan-api.md:1059` 는 예약일 뿐.

## 4. 취소된 입고 400 `STATE_LOCKED` (§3-8) — ✅ **동의 · ⭐ 더 센 근거를 실측했다**

계획서의 「잔액은 차원 키다」 논증은 맞지만 **부차적**이다. 정본 근거: 입고 취소의 역처리가 원 라인의 `from`/`to` 를 맞바꾸고(`src/core/inventory-posting/reversal.ts:22-38`) 나가는 쪽에 하한을 건다(`reversal.ts:44-62` `assertReversible`). 적치가 하역장 잔액을 먼저 비우면 **그 뒤의 입고 취소가 400 `NEGATIVE_BALANCE` 로 죽는다.** ⇒ `CANCEL_REQUESTED` 를 함께 막는 것이 **필수**다(그 상태에서 취소가 아직 진행 중이다). 이 문장을 §3-8 첫 줄로 올린다. 지시 상태를 안 옮기는 것 ✅(`PUTAWAY_TASK_STATUS` 3값에 「취소됨」 없음 · DB 실측) · 059+3 ✅.

## 5. from 끝점 = 입고 원장 라인 `to_*` 복제 (§3-5) — ✅ · ✏ **한 곳 정정**

- 코어가 from+to 동시 라인을 **정말 지원한다** — `inventory-posting.service.ts:176-215`(`writeLine` 이 from 을 `-qty`, to 를 `+qty` 로 각각 `move()` 하고 `from_qty_after_transaction`·`to_qty_after_transaction` 을 둘 다 채운다) · `:196-210` `balanceKeys` 가 두 끝점을 함께 잠근다 · `ck_inventory_transaction_direction`(baseline `:1204-1206`)은 OR 이라 통과. **코어 수정 0 ✅.**
- ✏ **정정 3 — §3-1 ⑧ 의 「없으면 400 `STATE_LOCKED`」는 도달 불가능한 갈래다.** `receipt-posting.ts:155-166` 이 `goods_receipt_line.inventory_transaction_line_id` 를 **채운 뒤에야** `createPutawayTask` 를 부르고, 지시를 만드는 다른 경로가 0건이다(grep). ⇒ NULL 인 지시는 존재할 수 없다. 400 이 아니라 §3-5 의 `from_location_id` 어긋남과 **같은 등급의 `throw`(500)** 로 적어야 한다 — 클라이언트가 고칠 수 없는 것에 400 을 주면 화면이 무한 재시도한다.
- 품질·재고 상태 불변 ✅(`uq_inventory_balance_dim` 차원 논증 타당) · `handling_unit_id` 복제 ✅.
- ⚠ **빠진 그물 하나** — `actualLocationId === from_location_id` 를 막는 검사가 없다. 물리 제약도 없어(라인 CHECK 는 OR 하나뿐) 잔액이 그대로인 **무의미한 원장 한 줄**이 남고, 그것은 지울 수 없다(TRG-05). §3-3 에 넷째 줄(같으면 400 `INVALID`)을 더할지 판정해 적는다.

## 6. `FOR UPDATE`·순서·`completed_at`·ETag (§3-2·§3-9) — ✅ 전건 동의

`lockLot` 선례 `src/trace/lot/lot-complete.service.ts:117-124`(원시 `FOR UPDATE`) · `completed_at: new Date(body.occurredAt)`(`:95`) · `version_no: { increment: 1 }`(`:100`) · `ConflictException('user')`(`:74-76`) 전부 실측 일치. `runIdempotent`(`src/common/master/master-write.ts:20-37`)는 트랜잭션을 열지 않고 **서비스가 자기 `$transaction` 을 연다** — `goods-receipt.controller.ts:63` + `goods-receipt.service.ts:112-114` 가 그 형상 그대로다. ETag 미설정 ✅ — 두 POST 의 `responses.200` 에 `headers` 키가 없다(실측). `plan-api.md:108-109` 도 ETag 「—」라 **대조표 #3 은 `plan-uiux.md` 209~210 에만 걸린다**(계획서 표현 정확).
⚠ 순서 하나 — §3-1 은 If-Match(②) 를 `assertTransition`(③) «앞»에 뒀는데 `lot-complete.service.ts:70-76` 은 상태를 먼저 본다. 두 선례가 갈리므로(취소는 버전 먼저) 어느 쪽이든 되나, **고른 쪽의 이유를 §3-1 에 한 줄로 적는다**(재로드로 안 풀리는 사실을 먼저 알린다 = 상태 먼저).

## 7. `:complete-temporary` (§4) — ✅ 동의

`PutawayTaskCompleteTemporary` 에 `confirmedNoRule` **부재** 실측(프로퍼티 5칸: `actualLocationId`·`reasonCode`·`remarks`·`businessDate`·`occurredAt`) ⇒ §4-2 는 0단계로 끝난다. 「적어도 하나」는 계약 description 명문 ⌜사유 코드와 비고 중 적어도 하나는 있어야 한다⌝ ✅ · `REQUIRED`(`PAIR` 아님) ✅ · `assertCodeValues` tx 밖 ✅(`lot-complete.service.ts:53-55`). 한 함수 모드 분기 ✅(사용처 둘).
⚠ 창고 일치 검사를 임시에도 거는 것 — 계약 `warehouseId` description 이 근거로 `M-01-05 §5-3`·**`M-01-07 §5-5` 를 함께** 적었으므로 계약상 정합. 다만 `NO_SPACE` 사유로 다른 창고에 임시 적재하는 형상이 화면에 있으면 이 검사가 막는다 ⇒ **uiux 관점 실측에 맡기고, 「알려둘 것」 후보로 남긴다.**

## 8. `transitions.ts` 키 신설 (§6) — ✅ · ✏ **spec 정정**

유혹 9 미해당 ✅(DB `PUTAWAY_TASK_STATUS` 3값 실재 · `plan-api.md:826` D 표가 「재량 없음」으로 분류). `sourceOperation` 두 개가 계약에 실재 ⇒ `document-state.spec.ts:234-244`(`registry.has(operation)`) 통과.
✏ **정정 4 — 따라오는 것은 「기대값 한 줄」이 아니라 두 곳**: `document-state.spec.ts:268` `toHaveLength(25)` → **27**, 그리고 `:250-264` 의 컬럼 배열에 `logistics.putaway_task.status_code` 상수를 **추가**해야 한다(`expect([...columns].sort()).toEqual([...])` 가 정확 일치다). 서비스 상수 대안은 §2 로 기각 — `transitions.ts` 머리 주석이 「여기 없는 (칸, 액션)은 던진다」로 세운 규약을 우회하는 것이다.

## 9. 권한 (§7-5) — ✅ **동의 · 2줄이 맞다**

실측: `derived-permissions.ts:178` `':complete': ['M-04-04']` **하나뿐** · `:complete-temporary` **부재**(등록 없으면 `permission.guard` 가 500) · `derived-permissions.ts:62` `GET /logistics/putaway-tasks: ['M-01-05','M-01-07']` ⇒ 두 화면이 이미 117 권한 안. 「수동표가 도출표의 «권한»을 되풀이하지 않는다」 검사는 **권한 단위**이지 키 단위가 아니다(`operation-permissions.spec.ts:27-36` 주석 명시) ⇒ `:complete` 에 `M-01-05` 를 더하는 것은 통과. 합집합 병합 `operation-permissions.ts:18-24` ✅ · `covered.length` 는 `toBeGreaterThanOrEqual(152)`(`:62`)라 수정 불필요 ✅. `plan-api.md:964` 가 하나만 적은 것과의 차이는 **늘리는 쪽이 옳다**(대조표 #10 ⭕).

## 10. ⭐ e2e `TRUNCATE` (§8-2) — ✅ **동의 · 금지 규칙을 지킬 길은 없다(실측)** · ✏ 숫자 정정

- 금지 규칙의 원문이 **조건부**다 — `I-9.md:451` ⌜**이 스위트는 원장 행을 한 건도 만들지 않으므로** TRUNCATE 가 필요 없다⌝ · `I-10.md:731` 동일. 즉 원장 스위트에는 애초에 안 걸린다.
- ✏ **정정 5 — 선례는 5벌이 아니라 8벌**(`grep -n TRUNCATE test/*.e2e-spec.ts` 실측): `logistics-goods-receipt:576` · `logistics-goods-issue:1184` · `logistics-picking:672` · `logistics-document-progress:1028` · `inventory-transaction:418` · `inventory-balance:418` · `inventory-posting:124` · `trace-lot:528`.
- **다른 길이 없음을 실측으로 확정** — ⓐ 원장 header·line 은 DELETE 가 트리거로 막힌다(baseline `:2960-2993`) ⓑ `inventory_transaction_line` 이 `mdm.item`·`uom`·`warehouse`·`location` 을 **FK 로 잡는다**(baseline `:1175-1188`) ⇒ 원장 행을 남기면 마스터 정리가 FK 로 막힌다 ⇒ 접두어 DELETE 만으로 끝낼 수 없다. **TRUNCATE 가 유일한 길이다.**
- ✏ **정정 6 — 동시 실행 위험은 저장소 게이트에서 성립하지 않는다**: `test/jest-e2e.json` `"maxWorkers": 1` + `package.json:22` `--runInBand` + `alphabetical-sequencer` ⇒ 스위트가 겹쳐 돌지 않는다. §8-2 의 ⚠ 와 인계 ⑥ 은 **「수동 병렬 실행 시에만」**으로 낮춰 적는다.

## 11. 조회 2 (§5) — ✅ · ✏ **코드 조각이 자기 설명과 모순**

`temporaryOnly` 뜻 ✅(계약 ⌜임시 위치에 적재된 건만⌝ → `status_code='COMPLETED_TEMPORARY'`) · `warehouseId` 필터를 응답과 같은 칸으로 ✅ · 정렬 `priority_no asc` + PK ✅ · 상세 404·ETag 계약 선언 실재 ✅(python 실측) · 목록 403 미선언이라 손대지 않음 ✅.
✏ **정정 7 — §5-1 의 `where` 코드 조각이 바로 아래 ⭐ 설명과 어긋난다.** 조각은 `...filter('status_code', statusCode)` 뒤에 `...(temporaryOnly ? { status_code: 'COMPLETED_TEMPORARY' } : {})` 를 전개해 **뒤가 앞을 덮는다** — 설명이 금지한 바로 그 모양이다. 조각을 `AND: [...]` 형태로 고쳐 싣는다(구현자가 조각을 그대로 베낀다).

## 12. 문의 (§9-2) — ✏ **4 → 5 로 가른다**

- 059+1 ✅ 새 문의. 위 §1 의 세 문장(계약 자신의 ⌜추론이다⌝ · `document-progress-query` 두 번째 충돌 · `GET /inventory/transactions` 오늘의 누출)을 본문에 더한다.
- 059+2 ✅ 새 문의. `M-01-10` §8 #1 과 겹치나 그 화면 노트는 「헤더가 없다」이고 이쪽은 「**오퍼레이션이 0건 + 응답 3칸 부재**」라 물음이 다르다 — ⓐ 에 그 화면 노트를 인용으로 붙이는 형태가 맞다(계획서가 이미 그렇게 적었다).
- 059+3 ✅ 새 문의. I-5 는 이 자리를 문의로 열지 않고 §6-4 로 넘겼으므로(`I-5.md:100` 인계 요지 실측) **새로 여는 것이 맞다.**
- ✏ **059+4 를 둘로 가른다** — ⓐⓑ(완료자 칸 부재 · 임시 적치 알림 자리 없음)와 ⓒⓓ(`confirmedNoRule` 오용의 답 · 400 코드 이름)는 **답하는 사람도 답의 모양도 다르다**(전자는 물리 칸/화면, 후자는 계약 문장 하나). 한 문의로 묶으면 반쪽 답이 온다. ⇒ **059+4(완료자 칸) · 059+5(`confirmedNoRule` + 400 코드 이름)** ⇒ **문의 5건.**
- 「알려둘 것」 후보(§9-1 중 문의 ✕): #3 `completed_at = occurredAt` · #6 혼적·수용량·보관조건 미검사 · #7 `warehouseManagementLevelCode` 로 서버가 분기하지 않음 · #8 `TEMP` 미검사 · #13 목적 창고 밖 400 · #15 두 POST 의 404 미선언인데 404 를 낸다. 여기에 **본 검토가 더한 둘** — 「적치 원장이 `STOCK_TRANSFER` 필터에 섞여 나온다」 · 「임시 적재도 목적 창고 밖은 400 이다」.

## 13. e2e·PR·모델 (§8·§10) — ✏ **PR 2 → 3 권고**

- e2e 24 · 단위 9 는 **과하지 않다**(오퍼레이션 4 · 원장·잔액·상태·권장 2×2·멱등·If-Match). README §6 에 개수 상한 없음. 회귀 3스위트(입고·수불·잔액) 목록 ✅ — `receipt-posting.ts`·`inventory-posting.service.ts` 무변경이라 타당.
- ⛔ **PR ② 의 「≤200」은 현실적이지 않다.** 비교 실측: `receipt-posting.ts` 216줄 · `issue-posting.ts` 417줄 · `lot-complete.service.ts` 168줄. §3 의 11단계 + §4 분기 셋 + 끝점 복제 + 컨트롤러 2핸들러면 비테스트 **300줄 안팎**이다.
- ⇒ **권고: 3분할.** ② `transitions.ts`(+14) + `document-state.spec.ts`(2곳) **단독 코어 PR**(CLAUDE.md 「코어 전용 PR ≤200」을 문자 그대로 만족 · sonnet 가능) · ③ `:complete` + `:complete-temporary` + `putaway-posting.ts` + 컨트롤러 + e2e 16 + 단위 8, **opus · 비테스트 ≤350**(README §6 브리프 예산). 계획서의 대안 ⓐ(전이표를 ①로) 와 사실상 같으나 **전이표를 ① 의 sonnet 에 섞지 않는 쪽**이 낫다 — 코어 파일이 조회 PR 에 묻힌다. ① sonnet ✅ · 코어 opus ✅(MEMORY 배분과 일치).

## 14. 자기 관점 계획서와의 어긋남 — 구현에 영향 주는 것만

- `plan-api.md:98` `from_location → warehouse` ⇒ **폐기 확정**(§2). 대조표 #1 ⭕ 정확.
- `plan-api.md:102` 「설계 미정 자리 없음」 ⇒ **문의 5건**. 대조표 #2 ⭕ (건수만 4→5 로 고친다).
- `plan-api.md:1059` `RECOMMENDED_LOCATION_MISMATCH` ⇒ `INVALID`. 대조표 #4 ⭕.
- `plan-api.md:964` 권한 등록 1건 ⇒ **2건**. 대조표 #10 ⭕.
- `plan-api.md:108-109` 는 두 POST 의 ETag 를 이미 「—」로 적었다 ⇒ **대조표 #3 은 api 계획서와의 차이가 아니다**(uiux 쪽). 계획서 표기 정확.
- `plan-api.md:1086` `PT-YYYYMMDD-NNNN` 구현됨 ⇒ 채번 신설 0 ✅.

---

**재수립 결과 — I-12.md 에 반영할 수정 7건**: ① §3-6 (i) 근거를 「응답 enum + AJV 가 잡는다」로 정정 ② §3-6·§11 ① 에 `document-progress-query.service.ts:225-228` 두 번째 충돌과 `GET /inventory/transactions` 오늘의 누출을 더하고 계약 자신의 ⌜추론이다⌝ 를 인용 ③ §3-1 ⑧ 을 400 → `throw`(도달 불가 · `receipt-posting.ts:155-166`) ④ §3-8 첫 근거를 `assertReversible`(입고 취소가 죽는다)로 교체 ⑤ §5-1 `where` 조각을 `AND: [...]` 로 ⑥ §6 「spec 한 줄」 → **두 곳**(`:268` 27 · `:250-264` 컬럼 추가) ⑦ §8-2 선례 5→**8**, 동시 실행 ⚠ 를 「수동 병렬 시에만」으로(`maxWorkers:1`+`--runInBand`). 추가로 §3-3 에 `actual == from` 그물 판정 한 줄, §3-4 ⓔ 에 「가장 싸게 뒤집힐 자리」 한 줄.
**plan.md 에 반영할 것**: `plan-api.md` S03 96행(파생 원천) · 101행(PR 2→3) · 102행(설계 미정 없음→문의 5) · 964행(권한 1→2). `plan.md` §1 37행은 마이그 「—」·opus 그대로.
**문의 최종 5건**: 059+1(판별자 · 되돌릴 수 없음 + 충돌 2경로) · 059+2(임시 dead end + 응답 3칸) · 059+3(취소된 입고의 지시를 못 닫는다) · 059+4(완료자 칸 0) · **059+5(신설 — `confirmedNoRule` 오용의 답 + 400 코드 이름)**.
**PR 분할·모델 최종안**: **3** — ① 조회 2 + 뷰 + 권한 2줄, sonnet ≤180 / ② `transitions.ts` + spec 2곳, 코어 단독 ≤30, sonnet / ③ `:complete`+`:complete-temporary`+`putaway-posting.ts`+컨트롤러+e2e 16+단위 8, **opus ≤350**.
**한 줄 판정**: 판별자 `STOCK_TRANSFER` + `putaway_task_id` — **✅ 채택**(대안 셋이 오늘 깨지거나 계약 밖 개념을 만든다 · 단 되돌릴 수 없으므로 059+1 의 첫 문장으로 올린다) · e2e `TRUNCATE` — **✅ 쓴다**(트리거 + 원장→마스터 FK 로 다른 길이 물리적으로 없고, 금지 규칙은 원장 0행 스위트의 것이며, `maxWorkers:1` 이 동시 실행 위험을 이미 없앤다).
