# 53. 값 목록 없는 NOT NULL 코드가 여섯인데 계약이 「서버가 정한다」로만 적었다 — 판정 확인 요청

> 첫 줄에 적어 둔다. 계약이 `x-no-example`·`x-internal-note` 로 ⌜임의 코드를 example 로 넣으면 **확정값처럼 읽힌다** — omf-mes#252⌝ 라 경고한 바로 그 자리다. 서버는 응답 required 를 채우려고 **잠정 문자열**을 골랐고 화면이 그 값을 본다 ⇒ **값 목록을 달라는 요청이 아니라 그 판정이 맞는지 확인해 달라는 요청**이다.

| 칸 | 내용 |
|---|---|
| 걸리는 오퍼레이션 | `POST /production/material-consumptions` · `POST /production/material-returns` |
| 구현 상태 | **구현함(I-10 · 상수 셋 `NORMAL`·`RECORDED`·`REQUESTED` 를 서버가 골랐다 · `return_quality_status_code` 는 NOT NULL 완화 마이그 M-2)** |
| 판정 | ①② 는 `coverage-100/README.md` §2 **0단계** — 계약이 `x-no-code-key` + ⌜서버가 정한다/기록한다⌝ 로 **판정 주체를 넘겼고** 응답 required 라 값이 있어야 한다(선례는 I-9 `REGISTERED` 가 아니라 **I-7 `RESULT_STATUS='CONFIRMED'`** — `production-result.service.ts:143` · 코드 그룹 0행 · 판정에 안 씀). ③ 은 요청·응답 **어디에도 칸이 없어** 무엇을 기록할지조차 위임받지 않았다 → 2단계 기준 3·4 + README §5(물리와 계약이 다르면 물리를 고친다) |
| 되돌릴 때 | 값이 정해지면 상수 파일 **한 줄씩**(`material-consumption.constants.ts:5` · `material-return.constants.ts:4`) · ③ 은 M-2 를 되돌리는 마이그 한 줄(두 표 0행이라 백필 없음) |

## 무엇이 문제인가 — **세 갈래로 갈라 답해 달라**

**① 뜻이 있는데 문자열이 없는 것 — `consumption_type_code`**
ⓐ 계약이 ⌜보내지 않으면 서버가 기본 투입 유형으로 기록한다 · **값 목록은 아직 확정 전**⌝ + `x-no-code-key` ⌜남는 것이 「정상」 **하나**다⌝ 라 적어 **뜻은 줬다**. 없는 것은 그 뜻을 담을 «문자열»뿐이고 `CONSUMPTION_TYPE` 코드 그룹 자체가 DB 에 없다. ⇒ 서버가 `'NORMAL'` 을 골랐다.

**② 이름뿐인 것 — `material_consumption.status_code` · `material_return.status_code`**
ⓑ 둘 다 `x-no-code-key` 에 ⌜기록 전용 · **전이 액션 0건**⌝ / ⌜전이 액션도 없다 · 진행은 `requestedAt ↔ receivedAt` 의 유무로 판정한다⌝ 라 적혔다. 뜻이 「출발점」밖에 없어 서버가 `'RECORDED'`·`'REQUESTED'` 를 골랐다. ⚠ I-9 의 `'REGISTERED'` 를 베끼지 않았다 — 그것은 `LOGISTICS_DOCUMENT_STATUS` 4값이 실재하는 물류 문서의 값이고 이 두 표는 그 그룹에 속하지 않는다(`DocumentProgress.documentTypeCode` 9값에도 없다).

**③ 칸조차 없는 것 — `material_return_line.return_quality_status_code`**
ⓒ 계약 라인의 required 4 + 선택 1 **어디에도 이 칸이 없는데 물리는 NOT NULL** 이고 `RETURN_QUALITY_STATUS` 코드 그룹도 0행이다 ⇒ 값을 지어내는 대신 **제약을 풀었다**(M-2). 응답에도 그 칸이 없으므로 화면에는 안 보인다.

ⓓ `lot_relation`·`material_usage_allocation` 의 `relation_type_code`·`allocation_method_code`·`trace_accuracy_code` 도 같은 상태다 — 052 가 그 표를 안 쓰기로 해 오늘은 안 걸리지만, 계보를 잇는 날 **세 값이 먼저 있어야 한다**.
ⓔ 덤: `LATE_ENTRY_REASON`·`MATERIAL_CHANGE_REASON` 은 그룹은 있는데 **값이 0행**이라 대조를 걸지 않았다(걸면 전건 400 · 드롭다운이 빈다 — I-7 이 이미 보고). `package_opened`·`quality_check_required` 도 계약 칸이 0이라 DEFAULT false 그대로 둔다.

## 지금 서버는

- 상수 셋을 상수 파일에 `// 설계 미정 — 문의 053` 주석과 함께 두고 INSERT 에만 쓴다. **판정에는 쓰지 않는다**(조회도 이 값을 대조하지 않고 필터 문자를 그대로 넘긴다).
- `return_quality_status_code` 는 마이그 M-2(`20260907700000`) 로 nullable 이 됐고 서버가 값을 넣지 않는다 — 뷰 단위 테스트가 그 사실을 못 박는다.

흔적: `docs/coverage-100/slices/I-10.md` §2-5 M-2 · §8-1 #2·#9 · R-4 · R-5 · `material-consumption.constants.ts:5` · `material-return.constants.ts:4` · `material-return-view.spec.ts:16`.
