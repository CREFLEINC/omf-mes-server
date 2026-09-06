# 60. 임시 적치가 dead end 다 — 정위치로 되돌릴 오퍼레이션이 0건이고, 되돌릴 때 볼 사유·원장·버전이 응답에 없다

| 칸 | 내용 |
|---|---|
| 걸리는 오퍼레이션 | `POST /logistics/putaway-tasks/{putawayTaskId}:complete-temporary` · `GET /logistics/putaway-tasks`(`temporaryOnly`) · `GET …/{putawayTaskId}` |
| 구현 상태 | **구현함(I-12 · `COMPLETED_TEMPORARY` 는 나가는 전이 0 · `reason_code`·`remarks`·`inventory_transaction_line_id` 는 저장만 하고 응답에 싣지 않음)** |
| 판정 | `coverage-100/README.md` §2 1단계 **본길** → 계약 문자(전이 0건 · 응답 스키마 18칸에 세 칸 부재) 그대로 |
| 되돌릴 때 | 복귀 오퍼레이션을 열면 `transitions.ts` 한 줄 + 서비스 한 자리(원장 한 줄 더) · 세 칸을 응답에 더하면 뷰 세 줄(마이그 0) |

## 무엇이 문제인가

ⓐ `PUTAWAY_TASK_STATUS` 3값에 `COMPLETED_TEMPORARY → COMPLETED` 전이를 여는 오퍼레이션이 계약에 **0건**이다. `M-01-07` §5-4 는 복귀를 `M-01-10`(재고이동)으로 넘겼는데, `M-01-10:139` 는 「창고 «안» 이동은 헤더 없이 수불만」이라 적어 **창고 안 위치 이동을 담을 업무 문서가 없다**. `plan-uiux.md` 1174 는 「적치로 흡수」로 판정했으나 적치에는 **재적치 오퍼레이션이 없다** — 적치는 `goods_receipt_line` 이 있는 건만 옮긴다.
ⓑ `PutawayTask` 응답 스키마에 **`reasonCode` 가 없다** — 저장은 하는데 「왜 임시로 뒀나」를 화면이 못 본다. `temporaryOnly` 목록의 첫 손님(`M-01-10` 정위치 이동 대상 선택)이 바로 그 값이다.
ⓒ **`inventoryTransactionLineId` 도 응답에 없어** 적치가 만든 원장 줄을 화면이 되짚을 수 없다.
ⓓ `versionNo` 도 없어 다음 `If-Match` 는 `GET …/{id}` 의 ETag 로만 얻는다(두 POST 는 dead end 라 오늘은 되쓸 자리가 없다).
ⓔ 임시 적치 알림은 `M-01-05:166` 표지 `#90` · A-11 물러남을 그대로 따른다(재보고 아님 — 인용만).

## 지금 서버는

- `transitions.ts` `logistics.putaway_task.status_code` 키에 `putaway-complete`·`putaway-complete-temporary` 둘만 — `COMPLETED`·`COMPLETED_TEMPORARY` 에서 나가는 전이 0(단위 테스트가 못 박음).
- 임시 적재도 원장 한 줄을 쌓고(임시 위치가 잔액의 위치 축) `reason_code`·`remarks` 를 저장한다. 응답 `PutawayTask` 는 계약 18칸 그대로.
- `GET /logistics/putaway-tasks?temporaryOnly=true` 가 `status_code='COMPLETED_TEMPORARY'` 만 낸다(`statusCode` 와 겹치면 AND).

⇒ **묻는 것**: 복귀 경로를 열 것인가(어느 오퍼레이션 · 어느 화면) · `reasonCode`·`inventoryTransactionLineId`·`versionNo` 세 칸을 응답에 더할 것인가. `plan-uiux.md` §9-1 A 요청서 후보와 **묶어** 답한다.

흔적: `docs/coverage-100/slices/I-12.md` §1-4 · §4 · §6 · R-5 · `src/core/document-state/transitions.ts` · `src/logistics/putaway/putaway-task-view.ts`.
