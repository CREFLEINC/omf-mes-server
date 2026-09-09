# 164. `handling_unit.status_code` 의 **세 번째 값**이 이미 저장소에 있고, 「라벨 발행 대기」의 원천이 통보 141 이후 **바뀌었다**

> ⚠ **셋 다 「오늘 서버가 정하고 구현할 것」 또는 「사실 정정」이다.** 회신을 기다리지 않는다.
> ⭐ 이 문의는 **레인 C 대역(120~149)의 통보 `141`·`145` 를 «가리키기만» 한다** — 그 본문은 한 글자도 고치지 않았다. ⓒ 는 **145 의 전제를 좁혀 적는 것**이지 145 를 고치는 것이 아니다.

| 칸 | 내용 |
|---|---|
| **구분** | **통보** — ⓐ 는 서버가 정한 것(목록 질의에 값 검증을 안 건다 · 조건 한 줄), ⓑⓒ 는 **사실 정정**이다. 정하고 알린다 |
| 걸리는 오퍼레이션 | `GET /inventory/handling-units` · `GET /inventory/handling-units/{handlingUnitId}` · `POST …:pack` · (인접) `POST /app/document-issues` |
| 구현 상태 | **구현 예정(I-16 · 계획만 병합됨 · 오늘 코드 0줄)** — 계획서 `docs/coverage-100/slices/I-16-a2.md` §0 자리 ④ · §3-2 · §6-1 |
| 판정 | `coverage-100/README.md` §2 **1단계 본길**(계약이 규칙은 문장으로 줬고 값만 안 줬다) → **2단계 기준 3**(칸이 이미 있다 · 마이그 0) · **기준 4**(값에 이름을 붙여 한 파일에 모은다) |
| 되돌릴 때 | ⓐ 값 목록이 계약에 서면 `handling-unit-status.ts` **두 줄**을 바꾸고 목록 질의에 `assertCodeValues` 한 줄을 더한다(마이그 0). ⓑ 「라벨 발행 대기를 `status_code` 로 세워라」가 오면 상수가 셋이 되고 `:pack` 409 갈래가 갈린다 — 그러나 그 값은 **이미 다른 표가 담고 있다**(아래) |

## 무엇이 문제인가

### ⓐ 서버 상수는 **둘**인데, 저장소에 **세 번째 값**이 이미 굴러다닌다

- 계약이 `HandlingUnit.statusCode` 를 **`x-no-code-key`**(「코드 그룹을 세우지 않는다」)로 닫았고, 물리 `handling_unit.status_code` 는 `app.code_t` **NOT NULL** 인데 **CHECK 도 DEFAULT 도 없다**(psql 실측). 값의 원천이 **전적으로 서버**다.
- 같은 계약이 「**이미 확정된 포장은 409 다**」를 요구하므로 「확정 전/후」를 가릴 축이 필요하다 ⇒ 서버 상수 **둘**(`'OPEN'`·`'PACKED'`). 이것이 **통보 141** 이 낸 결정이고 지금도 그대로다.
- ⭐ **그런데 병합된 e2e 픽스처가 세 번째 값을 쓴다** — `test/logistics-stock-transfer.e2e-spec.ts:1308-1317` 이 `status_code: 'ACTIVE'` 로 HU 를 만든다(I-13 · 병합 완료).
- ⇒ **목록 질의 `statusCode` 에 값 검증을 걸지 않았다.** 없는 코드로 물으면 **빈 목록이 정상**이고 400 이 아니다. 값 검증을 걸었다면 저장소가 이미 만드는 `'ACTIVE'` 로 조회할 방법이 사라진다.
- ⚠ 그래서 **e2e·목록 필터가 「전건이 OPEN/PACKED」를 가정하면 안 된다** — I-16 의 e2e 는 자기 픽스처를 `PREFIX` 로 거른 뒤 센다.
- ⭐ 화면 쪽 값도 확인했다 — `P-04-01` L172 의 `GET …?statusCode={포장 가능}` 에서 **「포장 가능」 = `'OPEN'`** 이다.

### ⓑ ⭐ 「라벨 발행 대기」를 담을 자리가 **생긴 것이 아니라, 오늘 처음 «쓰이기 시작»했다**

> ⛔ **먼저 정정한다.** 「`app.document_issue_log` 를 **I-27 이 병합해** 생겼다」는 **거짓이다.**

- `app.document_issue_log` 와 `ix_document_issue_target(document_type_code, target_type_code, target_id)` 은 **`20260727000000_baseline_physical_model_v3/migration.sql` 에만** 있다 — **baseline 부터 있었다.**
- I-27 의 마이그(`20260908220249_b_i27_document_issue_print_outcome`)는 **48줄이고 print 관련 칸을 더한 것뿐**이다. 표도 인덱스도 그 마이그가 만들지 않았다.
- ⭐ **바뀐 것은 «쓰는 코드»다** — I-27 이 병합되면서 그 표에 **처음으로 행이 쌓이기 시작한다**(`document_type_code='PACKING_LABEL'` · `target_type_code='HANDLING_UNIT'` · `target_id`).
- ⇒ 「이 포장에 `PACKING_LABEL` 을 냈는가」는 **이제 조회로 풀린다.** 통보 141 이 「그 값을 풀 수단이 0」이라 적은 전제 중 **절반이 오늘 성립하지 않는다.**
- ⛔ **그래도 상수를 셋으로 늘리지 않았다** — 「라벨 발행 대기」는 `M-04-03` §8 미결 2 가 스스로 철회했고, 그 축은 **다른 표**에 있다. ⛔ **I-16 은 `app.document_issue_log` 를 읽지도 쓰지도 않는다**(도메인 경계 · 계약에 축 0) — **화면이 두 조회를 겹쳐 쓴다.**
- ⚠ 그리고 이 자리는 **레인 C 가 스스로 지운 판정이 되살아난 자리**다 — C 의 R-2ⓑ 「라벨 발행 대기는 화면이 푼다」가 삭제됐다가, 위 사실로 **새 근거를 얻어 되살아났다**(`I-16-a2.md` §0-A A-2-1 S-15).

### ⓒ ⭐ 통보 145 의 전제를 **좁혀 적는다** — 여전히 못 서는 것은 **145ⓐ «와» 145ⓒ 둘**이다

> ⛔ **145 본문은 레인 C 대역이라 고치지 않는다.** 아래는 그 문서를 **가리키며** 오늘의 사실을 덧붙이는 것이다.

- **145ⓐ**(재포장 이벤트를 **HU 를 가로질러** 뽑는 조회가 0) — **여전히 못 선다.** 계약의 이벤트 조회는 `GET …/{handlingUnitId}/repack-events` 하나뿐이고 **path 전용**이다(질의 칸 0). 「어느 포장인지 이미 알아야만」 이력을 볼 수 있다. 서버는 계약에 없는 질의 축을 지어내지 않았다.
- **145ⓒ**(중첩 포장의 **하위**를 뽑는 축이 0 ⇒ 정상 파렛트가 차단된다) — ⭐ **여전히 못 서고, 오늘 «코드로 굳었다».** `document-issue-create-rules.ts:161-167` 이 `GOODS_ISSUE_QR` + `HANDLING_UNIT` 을 `hasContent` 로 막는다. 카톤을 담은 파렛트는 자기 `handling_unit_content` 가 **비어 있으므로**(내용물은 자식 HU 에 있다) 그 게이트에 **정상 파렛트가 걸린다** — `P-01-02-출고QR발행.md:213` 이 예고한 그대로다.
- ⇒ **「이제 서는 것」은 145ⓑ 쪽**(`P-04-04` ① 발행 대기 목록의 「라벨을 냈는가」 열)이고, **145ⓐ·145ⓒ 는 그대로 열려 있다.** 「145ⓐ 뿐이 남았다」로 적으면 **파렛트 차단 자리를 지우는 것**이 된다.

## 지금 서버는

- `src/inventory/handling-unit/handling-unit-status.ts` 에 상수 **둘**만 둔다 — `HU_STATUS_OPEN = 'OPEN'` · `HU_STATUS_PACKED = 'PACKED'`. `// 결정 — 통보 141` 주석이 그 자리를 가리키고, **「이 상수가 전부는 아니다」**(픽스처의 `'ACTIVE'`)를 같은 주석에 적는다.
- 목록 질의 `statusCode` 에 **값 목록 검증을 안 건다** — 없는 코드 = 빈 목록(400 아님). e2e 4 가 그 자리를 잰다.
- `POST` 초기값 `'OPEN'` · `:pack` 이 `'PACKED'` 로 옮긴다 · **`PUT …/contents` 는 상태를 안 옮긴다** · **되돌리는 전이 0**(통보 142).
- ⛔ **`transitions.ts` 를 0줄 건드린다** — 축 하나·방향 하나이고 값의 원천이 코드 그룹이 아니라 서버 상수다(`transitions.ts` 431줄에 `handling_unit` **0건** · `document-state.spec.ts:519` 가 `toHaveLength(47)`).
- ⛔ **`app.document_issue_log` 를 읽지도 쓰지도 않는다.**

⇒ **알리는 것**: ⓐ `status_code` 서버 상수는 **둘**이지만 **세 번째 값 `'ACTIVE'` 가 이미 저장소에 있어** 목록 질의에 값 검증을 걸지 않았고, ⓑ **`app.document_issue_log`+`ix_document_issue_target` 은 baseline 부터 있었으며 I-27 이 오늘 처음 «쓰기» 시작했다**(⛔ 「I-27 이 병합해 생겼다」는 거짓), ⓒ 그래서 통보 145 중 **여전히 못 서는 것은 145ⓐ «와» 145ⓒ 둘이고**, 145ⓒ(파렛트 차단)는 오늘 `document-issue-create-rules.ts:161-167` 로 **코드에 굳었다.**

흔적: `docs/coverage-100/slices/I-16-a2.md` §0 자리 ④ · §0-A A-2 S-11 · **A-2-1 S-15** · §3-2 · §6-1 · §7 · §10-1 #2 · **§0-재수립 R-3·R-11** · `I-16-a2-review-uiux.md`(M-1) · `docs/coverage-100/slices/I-16.md` §14 · `test/logistics-stock-transfer.e2e-spec.ts:1308-1317` · `src/app/document-issue/document-issue-create-rules.ts:161-167`·`:242` · `prisma/migrations/20260727000000_baseline_physical_model_v3/migration.sql`(`ix_document_issue_target`) · `prisma/migrations/20260908220249_b_i27_document_issue_print_outcome/migration.sql`(48줄) · **통보 141**(`status_code` 상수 둘) · **통보 142**(확정된 포장을 여는 길이 0) · **통보 145ⓐ·ⓒ**.
