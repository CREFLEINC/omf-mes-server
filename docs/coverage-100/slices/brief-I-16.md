# I-16 취급 단위 — 등록·구성·포장확정·재구성 이력 — 7건 — 개별 계획안 브리프 (계획만, 구현 금지)

산출물: **`docs/coverage-100/slices/I-16.md` 하나**. 저장소의 다른 파일을 고치거나 만들지 않는다. 작업 위치는 worktree
`/Users/hj.cho/A-Crefle/A-Project/OmfMes/omf-mes-server/.claude/worktrees/i16-plan`(브랜치 `docs/coverage-100-c-i16-plan` ·
base `origin/main` **771c541** · 체크아웃 변경 금지 · **`git` 쓰기 금지**).
`contracts/*.json` 읽기 전용(`jq`·`python3`). ⛔ `prisma migrate reset`·`migrate dev`·`migrate diff --shadow-database-url`·`pnpm db:seed`·`contracts:update`·`contracts:check` 금지.
로컬 DB 는 **`psql` SELECT 만** — `postgresql://omf:omf@localhost:55432/omf_mes`.
Bash cwd 는 호출마다 리셋되므로 **절대경로로 `cd`**.
형식 정본: **`docs/coverage-100/slices/I-24.md`**(§0-재수립 R 표는 통합자 몫 — 너는 §0(3조건)~§13 + 실측 부록까지). 브리프 선례 `brief-I-8.md`.
너는 **레인 C**다(`docs/coverage-100/lane-C.md`). 설계 문의 번호 대역 120~149 중 ⭐ **140 부터** 쓴다(같은 레인의 I-13 이 120~125, I-14 가 130~135 를 이미 썼다).

**대상 7건**(`assignment.tsv` 실측 · 계약 `contracts/logistics-01자재창고.json`)
| 오퍼레이션 | 403 | 계약 path 줄 |
|---|:-:|---|
| `GET /inventory/handling-units` | — | 1200 |
| `POST /inventory/handling-units` | 403 | 1200 |
| `GET /inventory/handling-units/{handlingUnitId}` | — | 1361 |
| `GET /inventory/handling-units/{handlingUnitId}/contents` | — | 1412 |
| `PUT /inventory/handling-units/{handlingUnitId}/contents` | 403 | 1412 |
| `GET /inventory/handling-units/{handlingUnitId}/repack-events` | — | 1525 |
| `POST /inventory/handling-units/{handlingUnitId}:pack` | 403 | 1568 |

커버리지 **+7**(같은 레인의 I-13·I-14 와 병렬이라 최종 숫자는 병합 순서가 정한다).

---

## ⭐ 이 슬라이스의 갈림길 — 미리 알려 둔다

1. **원장을 만드나** — `plan-integration.md:347` 초안: ⚠ **미정 → 만들지 않는다**. 포장은 「어디 있나」를 바꾸지 않고 `handling_unit_id` 차원만 붙인다(§2 2단계 **기준 1** 「재고를 안 쓰는 쪽」). ⛔ 그런데 **`inventory_balance` 의 차원에 `handling_unit_id` 가 있는지 실측**하고, 있으면 「차원만 붙인다」가 사실은 잔량 행을 가르는 일임을 판정해야 한다. `inventory_transaction_line.handling_unit_id` 는 실재한다.
2. ⭐ **`repack-events` 를 무엇으로 채우나** — `plan-uiux.md:61` U27 은 **새 표 `handling_unit_repack_event(+line)`** 를 적었고, `plan.md` §0 **#9 판정**은 「**기존 표 재사용**(`handling_unit_reconfiguration`) 우선 · 기존 표로 안 되면 **3관점 재수립 조건**」이다. `plan-integration.md:347` 은 「재구성 이력은 `handling_unit_reconfiguration`(+`_line`)에 적는다 — 표가 이미 있다」로 기존 표를 지목했다. ⇒ **계약 `HandlingUnitRepackEvent`(8724)·`HandlingUnitRepackEventLine`(8770) 의 칸 전수 ↔ `handling_unit_reconfiguration`(`schema.prisma:3981`)·`_line`(`:4000`) 칸 전수를 대조**해 「담기나」를 판정한다. 못 담는 칸이 있으면 마이그(추가·nullable)로 해결되는지, 표 신설이어야 하는지 §2 절차로 가른다. **이 판정이 이 슬라이스의 심장이다.**
3. **`:pack` 이 무엇을 바꾸나** — `handling_unit.status_code` 는 NOT NULL 인데 계약이 값 목록을 주는지, `x-no-code-key` 인지 실측한다. `plan-api.md` S07 의 설계 미정 초안은 「취급단위 `status_code` 가 NOT NULL 인데 계약이 「칸 불필요」로 닫았다(`x-no-code-key`) → §2 2단계 기준 4 → **고정 상수 하나**를 쓰고 이름을 붙여 남긴다」다. 확인·재판정한다.
4. **구성 치환(`PUT …/contents`)이 잔량을 건드리나** — `handling_unit_content` 는 `uq_handling_unit_content(handling_unit_id, item_id, lot_id)` 를 갖는다. 치환이 재고를 옮기는 것인지, 「무엇이 담겼는지」의 기록일 뿐인지 계약 문장으로 판정한다(기준 1).
5. **같은 레인 I-13 과의 접점** — I-13 이 마이그 **A4** 로 `logistics.stock_transfer_line.handling_unit_id?` 를 세우고, **I-13 재수립 R-15** 가 「그 칸의 첫 채움처는 `M-01-10` 파렛트 단위이고 **I-16 은 `handling_unit` 을 «만드는» 쪽**」으로 판정했다. §13 인계에 반드시 적는다.

---

## 읽을 것 (순서대로)

1. **`docs/coverage-100/README.md`** — §0 범위 · §1-2 절차 · **§2 판정 절차(0~3단계)** · §3 멈춤 조건 · §5 제약 · §6·§6-1(예산 350 / 한도 400 / 코어 ≤200 / **실측 부록** 의무).
2. **`docs/coverage-100/lane-C.md`** · **`lanes.md`**(§1-2 마이그 이름 · §1-4 소유 파일 — `transitions.ts` 는 **A 소유** · §4 절대 금지).
3. **`CLAUDE.md`** — `business_date` 는 클라이언트가 보낸다(C-8) · PR 크기 · 주석 · 마이그 하위 호환.
4. **`docs/coverage-100/plan.md`** — **§0 #9**(새 표 3 판정 — ⭐ 위 갈림길 2) · §1 **61행**(I-16 · 선행 I-12 · 마이그 「—」 · PR 3 · ∥ I-33) · §4(**I-16 행이 없다**) · **§5 횡단 1~12 전건** · §6(I-16 건너뜀 0건).
5. **`docs/coverage-100/plan-api.md`** — **S07**(184~218행 — 쓰는 표에 `handling_unit(_content)`·`handling_unit_reconfiguration(_line)` 포함 · 마이그 「없음(실측)」 · **설계 미정 초안 = 취급단위 `status_code`** · PR 5 중 ⑤ 가 취급단위 · 4축 표) · §5.2 표 A·B·C · §5.3·§5.4 · 권한 미등록 목록.
6. **`docs/coverage-100/plan-uiux.md`** — **61행 U27**(7건 · 화면 **P-02-08 · M-04-03 · P-04-01 · P-04-04 · P-01-02** · 선행 U25 · ⭐ 마이그 칸에 **`handling_unit_repack_event(+line)` 신설**이 적혀 있다 · PR 3) · **389~397행**(오퍼레이션↔화면·헤더 매핑 — ⚠ 「ETag」는 계약 `responses.*.headers` 실측이 이긴다 · **`POST`·`PUT`·`:pack` 셋 다 「사번」**) · §9 판정표에서 U27 관련 자리.
7. **`docs/coverage-100/plan-integration.md`** — **180행**(I-16 행 — 마이그 ✕ · **원장 ⚠ 미정** · 상태기계 ⭕ · PR 3) · **345~349행 §3-1 I-16**(체인 마디 — **I-22 `shipment_lot_allocation` 에 연결** · 원장 판정 · 재구성 이력 표) · §10 부록 I-16 전건 7.
8. **선행 결과물** — **`slices/I-12.md`**(선행 슬라이스 · 적치 · 원장 판정의 모양) · **`slices/I-13.md`**(같은 레인 · ⭐ **§0-재수립 R-15**(`handling_unit_id` 첫 채움처) · R-6/R-9(`IN_TRANSIT` 와 잔량 차원) · 형식) · **`slices/I-14.md`**(같은 레인 · §0-재수립 **R-2**(잠금 7칸 ↔ 잔액 차원 11칸) · 형식) · `slices/I-24.md`(형식 · §12 마감표 · 실측 부록) · `slices/I-8.md`(예약 코어 — `PostingLine.handlingUnitId` 를 안 쓰기로 한 자리).
9. **실재 코드** — `src/inventory/`(`inventory.module.ts` · `balance/` · `transaction/` · ⚠ **같은 레인 I-14 가 `src/inventory/adjustment/` 를 새로 만들고 있다 — 파일이 겹치지 않게 `src/inventory/handling-unit/` 로 선다**) · `src/core/inventory-posting/`(`inventory-posting.service.ts` 머리 주석 22~44 · `posting.types.ts` 의 **`PostingLine.handlingUnitId`** — 오늘 채우는 사용처가 있는지 실측) · `src/core/numbering/numbering.service.ts` + `prisma/seed.ts`(취급 단위·재구성 채번 규칙 실재 여부) · `src/core/document-state/transitions.ts`(`handling_unit.status_code` 축이 필요한지 실측 — ⚠ **A 소유 파일**이고 같은 레인 I-13·I-14 도 만진다) · `src/common/permissions/`(403 셋의 등록 위치) · `src/common/errors/error-codes.ts`(**새 코드 금지**) · 기존 CRUD 복제 원본으로 `src/logistics/goods-issue/`·`src/logistics/putaway/`.
10. **물리** `prisma/schema.prisma` — **`handling_unit` 414~**(13칸 · `parent_handling_unit_id?` **자기참조** · `warehouse_id?`·`location_id?` **둘 다 nullable** · `status_code` NOT NULL · `version_no`) · **`handling_unit_content` 443~**(`uq_handling_unit_content(handling_unit_id,item_id,lot_id)` · `lot_id` **NOT NULL** · CHECK 있음 — baseline 원문 실측) · **`handling_unit_reconfiguration` 3981~**(`reconfiguration_no` UNIQUE · `reconfiguration_type_code` · `source/target_handling_unit_id` **둘 다 NOT NULL** · `reason_code` NOT NULL · `performed_at`·`performed_by?`) · **`_line` 4000~**(`uq_…_line` · `moved_qty` · `lot_id` NOT NULL) · `inventory_balance` 484~(⭐ **차원에 `handling_unit_id` 가 있는지**) · `inventory_transaction_line` 639~(`handling_unit_id` 실재) · `shipment_lot_allocation`(I-22 접점).
11. **시드** `prisma/seed.ts` — `HANDLING_UNIT_TYPE` **650** · 취급 단위 `status_code` 값 그룹이 **있는지**(⭐ 없으면 값을 짓지 않는다 — §2 로 판정) · `RECONFIGURATION_TYPE`·`RECONFIGURATION_REASON` 그룹 실재 여부 · 채번 규칙.
12. **계약** `contracts/logistics-01자재창고.json` — path **1200·1361·1412·1525·1568** · 스키마 **`HandlingUnit` 8482** · `HandlingUnitContent` **8551** · `HandlingUnitContentListResponse` **8602** · `HandlingUnitContentUpsert` **8616** · `HandlingUnitCreate` **8653** · `HandlingUnitDetailResponse` **8706** · **`HandlingUnitRepackEvent` 8724** · **`HandlingUnitRepackEventLine` 8770** · `HandlingUnitPack` **8818**. `parameters` 전수 · `requestBody` 칸 전수 · `responses` 코드·`headers`(ETag) · `x-code-key`·`x-no-code-key` · **`x-internal-note` 원문 전건**(⭐ 「데이터 모델 담당에게 통지」 문장이 **낡았는지** 실측으로 확인해 인용).
13. **화면 사본**(읽기 전용 · 메인 체크아웃 `/Users/hj.cho/A-Crefle/A-Project/OmfMes/omf-mes-server/.design-reference/omf-mes/design/wiki/screens/`) — `02/P-02-08-포장작업.md` · `04/M-04-03-포장재구성스캔.md` · `04/P-04-01-Packing실적등록.md` · `04/P-04-04-재구성신규라벨발행.md` · `01/P-01-02-출고QR발행.md`(⭐ 화면 ID 가 정본, 파일 이름은 실제 파일이 이긴다). 참고 `01/M-01-10-재고이동불량반출.md` §5-2(파렛트 단위 — I-13 R-15).
14. **기존 문의** `docs/design-inquiries/README.md` 전건 훑기(001~062 실재 · 063~068 I-24 예약 · **120~125 I-13 · 130~135 I-14 가 이번 회차에 예약**). 새 번호는 **140 부터**.

---

## 담을 것 (I-24.md 의 절 짜임 · §0~§13 + 실측 부록)

1. **머리말 블록** — 브리프 경로 · 통합 계획서 해당 절 줄번호 · 실측 기준(worktree·base 커밋·계약 `COMMIT.txt`=`a6a87e1`·실측일·DB 행수) · 커버리지 +7 · 「§0-재수립이 본문보다 앞선다」.
2. **§0. README §1-2 3조건 판정** + ⭐ **「리뷰가 반드시 볼 자리 5개」**. ⭐ 위 갈림길 2(`repack-events` 의 표)는 `plan.md` §0 #9 가 **명시적으로 재수립 조건에 걸어 둔 자리**이므로 판정을 분명히 적는다.
3. **§1. 계약 읽기 표 — 7건 전건** — 횡단 4축(멱등·If-Match·ETag·403·**`X-Worker-No`**) 실측 · 조회 4건 질의 칸 전수 ↔ 물리 칸 · 쓰기 3건 본문 스키마 전수 · **채울 수 없는 칸 / 담을 데 없는 칸** · 값 목록(계약 ↔ 시드) · **에러 코드 새 코드 0건** 증명.
4. **§2. 물리 대조 + 마이그레이션 결론** — 네 표 전칸 대조 · ⭐ **`HandlingUnitRepackEvent(+Line)` ↔ `handling_unit_reconfiguration(+_line)` 칸 대조표**(이 슬라이스의 심장) · 결론이 마이그 0 이면 근거를, 필요하면 **SQL 전문 + 사전 대조 SELECT 주석 + 파일명 초까지** · CHECK 원문 · 두 릴리스 규칙 미해당.
5. **⭐ §3. `:pack`(포장 확정)** — 한 트랜잭션 순서 · `status_code` 값의 원천 · 재구성 이력 행을 만드나 · 원장을 부르나(기준 1 판정) · 멱등 · If-Match · 400/404/409 갈래와 **순서** · `X-Worker-No`(§5 규칙 9 — 담을 칸으로 가른다).
6. **§4. `POST /inventory/handling-units`(등록)** — 본문 칸 매핑 · 채번 · `parent_handling_unit_id` 순환 방지 · `warehouse_id`·`location_id` nullable 의 뜻 · `status_code` 초기값 · 400 갈래.
7. **§5. `PUT …/contents`(구성 치환)** — 전량 교체 의미 · `uq_handling_unit_content` 와 중복 400 · If-Match(부모 버전) · 재고를 옮기나(기준 1) · **재구성 이력을 남기나**(`M-04-03` 화면과 대조) · `version_no`.
8. **§6. 조회 4건** — where 전수 · 정렬 · `PageMeta` · 404 · 뷰 칸 매핑 · ETag 는 **상세만**(계약 실측) · 자식 컬렉션 GET 에 ETag 안 붙임 · `repack-events` 의 원천 표.
9. **§7. 상태기계** — `transitions.ts` 축·전이 필요 여부를 **실측 판정**. ⚠ 필요하면 **A 소유 파일 + 같은 레인 I-13·I-14 와 같은 두 줄에서 충돌**(I-13 R-10)을 §13 에 적는다.
10. **§8. 횡단 · 모듈 배치** — `src/inventory/handling-unit/` 신설(⚠ I-14 의 `src/inventory/adjustment/` 와 파일이 겹치지 않게 · `inventory.module.ts` 는 **같은 레인 안에서 순차 병합**) · 파일별 줄 수는 **기존 파일 실측**으로 · 다른 도메인 service 호출 0 · 권한 등록(단독 커밋) · 멱등/If-Match/ETag/403/사번 건수 · **새 error code 0**.
11. **§9. e2e** — 파일 이름(`test/inventory-handling-unit.e2e-spec.ts`) · **픽스처 복제 원본(`파일:줄`)** · 정리 역순 · **테스트 이름 목록 전건** · 단위 테스트 이름 목록.
12. **§10. 설계 미정 자리 — 전건 판정**(README §2) — 판정 요약표 + **문의 후보(제목만 · 번호 `140+n`)** + 「알려둘 것」.
13. **§11. PR 분할** — 초안 3. 각 PR 파일 목록 · **비테스트 예상 diff(기존 파일 «실측» 기준)** · 모델(조회 sonnet / 심장 opus) · 스택 순서 · 예산 350. ⭐ 조회 PR ① 을 3관점 리뷰와 나란히 스폰 가능한지 명시(README §6-1 ③).
14. **§12. 인계 + 통합 계획서 대조표** — ⭐ **I-13**(A4 `stock_transfer_line.handling_unit_id` 의 첫 채움처 · R-15) · **I-22**(`shipment_lot_allocation` 접점) · I-14(같은 모듈 파일) · I-26 시리얼. `plan.md`·`plan-api.md`·`plan-uiux.md`·`plan-integration.md` 에서 **고쳐야 할 줄**을 표로.
15. **⭐ 맨 끝 「실측 부록」** — 사실 + `파일:줄` 한 표.

---

## 금지

구현 코드 작성 · 계약 파일 수정 · 다른 문서 수정 · **값 지어내기** · `omf-mes`·`omf-mes-client` 저장소 쓰기 · `git` 쓰기 · **새 error code** · `transitions.ts` 직접 수정 · 문의 번호 140 미만 사용.

## 최종 응답 (5줄 이내)

README §1-2 3조건 판정 · 마이그 건수(⭐ `repack-events` 표 판정 포함) · 문의 신설 건수(제목) · PR 분할 최종안(건수·예산) · 멈춤 조건 해당 여부.
