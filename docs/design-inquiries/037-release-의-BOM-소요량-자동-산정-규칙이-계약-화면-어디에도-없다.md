# 37. `:release` 의 「BOM 소요량 자동 산정」(R29) 규칙이 계약·화면 어디에도 없다 — ⓐ `bom_component` 의 공정 칸 둘 중 어느 축으로 담나 ⓑ `scrap_rate` 를 곱하나

| 칸 | 내용 |
|---|---|
| 걸리는 오퍼레이션 | `POST /production/work-orders/{id}:release`(자재 출고요청 자동 발행) — 같은 산식을 I-8 `material-issue-requests` 의 `shortage` 가 쓴다 |
| 구현 상태 | **구현 예정(I-6 · ⓐ `bom_component.routing_operation_id = work_order.routing_operation_id` 인 라인만 · `NULL` 라인 제외 · ⓑ 스크랩률 미적용 · `required_qty × (order_qty ÷ bom.base_qty)`)** |
| 판정 | `coverage-100/README.md` §2 — ⓐ 1단계 가장자리 → 2단계 기준 1(전건을 담으면 같은 계획의 공정 W/O 셋이 같은 자재를 세 번 요청 — 중복 발행은 되돌리기 비싸다) · `NULL` 라인은 기준 4(「공정 미지정 = 전 공정 공통」은 우리가 지어내는 뜻). ⓑ 기준 4 — 어느 문서에도 산식이 없어 조용히 곱하지 않는다 |
| 되돌릴 때 | ⓐ 가 `actual_use_process_id` 축이면 where 한 줄 · 「`NULL` 은 전 공정 공통」이면 `OR IS NULL` 한 줄. ⓑ 가 「곱한다」면 산식 한 줄을 **`:release` 와 I-8 `shortage` 두 곳에 같이** 바꾼다(R-18) |

## 무엇이 문제인가

계약 R29 는 ⌜배포 시 BOM 소요량을 자동 산정해 자재 출고요청을 만든다⌝ 라고만 적고 산정 규칙은 어디에도 없다(`W-02-04`·`W-02-10` 전문에 산식 0건). 물리를 보면 결정할 것이 둘 남는다.

### ⓐ `bom_component` 에 공정 칸이 둘이다

`bom_component.routing_operation_id` 와 `bom_component.actual_use_process_id` — **둘 다 nullable** 이고 어느 쪽이 「이 W/O 공정에서 쓰는 자재」의 정본인지 문서가 없다. W/O 는 `routing_operation_id` 하나를 가진다. 서버는 이름이 같은 `routing_operation_id` 축으로 담고, 공정이 비어 있는(`NULL`) 라인은 담지 않는다. 결과가 0건이면 헤더도 만들지 않는다.

### ⓑ `scrap_rate` 를 곱하나

`bom_component.scrap_rate` 칸이 있다. 소요량 = `required_qty × (order_qty ÷ bom.base_qty)` 까지는 칸 이름으로 서지만, 스크랩률을 «곱하는» 산식은 어느 문서에도 없다. 서버는 곱하지 않는다 — 이 슬라이스도, I-8 의 부족량(`shortage`)도 같은 판정이며 답이 오면 양쪽을 함께 바꾼다.

## 지금 서버는

`:release` 한 트랜잭션 안에서 `logistics.material_issue_request(_line)` 에 직접 INSERT 한다(`src/logistics/material-issue-request/` 는 아직 없다 — I-8 이 이 칸·상수를 그대로 승계한다).

| 칸 | 값 |
|---|---|
| `issue_request_no` | `MIR-{YYYYMMDD}-{SEQ4}`(형식 확정은 문의 14 표) |
| `destination_location_id` | `work_order.default_wip_location_id` — 없으면 **요청 없이 배포는 성공**(`W-02-04` §6 「W/O 확정 진행·출고요청만 실패 안내」와 일치 · 실패 안내를 실을 응답 칸은 없다 → I-8) |
| `status_code` | `'REQUESTED'` 상수(그룹 없음 · 판정에 쓰지 않는다 · 기존 미결 #145) |
| `reason_code` | NULL(`MATERIAL_ISSUE_REQUEST_REASON` 4값에 「BOM 자동 발행」 없음) |
| 라인 | `routing_operation_id = work_order.routing_operation_id` 인 `bom_component` · `requested_qty = required_qty × (order_qty ÷ bom.base_qty)` · 스크랩률 미적용 |
| 제외 | `work_order_type_code='EMERGENCY'` 는 통째로 건너뛴다(계약 G-4 · `REWORK` 는 제외 아님) |

흔적: 산식 주석 `// scrap_rate 를 곱하지 않는다 — 산식이 어느 문서에도 없다(문의 037 · I-8 shortage 와 같이 바꾼다)` · 단위 테스트 `release — 공정이 NULL 인 bom_component 는 담지 않는다` · `release — 스크랩률을 곱하지 않는다`.
