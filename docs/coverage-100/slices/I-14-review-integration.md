# I-14 계획안 재검토 — **integration 관점**(원장·체인·트랜잭션)

> 대상 `slices/I-14.md`(854줄) · base `origin/main` 771c541 · 실측일 2026-09-07.
> ⭐ 실측 부록(§801~)은 재측정하지 않았다. **예외 2건만 다시 쟀다** — ①③ 판정에 직접 걸려서다:
> `check_balance_qty()` 원문(baseline `migration.sql:2831-2857`) · 계약 조정 경로·`document-progress` enum(python3 전수).
> 둘 다 **부록과 일치**했다(뒤집힘 0).

## 1. 판정 5개

### ① 라인 두 칸을 등록·치환 시점에 저장 — **✏ 수정**(방향 동의 · 전기 시점 규칙 2개 누락)

「저장한다」는 옳다 — `assertNotApproved`(`goods-issue-update.service.ts:242-258`)와 같은 결로 **승인자가 본 것**이 원장에 나간다. 「전기 시점 재조회」로 뒤집지 않는다. NOT NULL 완화로도 뒤집지 않는다(§2-4 근거 그대로). ⇒ **마이그는 1건 그대로다.**

그런데 **`:post` 시점 규칙이 두 자리 비어 있다.**

- **✏ I-1. 잠금은 7칸인데 잔액 차원은 11칸이다.** `lockBalancesInOrder`(`balance-lock.ts:41-61`)와 형제 `lockBalances`(`issue-posting.ts:339-360`)는 `(법인·사업부·공장·창고·위치·품목·COALESCE(lot,0))` **7칸**으로 잠그고 여러 행을 낼 수 있다. 반면 `move()` 의 `ON CONFLICT`(`inventory-posting.service.ts:270-278`)는 **11칸**(+품질·재고·소유·소유처)이다. §3-3 은 등록·치환 시점의 0행/1행/2행+ 만 규정했고 **§3-4 손검사가 어느 행을 보는지 안 적었다.**
  ⇒ **전기 손검사와 `ownershipTypeCode` 되읽기를 「라인에 저장된 두 코드로 좁힌 11칸 행」에서 한다**를 §3-1 ⑨·§3-4 에 못 박는다. 안 그러면 감(−) 라인이 다른 차원 행의 잔액으로 검사를 통과한 뒤 `move()` 가 **저장 코드의 행**을 새로 만들어 음수로 밀고 트리거 500 이다(`prisma-error.ts` 그물 밖 · §1-6 이 이미 경계한 자리).
  또 7칸이 2행인데 저장 코드와 맞는 행이 **0행**인 경우(등록 뒤 그 차원이 사라진 경우)의 답도 없다 — §3-3 말미 「라인 저장값이 이긴다」의 연장으로 **감(−) 400 `NEGATIVE_BALANCE` · 증(+) 그대로 전기**(`move()` 가 만든다)를 명시한다.
- **⭐ ✏ I-2. 같은 레인 I-13 이 조정을 «영구 400» 으로 만드는 자리를 판다.** I-13 은 도착 위치에 `{도착 창고, IN_TRANSIT}` 잔액 행을 **미리** 세운다(`plan-integration.md:337` · 도착 위치를 앞당겨 쓴다). 그 위치·품목·LOT 은 그때부터 7칸 조회가 **2행**(`AVAILABLE` + `IN_TRANSIT`)이라 §3-3 이 **등록 단계에서 400 `INVALID`** 를 낸다 — 이동 중인 품목은 조정도 실사 차이 닫기도 못 한다. 「가장자리」가 아니라 **본길에 닿는다.**
  ⇒ ⓐ 문의 **130** 본문에 이 사례를 싣는다(오늘의 유일한 2행 생성원이 I-13 이다) ⓑ e2e 한 갈래 추가(§3 ⑧) ⓒ §13 에 **ⓗ I-13 → I-14** 를 신설한다.
- **✏ I-3.** 「증(+) 0행 = 400」은 **물리적 불가가 아니라 정책**이다 — `move()` ①이 11칸 행을 0으로 만들고 ②가 올리므로 코어는 만들 수 있다(`inventory-posting.service.ts:262-284`). §3-3 표에 「막을 수 있어서가 아니라 값을 지어내지 않으려고 막는다」 한 줄. 판정 자체는 ✅.
- ✅ 소유 축을 라인에 저장하지 않고 `:post` 가 잠근 행에서 되읽는 것(§3-3 말미)은 `issue-posting.ts:209-210` 과 같다 — 단 I-1 의 11칸 좁히기가 여기에도 걸린다.

### ② 마이그 1건(`inventory_count_line_id`) — **✅ 동의**(보강 1)

계약 두 스키마가 정의했고 물리에 없다(부록 #14). 「계약 칸을 버린다」가 더 싸지 않다 — **I-15 `:close` 가 이 축을 요구**하고(`plan-integration.md:342`) 헤더 축으로는 「6건 중 4건만 조정」을 못 가른다. 2단계 기준 3(스키마 안 늘림)보다 기준 4(값을 조용히 버리지 않음)가 이기는 근거를 §2-4 가 이미 적었다. FK 이름을 안 적는 처방도 옳다.

- **✏ 보강** — 이 FK 가 **e2e 파급을 하나 더 만든다**: I-15 가 `TRUNCATE inventory.inventory_count_line … CASCADE` 를 쓰면 `inventory_adjustment_line` 이 통째로 비워진다(§10-1 이 `inventory_transaction_line` 쪽만 적었다). §13 ⓐ 에 한 줄 넣는다.

### ③ 부호 가름 + `negative_stock_allowed` 3갈래 — **✅ 동의**(재측정으로 확인 · ✏ 입력 1)

baseline 원문 재측정: `on_hand ≥ 0` → `on_hand < reserved+picked+blocked` 금지 / `on_hand < 0` → `item.negative_stock_allowed` 필요 **그리고** `reserved+picked+blocked > 0` 금지(`migration.sql:2836-2853` · `trg_inventory_balance_qty` **BEFORE INSERT OR UPDATE**). **§3-4 표 3행이 원문과 정확히 같다.** 부록 #18 뒤집힘 0.

「두 오퍼레이션이 갈리는 것」은 **옳다** — 갈림의 주체는 서버가 아니라 계약이다. `issue-posting.ts:155-156` 주석이 「계약 `issueQty` 가 「보유 수량 이하」로 **예외 없이 닫았다**」를 무시의 근거로 적었고, 조정 계약에는 그 문장이 없다. 같은 저장소에 두 규칙이 서는 것을 「알려둘 것」 ⓕ 가 이미 싣는다. ⇒ ⛔ 아님.

- **✏** 손검사 입력을 `available_qty` 로 대신할 수 없다는 §3-4 말미가 맞다 — 두 잠금 SELECT 모두 `on_hand/reserved/picked/blocked` 를 **안 내린다**(`balance-lock.ts:52-56`·`issue-posting.ts:346-357` 실측). 도메인 SELECT 를 한 벌 두는 것에 동의하되 **11칸으로 좁혀** 뽑는다(①-I-1). 두 SELECT 모두 `ORDER BY inventory_balance_id FOR UPDATE` 라 `post()` 의 선잠금(`inventory-posting.service.ts:68`)과 순서가 같아 교착 없음 — §3-4 판정 ✅.

### ④ 원장 헤더 `plant_id` 를 라인 위치에서 역산 · 두 공장 400 — **✅ 동의**(근거 1 보강)

「첫 라인의 공장」은 ⛔ 다 — 코어가 잔액 3축을 **엔드포인트 창고에서 다시 푼다**(`orgAxis` · `inventory-posting.service.ts:305-312`). 헤더 `plant_id` 와 라인 잔액의 공장이 갈리면 **원장 헤더가 잔액과 다른 공장을 적는다**(`inventory_transaction.plant_id` NOT NULL · 부록 #17). 단일 공장 검사가 그 정합의 유일한 보증이다 — 이 근거를 §3-5 에 적는다.
「헤더에 칸 추가」는 마이그 2칸 + 계약에 없는 축이라 기준 3 위반. ⇒ 역산 + 400 이 맞다.
⚠ 사업부·법인은 **창고가 각자 안다**(코어가 창고별로 푼다) — 조정이 두 사업부에 걸쳐도 잔액은 옳다. 400 은 **공장 축만** 본다는 것을 §3-5 에 한 줄로 못 박는다(과잉 차단 방지).

### ⑤ PR 4 분할 + `transitions.ts` A 소유 — **✅ 동의**(✏ 배선 1)

- PR 4 ✅. 「자르는 선은 «재고를 쓰나»」가 되돌림 비용과 맞고, 형제 7파일 **1,652줄** 실측(부록 #37)이 ②③ 합본 ~490 을 뒷받침한다. 통합 계획서 셋의 **3** 은 조정 4 오퍼레이션을 한 칸으로 본 예상치다(`plan-api.md:193`) — 실측이 이긴다.
- **✏ PR ① 의 `inventory.module.ts` +10.** 조회 3건은 코어를 **하나도 안 쓴다**. ①에 `Idempotency/Posting/Approval/Numbering` 넷을 미리 넣으면 미사용 배선이 ②③④ 판정에 묶인다. ⇒ **①은 컨트롤러·쿼리 서비스 등록만**, 코어 imports 는 쓰는 PR 에서 한 줄씩 더한다. 그러면 ①의 예산도 ~290 으로 준다.
- **① 병행 스폰 ✅** — 「반드시 볼 자리 5」 중 ①에 닿는 것이 0 이라는 §12 근거가 성립한다. 위 ✏ 를 반영하면 더 깨끗하다. ②③④ 는 R-n 확정 뒤 ✅.
- `transitions.ts` 키 신설 ✅ — 축 **12** 재확인(전이표 최상위 키 실측: `mdm.equipment`·`mdm.mold`·`planning.routing`·`planning.production_plan`·`trace.lot`·`production.work_order`·`production.work_session`·`app.approval_request`·`logistics.goods_issue`·`inbound_receipt`·`goods_receipt`·`putaway_task`). 키 이름 `inventory.inventory_adjustment.status_code` 가 기존 규약과 같다. §13 ⓖ 의 사전 알림 ✅ · I-13 과의 `toHaveLength` 충돌(§13 ⓓ) ✅.

## 2. 문의 6건(130~135) — **전건 신규 ✅** · 132 는 직접 재확인

- **132 재확인 완료**(브리프 지시) — 계약 `contracts/logistics-01자재창고.json` 의 조정 경로는 **5개(7 오퍼레이션)** 뿐이고 `:cancel`·`:reverse` 가 **0건**, 취소 경로는 `/logistics/document-progress/{documentTypeCode}/{documentId}:cancel` 뿐인데 그 `documentTypeCode` **enum 9값에 `INVENTORY_ADJUSTMENT` 가 없다**(python3 전수 · 부록 #9 와 일치). ⇒ **`I-5.md:790-796`(「I-14 = `reverse()` 둘째 사용처」)는 ⛔ 뒤집힌다.** §12-1 #12·§13 ⓒ 의 판정 ✅.
  ⇒ `plan-integration.md:665`(유혹 3 「역트랜잭션 3벌」)의 **셋째가 오늘 서지 않는다** — 표에서 지우지 말고 「조정 역분개는 계약에 경로 0 · 문의 132」로 고쳐 남긴다(뒤에 회신이 오면 되살아난다).
  ⚠ `inventory-posting.service.ts:110-111` 주석(⌜I-14 가 `post()` 로 낸 역분개도 같은 짝 칸을 채운다⌝)이 낡았다 — 코어 파일이라 고치지 않고 기록만 한다는 §13 ⓒ ✅.
- 130·131·133·134·135 도 `docs/design-inquiries/` 001~062 · `계약-되돌림-mdm.md` · README §0 대기 15 어디에도 같은 물음이 없다 ⇒ **신규 ✅**. 「기존으로 미룸」 5건(030·031·022·문의 14·#64)의 가름도 ✅ — 031 은 출고 축이고 130 은 **증(+) 라인이라는 새 갈래**를 얹으므로 별건이 맞다.
- ✏ **130 에 I-13 사례를 싣는다**(위 ①-I-2). 오늘 2행을 만드는 유일한 경로이고, 실사→조정 체인을 실제로 막는다.

## 3. 그 밖

- **⑦ 새 에러 코드 0건 ✅** — §1-6 의 15자리가 전부 `error-codes.ts` 기존 값이고 `lanes.md:70`(⛔ 새 코드 추가 금지)을 지킨다.
- **⑧ e2e 35 / 단위 9 에서 빠진 갈래 4** — 계획자가 접지 않았고 그냥 없다:
  1. ⭐ **두 공장에 걸친 라인 → 400 `INVALID`**(§3-5 · 문의 133 의 핵심) — e2e 35·단위 9 어디에도 없다. **등록 e2e 1건** 추가.
  2. ⭐ **`:post` 시점 7칸 2행+** — 등록 뒤 그 위치에 다른 품질/재고 상태 행이 생긴 채 전기(①-I-1·I-2). e2e 1건(픽스처가 `IN_TRANSIT` 행을 직접 심으면 된다).
  3. **같은 (위치·품목·LOT) 에 증·감이 함께 실린 전표** — §3-4 「키별 합산」의 유일한 물증. 단위 ③은 순서 보존만 본다. **단위 1건**.
  4. `adjusted_at` 이 `null` 인 채 목록 `adjustedAtFrom/To` 로 걸러도 미전기 전표가 안 잡힌다 — e2e 5 가 덮지만 **전기 뒤 잡힌다**의 짝이 없다(경미 · 5 에 한 줄 덧대면 된다).
- **⑨ 자기 관점 계획서(`plan-integration.md`)와의 어긋남 — 구현에 영향 주는 것 4**: `178`(마이그 열 ✕ → **⭕ 1**) · `342`(I-15 「라인 대응이 없다」 → **이 슬라이스가 연다**) · `665`(유혹 3 셋째 → 「오늘 서지 않는다」) · `335`(예상 설계 미정 「안 실으면 400」 → **「잔액에서 읽어 저장, 못 읽으면 400」**으로 구체화). §12-1 #1·#12·#13 이 셋을 이미 적었고 `665` 만 빠졌다.
- ✅ 트랜잭션 경계·멱등: 컨트롤러 `runIdempotent(…, OK, …)` → 서비스 `$transaction`, 채번은 tx **밖**(`numbering.service.ts:71` 주석 · `goods-issue-update.service.ts:186-190`), 헤더 `FOR UPDATE` 를 tx 첫 문장에 — 형제와 같다. `assertApproved`/`assertNoOpenRequest` 시그니처(`approval.service.ts:103`·`:141`)와 §3-7·§6-3 호출이 맞는다.
- ✅ 파티션 사고 없음 — `inventory_transaction` 은 **DEFAULT 파티션**이 있다(`migration.sql:1167-1168`)이라 임의 `businessDate` 가 INSERT 를 깨지 않는다. 「빠진 갈래」로 세지 않는다.
- ✅ 공용 자원: `entity_type_registry` 에 `INVENTORY_ADJUSTMENT` 실재(`seed.ts:1377-1382`) — I-14 가 시드를 안 건드린다. `DocumentTypeRegistryChecker`(`document-type-registry.ts:99-116`)는 **9종 → 등록부** 한 방향만 대조하므로 조정이 9종에 없어도 부팅 경고가 늘지 않는다. 채번 `DEFAULT_PREFIX` 한 줄(`numbering.service.ts:9-28`)은 공용이지만 추가 전용이라 순차 병합 대상 아님.

## 4. 결론

⛔ **반대 0건.** 다섯 판정의 **방향은 전부 유지**되고, 마이그 1건·PR 4·문의 6건이 그대로 선다. 반영할 것은 **전기 시점 11칸 규칙**(①-I-1)·**I-13 과의 2행 충돌**(①-I-2)·**e2e 3갈래**·**PR ① 배선 축소**다. 멈춤 조건(README §3) **해당 없음** — 두 릴리스 규칙 미해당(삭제 0) · 게이트 실패 없음 · 계약 모순 없음.
