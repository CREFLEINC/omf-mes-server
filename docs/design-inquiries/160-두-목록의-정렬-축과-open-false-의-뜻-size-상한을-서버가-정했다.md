# 160. 공정 인계·수리 두 목록의 **정렬 축**과 **`open=false` 의 뜻**, **`size` 상한**을 서버가 정했다 — 「투입 대기 목록」의 첫 줄은 «가장 최근» 건이다

> ⚠ 이 통보의 핵심 한 줄: 계약이 `GET /production/repair-executions?open=true` 를 **「투입 대기 목록」**이라 두 번 부르는데, 계약도 화면 정본도 **정렬을 적지 않았다**. 서버 기본 정렬은 **`startedAt` 내림차순**이므로 **첫 줄이 «방금 투입한» 건**이고, 공유계약 **L-12 의 「경과일 긴 순」과 반대 방향**이다.
> ⚠ 같은 모양의 손잡이(`page`·`size`)가 **두 목록에서 다르게 검증된다** — 한쪽은 잘리고 한쪽은 400 이다.

| 칸 | 내용 |
|---|---|
| **구분** | ⭐ **통보** — 계약이 값을 적지 않아 서버가 고정했다. 무엇으로 고정했는지와 업무에 걸리는 대가를 알린다. 회신을 기다리지 않는다 |
| 걸리는 오퍼레이션 | `GET /production/operation-handovers` · `GET /production/operation-handovers/{operationHandoverId}`(라인 순서) · `GET /production/repair-executions` |
| 구현 상태 | **구현 예정(I-25 · 계획 PR 만 · 오늘 코드 0줄)**. 계획서 `docs/coverage-100/slices/I-25.md` §0 자리 3 · §3 |
| 판정 | `coverage-100/README.md` §2 **0단계 선례로 닫힌다** — 정렬·여집합·상한 셋 다 이 저장소에 구현된 선례가 있다. **2단계 기준 5**(새 개념 0 — 계약에 없는 상한·질의 축을 지어내지 않는다) |
| 되돌릴 때 | 정렬은 **`ORDER_BY` 상수 한 줄 + e2e 정렬 단언 2건**이다(방향을 뒤집어도 같다). `open` 의 뜻은 `where` 한 줄. 인계 목록에 `minimum`·`maximum` 이 계약에 서면 **가드가 자동으로 400 을 내고 서버 코드는 0줄** 바뀐다 |

## 무엇이 문제인가

### ⓐ 두 목록 다 계약이 정렬을 적지 않았다

`plan-uiux.md:922-930` 이 「계약이 정렬 값을 적은」 목록 **다섯**(`asns` 도착예정일 오름차순 · `approval-routes/{id}/steps` `stepNo` 오름차순 · `inspections` 점검시각 내림차순 · `breakdowns` 경과일 긴 순 · `shipments` 경과일 긴 순)과 `sort` 파라미터를 연 **여덟**을 열거하는데, **우리 둘은 어느 쪽에도 없다.** ⇒ **서버가 정한다.**

**서버가 정한 값** — 둘 다 **시각 내림차순 + PK 내림차순**

| 목록 | `ORDER_BY` |
|---|---|
| `GET /production/operation-handovers` | `handed_over_at desc, operation_handover_id desc` (라인은 `line_no asc`) |
| `GET /production/repair-executions` | `started_at desc, repair_execution_id desc` |

**근거 셋** (⛔ **물리 인덱스는 근거가 아니다** — `ix_repair_execution_open (started_at DESC) WHERE returned_at IS NULL` 은 btree 라 **역방향 스캔**이 되므로 `ORDER BY started_at ASC` 도 같은 비용으로 받는다. 인덱스가 정하는 것은 «정렬 키»이지 «방향»이 아니다)

1. **이 저장소의 «구간형 open 목록» 선례 둘이 전부 내림차순이다** — `lot-hold-query.service.ts:45`(`held_at desc, lot_hold_id desc` — 시각 축이 있는 쪽) · `work-session-query.service.ts:33-35`(`work_session_id desc` — 시각 축이 없는 쪽). **오름차순 선례는 0건.** 이 자원은 `started_at` 이 NOT NULL 이고 계약이 그 축으로 기간 필터도 열었으므로 **앞의 모양**을 따른다.
2. **전표 목록의 같은 모양** — `material-return-query.service.ts:24-28` 「정렬 키가 계약에 없다 ⇒ 서버가 고정한다 … 동률은 PK 로 닫는다」.
3. **`plan-uiux.md` 갈래 ② 에 이 목록이 없다** — `:919`(② 미처리 전건 · 공유계약 **L-12** 「기본이 미처리 전건, 정렬은 «경과일 긴 순»」)의 열거는 `/maintenance/breakdowns`·`/maintenance/inspections`·`/maintenance/downtimes?openOnly=true`·`/logistics/shipments` 다. `/production/repair-executions?open` 은 **`:920` 갈래 ③(구간 형 리소스)에만** 있다. 그리고 ② 에서 「경과일 긴 순」이 실제로 적힌 둘(`breakdowns`·`shipments`)은 **계약·화면 명세가 값을 직접 적은** 자리다.

### ⓑ ⭐ 그 대가 — **「투입 대기 목록」의 첫 줄이 «가장 최근» 투입 건이다**

계약이 `GET /production/repair-executions` 를 두 곳에서 스스로 그렇게 부른다:

> 경로 description — ⌜⭐ **`open=true` 가 「투입 대기 목록」이다**⌝
> `open` 파라미터 — ⌜반출 시각이 없는 것만. 기본 true — **이것이 투입 대기 목록이다**⌝

우리 기본 정렬대로면 M-02-02 를 연 작업자가 목록 첫 줄을 집을 때 **방금 투입한 건**이 잡히고, **3일째 수리 중인 건**은 페이지 뒤로 밀린다(`size` 기본 50). `plan-uiux.md:932-933` 이 경고한 그대로다 — 「⚠ 기본 정렬을 안 정하면 화면이 매번 다른 순서를 본다. POP 은 「첫 줄을 집는」 조작이 많아 **기본 정렬이 곧 업무 판정이 된다**」.

⇒ **오래 걸린 건부터 집어야 한다면 계약이 `sort` 를 열거나 기본 정렬 값을 적어야 한다.** 서버가 L-12 를 임의로 가져오지 않은 이유는 ⓐ-3 이다(정본이 이 목록을 갈래 ② 에 넣지 않았다).

### ⓒ `open=false` 는 «전체»가 아니라 **여집합**이다

계약은 `open`(boolean · **default true**)만 적고 `false` 의 뜻을 적지 않았다.

- ⇒ **여집합** — `open ?? true` → `returned_at: null` · `false` → `returned_at: { not: null }`(**반출된 것만**).
- 0단계 선례가 **같은 모듈의 같은 모양**이다 — `work-session-query.service.ts:46`·`:56`(「`open ?? true` → `ended_at: null` / `false` → `{ not: null }`(여집합 — I-6 `held` 선례)」).
- ⛔ I-20 의 `activeOnly=false`(=전체)와 **다르다** — 이름이 `activeOnly` 라 여집합이 아니고, 이쪽 계약은 `open` 이다.

### ⓓ ⭐ 같은 손잡이가 **두 목록에서 다르게 검증된다**

| 목록 | 계약의 `page`·`size` 선언 | 실제 동작 |
|---|---|---|
| `GET /production/repair-executions` | `page.minimum 1` · `size.minimum 1 · maximum 200` | `size=201`·`page=0` → **400** (계약 검증 가드가 막는다) |
| `GET /production/operation-handovers` | **상·하한 0** | `size=1000` → **200** · 결과가 `MAX_SIZE=200` 으로 **잘린다**(400 이 아니다) |

두 목록의 업무 성격이 다르지 않은데 손잡이의 계약 선언만 다르다. 서버는 어느 쪽도 지어내지 않았다 — 있는 대로 따른다(`pagination.ts:13-14`·`:44-45` · `contract-validation.guard.ts:39-42`).

⚠ **덤 — 그 400 은 계약이 «선언하지 않은» 응답이다.** 두 목록 다 **200 하나만** 선언하는데, 계약 검증 가드는 질의 파라미터를 계약 스키마(`minimum`/`maximum` 포함)로 검증해 `ContractException(400)` 을 던진다. 저장소 전역 동작이고 이 슬라이스가 만든 문제가 아니지만, `maximum: 200` 을 적으면서 400 을 선언하지 않은 것은 **계약 쪽 흠**이다.

### ⓔ 그 밖에 서버가 고정한 것 둘

- **`statusCode` 필터는 받은 문자를 그대로 건다** — 대조하지 않는다(`x-no-code-key` 라 코드 그룹이 없다 · `material-return-query.service.ts:45` 선례). 값 원천 문제는 **문의 159**.
- **인계 목록·상세가 라인을 «둘 다» 싣는다** — 목록·상세가 같은 `OperationHandover` 스키마라 한쪽을 비우면 자리마다 모양이 갈린다(`material-return-query.service.ts:50-51`·`:57` 과 같은 근거). 라인 순서는 `line_no asc`.
- **기간은 반개구간** `gte`/`lt`(공유계약 L-3). ⛔ 두 목록 다 **기간 필수가 아니다**(갈래 ① 에 없다).

## 지금 서버는

- **아직 없다.** 계획이 정한 동작은 위 ⓐ~ⓔ 그대로이고, e2e 가 **같은 시각 두 행을 반드시 심어** 2차 정렬 키를 지켜본다(동률 픽스처가 없으면 2차 키를 지워도 초록이라 단언이 죽는다).
- `open=false` 픽스처에 **반출된 행 1개**를 반드시 둔다 — 없으면 `returned_at: null` 조건을 지워도 초록이다.
- 두 목록의 `size` 갈래를 **각각** 단언한다(하나는 자름 · 하나는 400) — 두 단언이 서로를 지켜본다.

⇒ **알리는 것**: 두 목록의 정렬 축·`open=false` 의 뜻·`size` 상한을 서버가 고정했다. ⭐ 특히 **계약이 「투입 대기 목록」이라 부른 목록의 첫 줄이 «가장 최근» 투입 건**이라는 사실 — 공유계약 L-12 의 「경과일 긴 순」과 반대 방향이다.

흔적: `docs/coverage-100/slices/I-25.md` §0 자리 3 · **§0-재수립 R-8** · §1-2 · §3-1·§3-3 · §9-1 #6·#7·#8 · `I-25-review-uiux.md` §2-4 · M5 · `I-25-review-api.md` n-1 · `contracts/production-02생산실행.json`(`GET /production/repair-executions` description · `open`·`page`·`size` 파라미터) · `src/quality/lot-hold/lot-hold-query.service.ts:45` · `src/production/work-session/work-session-query.service.ts:33-35`·`:46-56` · `src/production/material-return/material-return-query.service.ts:24-28`·`:45`·`:50-51` · `src/common/pagination/pagination.ts:13-14`·`:44-45` · `src/common/contract/contract-validation.guard.ts:39-42` · `docs/coverage-100/plan-uiux.md:919`·`:920`·`:922-930`·`:932-933` · 공유계약 L-3·L-12·G-16.
