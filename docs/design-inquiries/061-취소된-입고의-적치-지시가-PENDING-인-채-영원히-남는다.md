# 61. 취소된 입고의 적치 지시가 `PENDING` 인 채 영원히 남는다 — 닫을 값도 오퍼레이션도 없다

| 칸 | 내용 |
|---|---|
| 걸리는 오퍼레이션 | `POST /logistics/document-progress/GOODS_RECEIPT/{id}:cancel` · `POST /logistics/putaway-tasks/{putawayTaskId}:complete` · `:complete-temporary` · `GET /logistics/putaway-tasks` |
| 구현 상태 | **구현함(I-12 · 취소된 입고(`CANCEL_REQUESTED`·`CANCELLED`)의 지시는 완료가 400 `STATE_LOCKED` · 지시 상태는 옮기지 않음 · 취소 실행은 무변경)** |
| 판정 | `coverage-100/README.md` §2 1단계 가장자리 → 2단계 **기준 2**(거부 · 거부→허용이 완화) · 닫는 값은 `PUTAWAY_TASK_STATUS` 가 시스템 소유라 서버가 늘리지 않는다(F-6) |
| 되돌릴 때 | 「취소 실행이 지시를 함께 닫는다」면 상태값 하나 추가(시드 + `transitions.ts` 한 줄 + `document-cancel-execute.service.ts` 한 자리) · 「목록 축」이면 조회 한 줄 |

## 무엇이 문제인가

ⓐ 다형 취소(I-5)가 「`putaway_task` 를 안 건드린다」로 갔다 — 계약 `DocumentSuccessor` 5값에 `PUTAWAY_TASK` 가 없어 후속으로 셀 수도 없다(`I-5.md` §6-4 가 I-12 로 넘긴 자리). 그 결과 취소된 입고의 지시가 `PENDING` 으로 목록에 남는다.
ⓑ 서버는 완료를 400 으로 **막기만** 한다 — 잔액만으로는 막을 수 없기 때문이다. `inventory_balance` 는 «차원» 키(창고·위치·품목·LOT·품질·재고상태·소유)이지 전표 키가 아니라, 같은 LOT 이 같은 하역장으로 다시 입고되면 잔액이 채워지고 취소된 지시가 **남의 물건을 조용히 옮긴다**.
ⓒ 그러나 **지시를 «닫는» 길이 없다** — `PUTAWAY_TASK_STATUS` 3값에 「취소됨」이 없고(시스템 소유) 지시를 지우는 오퍼레이션도 0건이다.
ⓓ `M-01-05` 목록이 영원히 죽은 행을 이고 간다. 걸리는 형상은 **전 라인이 `PENDING` 인 입고를 취소했을 때**뿐이다 — 적치가 하나라도 완료된 입고는 취소 자체가 `SUCCESSOR_EXISTS` 로 막힌다(아래).

## 지금 서버는

- `putaway-complete.service.ts` 가 원장을 쌓기 전에 `goods_receipt.status_code ∈ {CANCEL_REQUESTED, CANCELLED}` 를 보고 400 `STATE_LOCKED`「취소된 입고의 적치 지시입니다」.
- ⭐ 반대 방향은 이미 닫혀 있다 — 적치가 완료되면 그 원장(LOT 축)이 입고의 후속으로 세어져 `:cancel`·`:request-cancel` 이 400 `SUCCESSOR_EXISTS` 다(`cancel-eligibility.service.ts` `lotAxis` · 코드 변경 0 · e2e 가 못 박음). 업무적으로 옳다 — 적치된 재고를 입고 취소로 되돌리면 하역장 하한에서 `NEGATIVE_BALANCE` 가 난다.

⇒ **묻는 것**: 상태값을 넷째(「취소됨」)로 늘릴 것인가 · 취소 실행이 지시를 함께 처리할 것인가 · 목록 질의에 「살아 있는 것만」 축을 열 것인가.

흔적: `docs/coverage-100/slices/I-12.md` §3-8 · R-3 · §11 ③ · `src/logistics/putaway/putaway-complete.service.ts` · `test/logistics-putaway-task.e2e-spec.ts`.
