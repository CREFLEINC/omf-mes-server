# I-12 재검토 — **integration** 관점 (원장 코어 · 다형 취소 · I-13/I-16 인계 · e2e 위생 · PR 분할)

실측 기준: worktree `docs/coverage-100-i12-plan` · main `7669cc7` · 계약 `contracts/COMMIT.txt` = `a6a87e1` · 2026-09-07.
판정 기호 ✅ 동의 / ✏ 수정 / ⛔ 반대.

## ⭐ 먼저 — 실측으로 뒤집힌 것 둘 (구현 전 반드시 반영)

### B-1 ⛔ §3-7 「잔액 부족 400 `NEGATIVE_BALANCE` 는 I-4 그물 그대로」는 **거짓이다 — 오늘 500 이 샌다**
- `InventoryPostingService.post()` 전문(`inventory-posting.service.ts:48-95`)에 **하한 판정이 0줄**이다. 하는 일은 멱등 조회 → `lockBalancesInOrder`(「⛔ 잠글 뿐 판정하지 않는다」 · `balance-lock.ts:36`) → 헤더 INSERT → `writeLine`.
- 400 그물은 **호출 도메인이 각자 세운다**: 출고 `issue-posting.ts:110-168`(키별 «합계» 수요 · `available_qty` + 방금 소진량 · 두 갈래 400), 피킹 `picking-pick.service.ts:130`, 역처리 `reversal.ts:72`(`assertReversible` — `reverse()` 전용).
- `move()` 의 UPDATE 가 `trg_inventory_balance_qty`→`check_balance_qty()`(baseline `migration.sql:2831-2861`)를 때리면 `ERRCODE=check_violation` 이고, `src/` 전체에 그 코드를 400 으로 바꾸는 자리가 **0건**이다(grep). 반대 증거가 코드에 명문으로 있다 — `production-result.service.spec.ts:290` 「`check_violation` 은 **공용 그물에 안 걸려 500 이 샌다** — 손으로 앞당겨 막는다」.
- ⇒ **§3-1 에 단계를 하나 더한다**: ⑧ 뒤·⑨ 앞에 `from` 잔액 행 되읽기 + `available_qty ≥ task_qty` 판정 → 400 `NEGATIVE_BALANCE`(`field: actualLocationId` 아님 — 본문 칸이 아니므로 `scope:'screen'`, 출고 `issue-posting.ts:129` 문형). ⛔ `on_hand_qty` 만 보면 안 된다 — 트리거 첫 갈래가 `on_hand < reserved+picked+blocked` 도 막아, 하역장 재고에 피킹이 걸려 있으면 그대로 500 이다(`migration.sql:2838-2842`).
- 비용: 라인 1건뿐이라 출고의 합계 로직이 필요 없다 — **비테스트 20~30줄**. 그러나 PR ② 예산 ≤200 을 이만큼 먹는다(§13).

### B-2 ⛔ 적치 완료가 **이미 선 입고 취소를 조용히 막는다** — 계획안에 이 줄이 없다
- `cancel-eligibility.service.ts:170-186` `lotAxis` 가 원장을 후속으로 센다: `NOT: { source_document_type_code: typeCode, source_document_id: documentId }`(규칙 ① 자기 전기 제외) + `inventory_transaction_line.some.lot_id ∈ 이 입고가 만든 LOT`. `LOT_SOURCE_TYPES = ['INBOUND_RECEIPT','GOODS_RECEIPT']`(:51)라 입고에 **걸린다**.
- 적치 원장은 `(STOCK_TRANSFER, putaway_task_id)` 라 규칙 ① 의 NOT 을 **안 지나가고**, 라인이 그 LOT 을 싣는다 ⇒ `successorCount = 1` ⇒ `:cancel` 과 `:request-cancel` 이 `SUCCESSOR_EXISTS` 로 막힌다(`document-cancel-execute.service.ts:92-96`).
- 업무적으로는 **옳다**(적치된 재고를 입고 취소로 되돌리면 하역장 잔액이 음수다). 그러나 ⓐ 이미 병합된 I-5 의 관측 가능한 동작이 바뀌고 ⓑ §3-8 의 전제가 좁아진다 — 취소된 입고의 적치 지시는 **`PENDING` 인 것만** 존재할 수 있다(완료된 지시가 있으면 애초에 취소가 안 된다) ⓒ 059+3 의 「목록이 영원히 죽은 행을 이고 간다」는 그대로 살아 있다.
- ⇒ ✏ §3-8 에 이 사실을 한 줄 · §11 ③(I-5 인계)에 「적치 완료가 입고 취소를 `SUCCESSOR_EXISTS` 로 닫는다 — 의도한 결과이며 `document-progress` 상세의 후속 행에 `INVENTORY_TRANSACTION` 으로 나타난다」 · **회귀 스위트에 `test/logistics-document-progress.e2e-spec.ts` 를 넣는다**(§8-3 의 3스위트 → 4) · e2e 1건 추가 「적치를 완료하면 그 입고의 `:cancel` 이 400 `SUCCESSOR_EXISTS` 다」. 059+1 본문에 근거로 실을 값이기도 하다.

## 판정 14건

**1. 판별자 `STOCK_TRANSFER` + `putaway_task_id`** — ✅ **채택 지지**. 넷 다 실측했다.
- ⓐ 계약 문자 둘이 갈린다는 서술은 정확하다. enum 은 **두 자리 모두** 닫혀 있다 — 응답 `InventoryTransaction.properties.sourceDocumentTypeCode.enum` 4값 + 질의 `GET /inventory/transactions` parameters[7].schema.enum 4값(python 실측). `PUTAWAY_TASK` 다섯째 값은 계약 위반이 맞다. 서버 유니온도 4값(`inventory-transaction.service.ts:20`)이고 응답 칸만 `string`(:44)이라 「조용히 새는」 서술도 정확하다.
- ⓑ I-10 유혹 1 과의 정합 ✅ — 적치는 **정말 원장을 지나야 한다**. `inventory_balance` 직접 UPDATE 는 코어 금지가 명문이고(`receipt-posting.ts:107` 「⛔ 재고를 바꾸는 유일한 길이다」 · 정적 가드 `balance-write-guard.spec.ts` · 유혹 2), 위치 축을 옮기는 다른 통로는 `pick()`/`consume()` 뿐인데 둘 다 `reserved`/`picked` 칸만 만진다(`inventory-posting.service.ts:160-168`). 탈출구 0 — I-10 과 정직하게 갈린다.
- ⓒ `GOODS_RECEIPT` 안이 깨진다는 주장 ✅ **실측 확인** — `document-cancel-execute.service.ts:148-151` 「한 문서는 원장 하나다 … `if (rows.length > 1) throw new Error(...)`」. 500 이다. 다만 정확히는 **B-2 와 짝**이다: `GOODS_RECEIPT` 로 쓰면 규칙 ① NOT 이 두 행을 «다» 빼서 `successorCount=0` → 통과 → `reverseLedger` 에서 500. 그러니 「입고 취소가 죽는다」는 참이고 사인은 400 이 아니라 500 이다.
- ⓓ **되돌릴 수 없다는 지적은 옳고, 계획안이 무게를 덜 실었다.** `block_ledger_header_mutation()` 은 `status_code` 외 UPDATE 를 전부 던지고 DELETE 도 던진다(`migration.sql:2960-2989`) ⇒ 쌓인 행의 판별자는 **역트랜잭션으로도 못 고친다**(역행이 원 값을 물려받는다). 즉 2단계 「되돌리기 쉬운 쪽」 기준으로는 오히려 불리한 선택이다. 그럼에도 지지하는 이유는 **대안 셋이 전부 더 나쁘고**(계약 위반 / 선 기능 파손 / 새 개념 넷) **아무것도 안 하는 길이 없기** 때문이다 — ✏ §3-6 에 「이 선택은 되돌릴 수 없다(`block_ledger_*`) — 그래서 059+1 은 **I-13 착수 전에** 답이 와야 한다」를 명시하고 §11 ① 에 그 시한을 못 박는다.
- ⓔ `transactionNo = putaway_task_no` ✅ — `PT-` 접두어가 실재한다(`goods-receipt.service.ts:110` 이 `numbering.next('PUTAWAY_TASK', …)` 를 라인 수만큼 부르고, 입고 e2e 정리가 `putaway_task_no LIKE 'PT-%'` 로 지운다 · `logistics-goods-receipt.e2e-spec.ts:582-584`). 채번 신설 0 ✅. `transactionTypeCode` 동값 ✅(`receipt-posting.ts:115` 선례).
- ⓕ 059+1 질문 ✅ 정확하다. ✏ 두 줄 보강: 「`(STOCK_TRANSFER, id)` 로 쌓인 행은 **트리거가 UPDATE 를 막아 나중에 못 고친다**」 · 「적치 원장이 입고의 `successorCount` 에 잡혀 입고 취소를 닫는다(B-2)」.

**2. `warehouseId` 원천 = `goods_receipt.warehouse_id`** — ✅ 계획안이 맞고 `plan-api.md` 96행이 틀렸다. 계약 원문 실측: `PutawayTask.x-internal-note` 「… **원천은 `goods_receipt.warehouse_id` 다**(`W-01-10` §5-2 가 건별로 정한다)」 + `warehouseId.description` 「`fromLocationId`(입하장·하역장)는 다른 창고일 수 있어 대신 쓸 수 없다」. 0단계로 끝난다. 목록 필터를 같은 칸으로 거는 것 ✅. 두 홉 조인 성능은 0행이라 무시 가능하고 `ix_putaway_receipt_line` 이 있다. `location.warehouse_id = goods_receipt.warehouse_id` 거부는 「업무를 없애는 거부」가 아니다 — 계약이 목적 창고를 required 로 세웠고 위반 형상이 계약·물리 어디에도 없다.

**3. 권장 판정 2×2** — 관점 밖(uiux 소관). integration 으로 볼 것 하나: ⓑ→ⓔ 순서와 400 은 **원장 «앞»**이라 원장에 흔적이 안 남는다 ✅(§3-1 ⑤⑥⑦ 배치가 맞다). 새 error code 0 ✅ — `error-codes.ts` 에 `RECOMMENDED_LOCATION_MISMATCH` 부재 실측.

**4. 취소된 입고 400 `STATE_LOCKED`** — ✅, 단 B-2 로 **범위가 좁아진다**(완료된 지시가 하나라도 있으면 그 입고는 취소 자체가 안 된다 ⇒ 이 400 이 걸리는 형상은 「같은 입고의 다른 라인 지시」와 「전 라인 `PENDING` 인 입고」뿐). 잔액 차원 키 논증 ✅ 타당하다(`uq_inventory_balance_dim` 11칸 · `balance-lock.ts:3`). `CANCEL_REQUESTED` 도 막는 것 ✅ — 승인 대기 중 적치를 허용하면 승인 뒤 역처리가 음수를 만난다. 지시 상태를 안 옮기는 것 ✅(`PUTAWAY_TASK_STATUS` 3값 · F-6).

**5. from 끝점 = 입고 원장 라인 `to_*` 복제** — ✅ 원칙 동의, ✏ 셋 고친다.
- 코어가 from+to 동시 라인을 **정말 지원한다** ✅ 실측: `writeLine`(`inventory-posting.service.ts:180-204`)이 `line.from`·`line.to` 를 각각 `move()` 하고 `from_qty_after_transaction`·`to_qty_after_transaction` 을 둘 다 채운다. `ck_inventory_transaction_direction` 은 OR 이라 통과(`migration.sql:1204-1206`). `balanceKeys`(:207-224)가 두 끝점을 한 문장에 넣어 교착도 닫힌다. **코어 수정 0** ✅.
- ✏ 복제할 칸 목록 정정 — `PostingEndpoint` 는 **4칸뿐**이다(`posting.types.ts:2-8`: warehouseId·locationId·qualityStatusCode·inventoryStatusCode). `ownershipTypeCode`·`ownerPartnerId`·`handlingUnitId` 는 **라인 칸**(:9-21)이다. §3-5 의 묶음 표기가 오해를 부른다.
- ✏ 「`inventory_transaction_line_id` 가 없으면 400 `STATE_LOCKED`」는 **도달 불가**다 — `postReceipt` 가 `goods_receipt_line.inventory_transaction_line_id` 를 채운 «뒤» 같은 루프에서 `createPutawayTask` 를 부른다(`receipt-posting.ts:154-166`). 지시가 존재하면 그 칸은 언제나 non-null 이다. 400 이 아니라 **던진다**(우리 결함 등급)로 내려야 §3-5 의 `from_location_id` 대조와 등급이 맞는다.
- ⚠ 계획안이 안 다룬 형상: **`actualLocationId === from_location_id`**(관리 수준 `WAREHOUSE` 창고에서 하역장이 곧 보관 위치). 이때 from·to 가 같은 잔액 행이라 `move(-qty)` → `move(+qty)` 로 순증 0 이고, `lockBalancesInOrder` 의 `IN (VALUES …)` 가 중복을 접어 교착도 없다 — **동작은 한다**. 그러나 「이동하지 않은 이동 원장」이 남는다. §9-1 에 한 행(#18) 추가 권고: 「같은 위치로의 적치 — 막지 않는다(계약·화면 근거 0) · 원장 한 줄은 그대로 쌓는다」. 단위 spec 1건 값어치.
- 품질·재고 상태 불변 ✅ 논증이 정확하다.

**6. `FOR UPDATE` · 커넥션 2 · `completed_at` · ETag** — ✅ 전부. `runIdempotent` 안에서 서비스가 자기 `$transaction` 을 여는 선례 실측 확인(`goods-receipt.service.ts:113` · 컨트롤러 `runIdempotent` 는 물류 8개 컨트롤러에 이미 있다). ⚠ 단 입고는 **채번을 tx 밖에서** 뽑아 커넥션 둘을 피했다(:104-111 주석 「열린 트랜잭션 안에서 부르면 … `P2024` 로 죽는다」) — 적치는 채번을 안 부르므로 해당 없음이지만, §3-1 의 tx 밖 단계(사번 존재 확인 · 코드 그룹 대조)는 그 규약 덕에 반드시 tx 밖이어야 한다 ✅ 계획안대로다.

**7. `:complete-temporary`** — ✅. 한 함수 모드 분기 ✅(사용처 둘). 창고 일치 검사를 임시에도 거는 것 ✅ — 원장 `to.warehouseId` 를 `location.warehouse_id` 에서 뽑는 이상 이 검사를 빼면 창고 간 이동이 `STOCK_TRANSFER` 판별자로 몰래 생겨 I-13 영역을 침범한다(`plan-uiux.md` 1174 「창고 간은 I-13」).

**8. `transitions.ts` 키 신설** — ✅ 유혹 9 미해당. ✏ 「`document-state.spec.ts` 기대값 한 줄」은 **두 줄**이다: `columns` 배열에 상수 추가(:250-263) **와** `expect(service.registered()).toHaveLength(25)` → **27**(:268). `sourceOperation` 실재 단언(:234-244)은 계약에 두 오퍼레이션이 있으므로 통과 ✅. 서비스 상수 대안은 ⛔ — 코어가 미등록 (칸,액션)을 던지는 것이 유혹 9 의 방어 장치 자체다.

**9. 권한 `:complete` 에 `M-01-05` 추가** — ✅ 실측 확인. `derived-permissions.ts:178` = `'POST /logistics/putaway-tasks/{putawayTaskId}:complete': ['M-04-04']` 하나뿐이고 `:complete-temporary` 는 도출표에 **아예 없다**(grep 0건) — 미등록이면 `permission.guard.ts` 가 500 이므로 등록 2줄이 맞다 ✅. 합집합 병합 ✅(`operation-permissions.ts:20-26`).

**10. e2e TRUNCATE** — ✅ **쓰는 것이 맞다. 금지 규칙을 지킬 길은 없다.**
- 실측: `grep -n TRUNCATE test/*.e2e-spec.ts` → 쓰는 스위트 **8벌**(계획안은 5로 과소 기재 — `logistics-goods-receipt:576` · `logistics-goods-issue:1184` · `logistics-picking:672` · `logistics-document-progress:1028` · `inventory-transaction:418` · `inventory-balance:418` · `inventory-posting:124` · `trace-lot:528`). 금지 규칙을 지키는 스위트는 **전부 원장 0행**이다(`production-material-return:10` 「원장 행을 한 건도 만들지 않는다」 · `production-material-consumption:15` · `production-work-session:7` · `production-precheck-decision:7` · `logistics-shopfloor-receipt:16`). 규칙의 범위 서술 ✅.
- 대안 부재 실측: `block_ledger_line_mutation()` 은 **무조건 RAISE**(BEFORE UPDATE OR DELETE · `migration.sql:2977-2993`)라 접두어 DELETE 가 물리적으로 불가능하다. `session_replication_role`/`DISABLE TRIGGER` 는 소유자·슈퍼유저 권한이 필요하고 선례 0건 — 권하지 않는다.
- ⚠ **동시 실행 위험은 계획안이 과대평가했다** — e2e 는 `--runInBand` + `maxWorkers: 1`(`package.json:22` · `test/jest-e2e.json`)로 **한 프로세스 직렬**이다. 남는 위험은 「개발자가 같은 DB 에 jest 를 둘 띄울 때」뿐. ✏ §8-2·§11 ⑥ 을 그 수준으로 낮춰 적는다.
- ⚠ CASCADE 부작용 서술 ✅ 정확하다(`putaway_task`·`goods_receipt_line` 이 함께 빈다). 그리고 **입고 스위트가 이미 그렇게 하고 있다** — 새로 만드는 위험이 아니다. 정리 순서 ⓐⓑⓒ ✅.

**11. 조회 2** — ✅. `AND: [...]` 명시 ✅(전개 덮어쓰기 방지). 정렬·404·ETag ✅ 계약과 일치.

**12. 문의 4** — ✅ 넷 다 새 문의다. ✏ 두 곳: 059+1 에 B-2(입고 취소가 닫힌다)와 「판별자는 트리거 때문에 사후 수정 불가」를 싣는다 · 059+3 은 B-2 로 **범위가 좁아졌음**을 반영해 「전 라인이 `PENDING` 인 입고를 취소했을 때만 남는다」로 조인다. 059+4 를 둘로 가를 필요는 없다 — 둘 다 `M-01-05` §5-2-1 한 화면이 원천이라 답이 한 자리에서 온다.

**13. e2e · PR · 모델** — ✏ **PR 3 을 권고한다.**
- e2e 24 는 과하지 않다(원장 8칸 대조·2×2 네 갈래가 전부 다른 실패 모드). ✏ **+2**: B-2 회귀 1(적치 뒤 입고 `:cancel` 이 `SUCCESSOR_EXISTS`) · 같은 위치 적치 1 ⇒ **26**. 회귀 스위트는 **4**(입고·수불·잔액 + `logistics-document-progress`).
- ② 예산 ≤200 은 **B-1(+25) 때문에 현실적이지 않다**. 계획안의 두 안 중 **ⓐ(전이표를 PR ① 로)만으로는 부족**하다 — 전이표는 15줄뿐이다. ⇒ **ⓐ + ⓑ 를 함께**: PR ① 조회+뷰+권한+전이표(sonnet ≤190) · PR ② `:complete` + `putaway-posting.ts` + 잔액 하한 판정 + e2e(**opus** ≤200) · PR ③ `:complete-temporary` 모드 분기 + e2e 5(sonnet ≤90). 코어 예산 규칙(CLAUDE.md 「코어 전용 PR, diff ≤ 200」)을 지키는 유일한 배치다.
- ① sonnet ✅ · ② opus ✅ · ③ sonnet.

**14. 자기 관점 계획서와의 어긋남 중 구현에 영향 주는 것** — §10-1 대조표의 integration 행(#5·#6·#11) 실측: `plan-integration.md` 120행·316행의 `STOCK_TRANSFER` 배정과 「같다」 ✅ · 317행 `capacityQty`/`COMPLETED_TEMPORARY` ✅ · 584행 ∥ I-3 은 I-3 병합으로 위험 0 ✅. ✏ 대조표에 **#13 을 추가**한다: 「`plan-integration.md` §4-1 M1 마디가 적치 완료로 끝나지만, 그 완료가 M1 의 «입고 취소» 마디를 닫는다(B-2) — 체인 e2e 는 취소를 적치 «앞»에 두어야 한다」.

## 인계 보강 (§11)

- ① I-13: ✏ 「059+1 의 답을 **I-13 착수 전에** 받는다 — 판별자는 쌓인 뒤 못 고친다(`block_ledger_header_mutation`)」.
- ③ I-5: ✏ B-2 를 명시. `document-cancel-execute.service.ts` 는 여전히 무변경이지만 **관측 동작이 바뀐다**.
- ⑤ `assertWorkerNo`: ✏ 넷째가 아니라 **여섯째 사본**이다 — `lot-complete.service.ts:164` · `work-session.service.ts:181`(주석이 「다섯째 사본」이라 적었다) · `material-return.service.ts:160` · `precheck-decision.service.ts:70` 이 이미 있다. 적치는 「사번 존재 확인」이 필요하므로 `work-session.service.ts:181` 형(조회 있는 쪽)을 복제한다. 공용화 우선순위를 **올린다**.

---

**재수립 결과** — I-12.md 에 반영할 수정 **9건**: ⓐ §3-7 잔액 하한 판정 단계 신설(B-1 · 오늘 500 이 샌다) ⓑ §3-8·§11 ③·§10-1 에 「적치 완료가 입고 취소를 `SUCCESSOR_EXISTS` 로 닫는다」(B-2) ⓒ §3-5 `PostingEndpoint` 4칸/라인 3칸 분리 표기 ⓓ §3-1 ⑧ 의 400 을 「던진다」로 강등(도달 불가) ⓔ §9-1 에 「같은 위치 적치」 1행 ⓕ §3-6·§11 ① 에 「판별자는 사후 수정 불가 — 059+1 은 I-13 전에」 ⓖ §6 `document-state.spec.ts` 는 두 줄(25→27) ⓗ §8-2 TRUNCATE 선례 5→8 · 동시 실행 위험은 `--runInBand` 로 낮음 ⓘ §7-4 `assertWorkerNo` 넷째→여섯째.
**plan.md 에 반영할 것**: `plan-api.md` S03 96행(`from_location` 파생) 폐기 · 101행(「설계 미정 없음」) 폐기 · 964행 권한 1→2 · `plan-uiux.md` 209~210행 ETag 삭제 · `plan-integration.md` §4-1 M1 에 「입고 취소 마디는 적치 «앞»」.
**문의 최종 4건**(059+1~4 · 신규 0 추가 · 059+1 과 059+3 본문만 보강).
**PR 분할·모델 최종안**: **3** — ① 조회2+뷰+권한2줄+전이표(sonnet ≤190) · ② `:complete`+posting+잔액 하한(**opus** ≤200) · ③ `:complete-temporary`(sonnet ≤90). e2e **26** · 단위 9 · 회귀 4스위트.
**한 줄 판정**: 판별자 `STOCK_TRANSFER` + `putaway_task_id` **✅ 채택**(대안 셋 전부 실측으로 더 나쁘다 — 되돌릴 수 없다는 점만 059+1 에 명시) · e2e `TRUNCATE` **✅ 허용**(트리거가 DELETE 를 무조건 던져 다른 길이 없고, 원장 쓰는 스위트 8벌이 이미 그 규약이다).
