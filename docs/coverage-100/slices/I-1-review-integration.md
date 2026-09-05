# I-1 재검토 — **통합 관점** (전표 체인·코어 재작업 비용)

> 대상 `I-1.md` · 브리프 `brief-I-1-review.md`. 계약 사본 `a6a87e1` 읽기 전용. 실측 2026-09-06.
> 판정 축: **뒤 9자리(I-2·I-4·I-5·I-7·I-14·I-18·I-23)가 이 코어를 어떻게 부르는가.**

## 0. 상신 9자리 실측 — 이 관점의 근거표

| 상신 오퍼레이션 | 슬라이스 | 승인 유형 | 응답 | 대상 표 `approval_request_id` |
|---|---|---|---|:-:|
| `purchase-orders/{id}:request-approval` | I-2 | `PURCHASE_ORDER` | 202 `ApprovalRequestRef` | ❌ (A1 이 더한다) |
| `goods-issues/{id}:request-approval` | I-4 | `GOODS_ISSUE_DISPOSAL` | 202 | ✅ |
| `adjustments/{id}:request-approval` | I-14 | `INVENTORY_ADJUSTMENT` | 202 | ✅ |
| `production-results/{id}:request-approval` | I-7 | `PRODUCTION_RESULT_CORRECT` | 202 | ❌ |
| `lots/{id}:request-iqc-skip` | I-18 | `IQC_SKIP` | 202 | ❌ |
| `document-progress/{type}/{id}:request-cancel` ×3 | I-5 | `INBOUND_RECEIPT_CANCEL`·`GOODS_RECEIPT_CANCEL`·`GOODS_ISSUE_CANCEL` | 202 | 입하✅ / 입고❌ / **출고는 이미 점유** |
| `shipments/{id}:request-cancel` | I-23 | `SHIPMENT_CANCEL` | **200 `Shipment`** (본문도 `ShipmentCancelRequest`) | ❌ |

⇒ 응답 모양이 **둘**(202 Ref 8 · 200 Shipment 1) · FK 를 가진 대상은 **3**뿐 · `app.document_cancellation` 에는 승인 FK 가 **없다**(실측).

## 1. I-1.md 가 놓친 것 — 넷 (구현 전에 고쳐야 뒤가 안 뒤집힌다)

### G-1 ⛔ 코어 «자리»가 아키텍처 금지에 걸린다

`server-architecture.md` §1: 「⛔ **도메인이 다른 도메인의 service 를 부르지 않는다. 공유가 필요하면 그것은 `core` 다.**」
`plan-integration.md` §3-1 I-23 은 이 규칙 때문에 출하가 `GoodsIssueService` 를 못 부른다고 **이미 판정했다**.
그런데 I-1.md §3 은 `ApprovalService` 를 `src/app/approval/`(= app **도메인**)에 두고 7개 도메인 service 가 그것을 부른다 —
**같은 금지에 정면으로 걸린다.** `plan.md` §3 코어표(「`src/app/approval/` 서비스 — 9자리가 3줄 호출」)도 같은 오류다.

**✏ 둘로 가른다.** 되돌림 비용이 지금은 0, I-2 이후에는 7모듈 import 경로 수정이다.
`src/core/approval/` = `selectRoute`·`expandSteps`·`decide` (+I-2 의 `request`·`assertNoOpenRequest`·`assertApproved`) /
`src/app/approval/` = 컨트롤러 12건 + 결재선 CRUD + 결재함 매퍼(app 전용). `src/core/` 에 이미 둘이 서 있어 새 개념이 아니다(§2 2단계 기준 5).

### G-2 ✏ `assertApproved`·`assertNoOpenRequest` 에 `approvalTypeCode` 가 없다

`goods_issue` 한 표가 **두 유형**을 탄다 — `GOODS_ISSUE_DISPOSAL`(I-4 품의) · `GOODS_ISSUE_CANCEL`(I-5 취소).
I-1.md §3-4 의 `assertApproved(tx, targetTypeCode, targetId)` 는 유형을 안 보므로 **취소 요청이 승인된 출고를 `:post` 가
「품의 승인됨」으로 읽고 전기한다** — 원장이 잘못 움직이는 자리다(이 슬라이스 최대 위험).
`(target_type_code, target_id, approval_type_code, status_code)` 넷으로 조회해야 한다. `assertNoOpenRequest` 도
계약이 취소에만 `CANCEL_IN_PROGRESS` 를 요구하므로 유형 인자가 필요하다.

### G-3 ✏ 「정본 연결」을 I-1 이 못 박지 않으면 I-4·I-5 가 같은 칸을 놓고 싸운다

계약은 `GoodsIssue.approvalRequestId` 를 「이 출고가 어느 승인 요청에서 **나왔는지**」(= 품의)로 정의했고,
취소 이력을 담는 `document_cancellation` 에는 승인 FK 가 없다. **I-1 이 한 줄로 고정한다**(`plan.md` §5 횡단 규칙에 싣는다):

> 문서의 `approval_request_id` FK 는 **업무 승인 하나만** 담는다(`PURCHASE_ORDER`·`GOODS_ISSUE_DISPOSAL`·`INVENTORY_ADJUSTMENT`).
> `*_CANCEL`·`IQC_SKIP`·`PRODUCTION_RESULT_CORRECT` 는 FK 를 쓰지 않는다 — 정본은 `approval_request.(target_type_code, target_id)` 다.
> 승인 판정은 **언제나 다형 축으로** 조회한다.

없으면 I-5 가 `goods_issue.approval_request_id` 를 취소 요청으로 덮어써 I-4 의 품의 승인 흔적이 사라진다. **되돌리려면 데이터 복구다.**

### G-4 ➕ `selectRoute(businessUnitId)` 를 채울 값이 9자리 중 1자리에만 있다

`purchase_order` 만 `business_unit_id NOT NULL` 이다. `goods_issue`·`inventory_adjustment`·`lot`·`shipment`·
`production_result`·`goods_receipt`·`inbound_receipt` 에는 **칸이 없다**(실측). 그런데 계약 `ApprovalRoute.approvalTypeCode` 는
「자재 폐기와 제품 폐기를 가르는 축은 결재선의 `businessUnitId` 이고 서버가 **전표의 `reasonCode` 로 파생한다**」(✓확정 2026-09-01)라 적었다 —
**`reasonCode → business_unit` 매핑이 계약에도 물리에도 없다.**
**§2 절차** — 0단계 선례 없음 · 1단계 **가장자리**(사업부 지정본이 실제로 등록된 뒤에만 갈린다) · 2단계 기준 3(매핑표를 안 만든다)
→ **호출자가 준다. I-2 의 P/O 만 전표 값을, 나머지 8자리는 `null`(공통본).** 3단계 흔적 = 문의 021 + 주석.
⇒ 시그니처는 그대로 두되 **「지금은 8자리가 null 을 준다」를 계획안에 적어야** I-4 가 매핑표를 지어내지 않는다.

## 2. 브리프 판정 6항목

1 문의 = ✅018·020 · ✏019(범위 확대) · ➕021(§3) · 2 3함수 I-2 이관 = **✏ 조건부 동의**(§4) · 3 J-8 상태 조회 = **✅ 동의**(§5) ·
4 `screenId` 생략·`approverIsActive=false` = **✅ 둘 다 동의 + 배포 노트 1행**(§6) · 5 PR 분할 = **✏ 개수 동의, 순서 수정**(§7) · 6 어긋남 = **3건**(§8)

## 3. 문의 후보 (브리프 1)

- **018 `inProgressCount` 유형 축 근사** — ✅ **새 문의 · 절차 동의**(1~15번·`계약-되돌림-mdm.md`·016·017 에 같은 물음 없음, grep 실측).
  통합 근거 보강: **9 상신자 중 아무도 `approval_route_id` 를 안 읽는다** → 되돌려도 재작업 전파 0.
- **019 `screenId`/`W-03-09`** — ✏ **범위를 넓혀 한 건으로 묶는다.** `plan.md` §7 이 이미 「승인 유형 9값에 특채 없음」을 **I-21** 몫으로
  세웠는데 **뿌리가 같다**(계약이 «특채·한도승인 → W-03-09» 를 한 문장으로 적었고 9값에 특채가 없다).
  문의는 루틴 끝에 «일괄» 전달되므로 I-21 까지 기다릴 이유가 없다 — **019 에 합치고 §7 의 I-21 행은 삭제한다.**
- **020 `INBOUND_LOT` 대응 표 없음** — ✅ **새 문의.** ⭐ 근거를 하나 더 실었다: `app.entity_type_registry` 에
  `@@unique([schema_name, table_name])`(`uq_entity_type_table`)이 걸려 있고 `LOT → (trace, lot)` 이 **이미 등재돼 있다**(시드 17행 실측).
  ⇒ 설계가 「`INBOUND_LOT` = `trace.lot`」이라 답해도 **그대로는 등재가 불가능하다** — `LOT` 로 흡수하거나 유일 제약 완화 마이그레이션이 필요하다.
  회신의 선택지를 바꾸는 사실이므로 요청서에 반드시 싣는다(첫 실사용처는 I-18).
- ➕ **021 `GOODS_ISSUE_DISPOSAL` 결재선의 `businessUnitId` 파생** — §1 G-4. I-4(5번째)에서 «필요»해지지만 **시그니처는 I-1 에서 굳는다.**
- ⛔ 문의로 안 올리는 것에 동의(①「나」주체 ②표시명 ③`status_code`). **하나 더** — `approval_request_no` 채번 형식은 **대기 14번에 이미 들어 있다.**

⇒ **문의 최종 4건.**

## 4. `request()` I-2 이관 (브리프 2) — ✏ 조건부 동의

**동의 근거(통합)**: ①I-1 12건에 상신이 0건이라 프로덕션 사용처가 없다 ②`approval_request_no` 채번을 I-1 에서 만들면
`plan-integration.md` §8 위험 4(`count()+1` 15벌 복사)의 **첫 벌이 승인에서 태어난다** ③첫 사용처 I-2 가 바로 다음이라 대기 0
④**e2e 가 막히지 않는다** — `test/app-notice.e2e-spec.ts` 가 `prisma.*.create` 로 픽스처를 직접 만드는 관행이 이미 있다(실측).

**조건 셋** —
1. **`expandSteps`(결재선 → `approval_step` 전개)는 I-1 코어에 둔다.** `approve` 의 순차 판정이 그 결과를 읽으므로
   전개 규칙(`stepNo` 1..N · `approver_id ← approver_user_id`)이 I-1 단언과 I-2 생성으로 갈리면 조용히 어긋난다.
   I-2 의 `request()` 는 「채번 + INSERT + `expandSteps` 호출」 세 줄이 된다.
2. **I-1 e2e 픽스처를 `test/helpers/approval-request.fixture.ts` 한 파일에 모은다** — I-2 가 그 안만 실제 `:request-approval` 호출로 갈아끼우게.
3. **`plan.md` §1 의 I-2 PR 예산 3 → 4.** I-2 코어 PR(≤200줄)은 채번(+`GR-`·`PT-` 이관)만으로 예산을 채운다.
   승인 3함수를 같은 PR 에 넣으면 코어 PR 규칙을 깬다 — 「채번 코어」와 「승인 상신 코어」 둘로 나눈다.

⚠ 셋을 안 달면 이관은 비용을 I-2 로 떠넘긴 것이 된다. 달면 순서·건수 불변이고 §0 의 「조건 2 에 안 걸린다」 판정에 동의한다.

## 5. J-8 = 상태 조회 (브리프 3) — ✅ 동의

근거 둘을 더한다 — ①**콜백은 아키텍처가 금지한다**(G-1 과 같은 규칙, 방향만 반대) ②`PRODUCTION_RESULT`·`SHIPMENT`·
`INBOUND_LOT`·`GOODS_RECEIPT` 는 **FK 조차 없어** 콜백 대상을 되짚을 수단이 없다(§0 표). ⇒ 상태 조회가 «유일하게 성립하는» 갈래다.
`assertApproved` 를 I-1 에서 만들지 않는 것(사용처 0)에도 동의. 단 G-2 대로 유형 인자를 반드시 싣는다.

## 6. `screenId`·`approverIsActive` (브리프 4) — ✅ 둘 다 동의

- §6-2 동의. 파장 한 줄 — 계약은 **9 유형 어디에도** `screenId` 매핑을 주지 않았다(특채는 유형 목록에도 없다).
  ⇒ `openable` 이 **전건 `false`**, 결재함 W-CO-09 의 「원 화면 열기」가 루틴이 끝날 때까지 **항상 비활성**이다.
  ✏ **`plan.md` §6 배포 노트에 1행 추가** — 라벨 POP·프린터 `OFFLINE` 과 같은 등급의 「알고 내보내는 반쪽」이다.
- §6-3 동의. 생길 수 없는 행이고 `false` 가 사실에 가깝다. 결재선 정의의 소유자가 I-1 하나라 뒤 파장 없음.

## 7. PR 분할·순서 (브리프 5) — ✏ 개수 4 동의, **순서 수정**

I-1.md 는 ①결재선 CRUD → ②활성전이+결재함 조회 → ③**코어** → ④결재로 **코어가 세 번째**다.
그런데 PR② 결재함 조회의 `currentStepNo`·`isMyTurn`·`isCurrent` 는 「첫 미결 단계 찾기」이고 PR③ 코어의 `NOT_YOUR_TURN` 판정과
**같은 함수**다 — 지금 순서면 두 벌이 선다(§8 위험 4·5 와 같은 패턴).

**✏** ①**코어**(`src/core/approval/`: `selectRoute`·`expandSteps`·순차 판정 + `transitions.ts` 2전이, ≤200줄)
→ ②결재선 CRUD + 단계 치환(A6 를 이 PR 의 선행 커밋으로) → ③활성 전이 + 결재함 조회(코어를 «부른다») → ④`:approve`/`:reject` + e2e.
PR 수·줄 수·오퍼레이션 배분은 그대로. 부수 효과 — 「I-2 가 무엇을 물려받는가」가 PR① 하나로 읽힌다.

그 밖 ✅ — A6 선행 커밋 · `PUT …/steps` 에 `runVersioned` 대신 부모 `version_no` 동반 증가(⭐ I-2 `PUT …/lines`·I-22 가 그대로 베끼는 **첫 벌**이라 정확해야 한다) ·
`entity_type_registry` 2행 시드(I-2·I-14 의 선행 결손을 미리 닫는다 — 두 코드 다 `uq_entity_type_table` 충돌 없음, 실측).

## 8. 계획서 어긋남 중 «구현에 영향 주는 것» (브리프 6) — 3건

1. `plan-integration.md` §3-1 I-1 의 「`status_code` 값 목록이 `#213` 대기」는 **낡았다.** I-1.md §4-1 이 옳다(시드 3값 2026-09-02 등재, 실측). **I-1.md 채택.**
2. `plan-integration.md` §2 「`screenId` 생략 = **3자리**(`ApprovalTarget`·`DocumentTarget`·`DocumentProgress`), I-5·I-27 재사용」
   vs I-1.md §3-6 「패턴이 이미 쓰이면 헬퍼를 안 만든다」 → **✏ 헬퍼를 만든다.** 계약이 세어 준 사용처가 3이라
   「사용처 하나뿐인 추상화 금지」에 안 걸린다. 안 만들면 I-5·I-27 이 각자 `null` 을 내린다 — 계약이 막은 바로 그것.
3. `plan.md` §3·I-1.md §3 의 코어 **자리** — G-1. 뒤 7슬라이스의 import 경로를 바꾸는 유일한 차이다.

---

## 9. 재수립 결과 — 5줄 요약

1. **I-1.md 에 반영할 수정 6건** — ①코어를 `src/core/approval/` + `src/app/approval/` 로 분리(도메인 간 service 호출 금지)
   ②`assertApproved`·`assertNoOpenRequest` 에 `approvalTypeCode` 추가(출고 한 표가 두 유형 — 원장 오전기 위험) ③「FK 는 업무 승인만, 취소는 다형 축이 정본」 명문화
   ④`selectRoute(businessUnitId)` 는 「P/O 외 8자리가 `null`」 명기 ⑤PR 순서를 **코어 먼저** ⑥`request()` 이관에 조건 셋(`expandSteps` 는 I-1 · 픽스처 1파일 · I-2 PR 3→4).
2. **plan.md 에 반영할 것 5건** — §3 코어 자리 `src/app/`→`src/core/` · §1 의 **I-1 PR 3→4 및 I-2 PR 3→4** · §5 에 「FK vs 다형 축」 1행 ·
   §6 배포 노트에 「결재함 «원 화면 열기» 전건 비활성」 1행 · §7 에 I-1 문의 4행 추가 + I-21 「특채」 행 삭제(019 로 흡수).
3. **문의 최종 4건** — 018(`inProgressCount` 근사) · 019(`screenId` W-03-09 + 특채 유형 부재, I-21 흡수) ·
   020(`INBOUND_LOT` — ⭐ `uq_entity_type_table` 때문에 `LOT` 와 공존 불가라는 실측 동봉) · **021(폐기 품의 결재선의 `businessUnitId` 파생)**.
4. **동의** — J-8 상태 조회 · `screenId` 생략/`openable=false` · `approverIsActive=false` · A6 하나 유지 ·
   `PUT …/steps` 부모 버전 동반 증가 · PR 4개 · `request()` 를 I-2 로 미루는 방향 자체.
5. **「차이가 크다」 판정** — 「셋 중 셋째(문의)만」에 **동의하지 않는다.** 코어 자리 수정(G-1)은 `plan.md` §3 을,
   I-2 예산 3→4 는 §1 표를 고치므로 **통합 계획서 본문 수정**이다. 다만 순서·슬라이스 경계·마이그레이션 수는 불변이라 재수립 비용은 여전히 작다.
