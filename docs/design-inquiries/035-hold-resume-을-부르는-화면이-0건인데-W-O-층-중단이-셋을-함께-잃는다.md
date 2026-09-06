# 35. `:hold`/`:resume` 을 부르는 화면이 0건인데 W/O 층 「작업 중단」이 셋을 함께 잃는다 — ⓐ `WORK_ORDER_HOLD_REASON` 값 0건 ⓑ 중단 구간을 담을 표가 없어 `held` 가 상태 문자열 근사다 ⓒ `RELEASED`→홀드→재개가 세션 없는 `IN_PROGRESS` 를 만든다

| 칸 | 내용 |
|---|---|
| 걸리는 오퍼레이션 | `POST /production/work-orders/{id}:hold` · `:resume` · `GET /production/work-orders?held=` |
| 구현 상태 | **구현 예정(I-6 · 계약 문자 그대로 · 사유·시각·메모는 형식만 검증하고 저장하지 않는다 · `held` = `status_code='SUSPENDED'` 근사 · `WORK_ORDER_HOLD_REASON` 코드값 대조 안 건다)** |
| 판정 | `coverage-100/README.md` §2 — ⓐ·ⓑ 는 1단계 가장자리(전이 자체는 성립하고 사유의 «보존»만 갈린다) → 2단계 기준 3(스키마를 안 늘리는 쪽). ⓒ 는 계약 문장을 좁히는 것이라 문자 그대로 두고 문의. ⓓ 코드값 대조를 걸면 모든 `:hold` 가 400(본길)이라 걸지 않는다 |
| 되돌릴 때 | 「중단 구간 표를 세운다」로 오면 `production.work_order_hold`(사유·시각·메모·해제 시각) 마이그 1 + `held` 를 미종료 행 EXISTS 로 바꾼다(I-6.md §6-2 ⓑ). 사유 값 목록이 오면 시드 1행씩 + `assertCodeValues` 를 켠다. ⓒ 가 「`RELEASED` 에서는 홀드 불가」로 오면 전이표 `from` 에서 한 값을 뺀다(한 줄) |

## 무엇이 문제인가

**부르는 화면이 0건이다.** `P-02-10` §5-4 · `P-02-01` §5-5 의 「중단」은 **세션 사건**(`work_session_event` · `STOP`)이고 W/O 층 `:hold` 를 부르지 않는다(omf-mes#247 · #261). 그런데도 계약에 `:hold`·`:resume` 오퍼레이션이 서 있고, 그 요청 본문 `WorkOrderHold` 는 `reasonCode`(required)·`occurredAt`(required)·`note` 를 보낸다. 셋을 받아서 어디에 두는지가 비어 있다.

### ⓐ 사유 값 목록이 0건이다

`WORK_ORDER_HOLD_REASON` 그룹은 시드에 있고 **값이 없다**(`prisma/seed.ts:1259` `values: []` · `isSystemOwned` 아님 · DB 대조 0행). 화면 `P-02-10` 이 7값을 열거하지만 §5-4 가 스스로 ⌜사유는 `WORK_ORDER_HOLD_REASON` 이 아니라 `WORK_SESSION_EVENT_REASON`(7값)에서 고른다⌝ 라 적어 **두 그룹은 다르다.** 초기 값 목록을 설계가 주는가, 고객 MDM 운영이 채우는가 — 답이 오기 전까지 `assertCodeValues` 를 걸면 모든 `:hold` 가 400 이라 **이 축에는 코드값 대조를 걸지 않는다**(비어 있지 않은 문자열만 본다).

### ⓑ 중단 구간을 담을 표가 없다

`work_order` 에 사유·시각·메모 칸이 없고 W/O 층 중단 구간 표도 저장소에 0개다(`grep 'model .*hold'` → `lot_hold` 하나). `work_session_event` 는 `work_session_id` NOT NULL 이라 세션 축이고, 계약이 ⌜앞은 W/O 층의 상태, 뒤는 세션 구간 «안»의 사건⌝ 으로 두 축을 갈랐다. 계약 x-internal-note 도 ⌜작업홀드이력 구간을 «조회»하는 전용 경로는 두지 않았다 … 화면이 생기면 그때 `/production/work-order-holds` 를 신설한다⌝ 라 적었다.

그 결과 목록 질의 `held` 의 계약 문장 ⌜미종료 작업홀드이력이 있는 것만⌝ · ⌜상태 코드 문자열을 몰라도 판정된다⌝ 를 지킬 수 없다. 서버는 **`status_code='SUSPENDED'` 로 근사**한다 — 계약이 피하려던 「상태 문자열 의존」을 정확히 하는 것이라 정직하게 적는다. `W-02-08` §3 드로어의 「중단 1」·`page.total` 이 이 근사값을 쓴다. 대안 「세션 이벤트의 미종료 STOP 으로 센다」는 세션 없이도 `:hold` 가 성립해(ⓒ) 축이 다르므로 기각했다.

### ⓒ `RELEASED` 에서 홀드하고 재개하면 세션 없는 `IN_PROGRESS` 가 된다

계약 문장 둘을 그대로 붙이면 그렇다: `:hold` ⌜`RELEASED`·`IN_PROGRESS` → `SUSPENDED`⌝ · `:resume` ⌜중단→진행 전이 이벤트다 · ⭐ 세션은 다시 열지 않는다⌝. ⇒ `RELEASED --hold--> SUSPENDED --resume--> IN_PROGRESS` 인데 그 W/O 에는 `work_session` 이 한 건도 없다. `IN_PROGRESS` 로 들어가는 정상 경로는 세션 열기(I-11)뿐이라 이 경로는 **세션 없는 진행**을 만들고, `P-02-01` 의 「이 설비·배포됨」 목록에서 사라진다. `:hold` 의 `from` 에서 `RELEASED` 를 빼면 고쳐지지만 계약 문장을 좁히는 것이라 서버가 하지 않는다.

## 지금 서버는

- `:hold` / `:resume`: If-Match 대조 → 전이표(`RELEASED`·`IN_PROGRESS` → `SUSPENDED` · `SUSPENDED` → `IN_PROGRESS`) → `status_code`·`version_no` 만 갱신. `reasonCode` 는 비어 있지 않은 문자열, `occurredAt` 은 시각 형식만 검증하고 **셋 다 저장하지 않는다.** 세션에는 손대지 않는다(`work_session.ended_at`·`status_code` 그대로 — 계약 ⌜세션은 닫지 않는다⌝·⌜다시 열지 않는다⌝). `X-Worker-No` 는 읽지 않고 없어도 400 을 내지 않는다.
- `held=true` 는 `status_code='SUSPENDED'`, `held=false` 는 그 여집합.
- `derived-permissions.ts` 의 `:hold`·`:resume` 화면 매핑(`P-02-10`)은 계약에서 도출된 표라 손대지 않는다.

흔적: 전이표 주석 `// RELEASED → hold → resume 이 세션 없는 IN_PROGRESS 를 만든다 — 계약 문자 그대로(문의 035)` · 단위 테스트 `hold — 사유·시각·메모를 저장하지 않는다(담을 칸이 없다)` · e2e `hold 뒤에도 work_session 은 그대로다`.
