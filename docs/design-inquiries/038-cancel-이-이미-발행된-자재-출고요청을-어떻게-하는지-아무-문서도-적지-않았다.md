# 38. `:cancel` 이 이미 발행된 자재 출고요청을 어떻게 하는지 아무 문서도 적지 않았다 — 취소된 W/O 의 요청이 남아 피킹으로 흘러간다. 덤으로 `W-02-06` 에 취소 `reasonCode` 를 고르는 칸이 없는데 계약은 required 다

| 칸 | 내용 |
|---|---|
| 걸리는 오퍼레이션 | `POST /production/work-orders/{id}:cancel` (I-8 `material-issue-requests` 인계) |
| 구현 상태 | **구현 예정(I-6 · 출고요청은 건드리지 않는다 · `reasonCode` 는 계약대로 required · `WORK_ORDER_CANCEL_REASON` 6값 대조)** |
| 판정 | `coverage-100/README.md` §2 1단계 가장자리(배포된 W/O 의 취소만) → 2단계 기준 1(재고·원장·상태를 쓰지 않는 쪽) — 요청의 상태 축은 I-8 이 세우는 것이라 여기서 값을 지어 바꾸지 않는다 |
| 되돌릴 때 | 「요청도 함께 취소」로 오면 `:cancel` 트랜잭션에 `UPDATE material_issue_request SET status_code=<취소값>` 한 줄(I-8 이 상태 값을 세운 뒤). 「피킹이 시작된 요청은 남긴다」면 조건 한 줄 |

## 무엇이 문제인가

`:release` 가 자재 출고요청을 자동 발행하고(R29 · 문의 037), `:cancel` 은 `RELEASED`·`IN_PROGRESS`·`SUSPENDED` 에서도 성립한다(계약 `from` 5값). 그러면 **배포된 W/O 를 취소할 때 이미 발행된 요청이 어떻게 되는가** — 계약 `:cancel` description 에도, 취소 화면 `W-02-06` 전문에도 「출고요청」·`material_issue_request` 문자열이 **0건**이다(실측). 서버가 요청을 남기면 자재창고 화면(`W-02-10`)에 취소된 W/O 의 요청이 그대로 떠 피킹으로 흘러갈 수 있다. 서버가 요청을 지우거나 상태를 바꾸면 그 표의 상태 값 목록(#145 미결)을 우리가 짓게 된다.

한 줄 더: `W-02-06` 취소 화면에 `reasonCode` 를 «고르는» 칸이 없다. 계약 `WorkOrderCancel.reasonCode` 는 required 라 화면이 그대로면 취소가 언제나 400 이다.

## 지금 서버는

- `:cancel` = If-Match → 전이(`PLANNED`·`CONFIRMED`·`RELEASED`·`IN_PROGRESS`·`SUSPENDED` → `CANCELLED`) → `cancellation_reason_code` 저장 → 선발행 슬롯 전건 폐번(`WAITING`·`ACTIVE` → `VOIDED`). **`material_issue_request` 는 읽지도 쓰지도 않는다.**
- `reasonCode` 는 `WORK_ORDER_CANCEL_REASON` 6값 대조(400 `INVALID`). `note` 는 담을 칸이 없어 버린다.
- `app.document_cancellation` 다형 표는 쓰지 않는다(I-5 가 3값으로 닫은 축이고 W/O 는 그 목록에 없다).

흔적: `:cancel` 주석 `// 발행된 출고요청은 건드리지 않는다 — 처분 규칙이 어디에도 없다(문의 038 · I-8 인계)` · e2e `cancel — 발행된 출고요청 행은 그대로 남는다`.
