# I-13 개별 계획안 3관점 재검토 브리프 (재수립은 **기본값** · README §1-2 2026-09-07 개정)

대상: `docs/coverage-100/slices/I-13.md`(1080줄). 결과는 **자기 관점 파일 하나**에만 쓴다 —
`docs/coverage-100/slices/I-13-review-{api|uiux|integration}.md` (**130줄 이내**). 다른 파일 수정 금지, **구현 금지**, `git` 쓰기 금지.
작업 위치: `/Users/hj.cho/A-Crefle/A-Project/OmfMes/omf-mes-server/.claude/worktrees/i13-plan`(브랜치 `docs/coverage-100-c-i13-plan` · base `origin/main` 771c541).
DB 는 `psql` SELECT 만(`postgresql://omf:omf@localhost:55432/omf_mes`) · `contracts/*.json` 읽기 전용 · `prisma migrate *`·`db:seed`·`contracts:*` 금지.
화면 사본은 메인 체크아웃 `/Users/hj.cho/A-Crefle/A-Project/OmfMes/omf-mes-server/.design-reference/omf-mes/design/wiki/screens/` 아래(읽기 전용).

## ⭐ 재측정 금지 규칙 (README §6-1 ①)

계획안 맨 끝 **「실측 부록」**의 값은 **재측정하지 않는다.** 겹쳐 재는 것이 지난 회차 findings 의 절반이었다.
**단 네 판정이 그 값을 뒤집는다면 반드시 재측정한다.**
너의 몫은 **계획자가 «보지 않은» 자리**다 — 계약 문장, 화면 명세, 다른 슬라이스와의 어긋남, 기존 코드의 반례.

## 공통으로 읽을 것

- `docs/coverage-100/README.md` §1-2 · **§2 판정 절차(0~3단계)** · §3 멈춤 조건 · §5 제약 · §6·§6-1
- `docs/coverage-100/lane-C.md` · `lanes.md` §1-4(소유 파일 — **`transitions.ts` 는 A 소유**) · `CLAUDE.md`
- `docs/coverage-100/plan.md` §1(58행) · **§4 130행 A4** · **§5 횡단 1~12** · §6 · §7(215행)
- **`docs/coverage-100/slices/I-13.md` 전문**
- 계약 원문 `contracts/logistics-01자재창고.json` — path **5337·5532·5583·5693** · 스키마 `StockTransfer`(13973)·`Arrive`(14083)·`Create`(14141)·`DetailResponse`(14219)·`Line`(14237)·`LineListResponse`(14333)·`LineUpsert`(14347)
- 자기 관점 계획서:
  - **api** → `plan-api.md` S05(143~163행) · 745~755행(전이표) · 966행(권한) · 1091행(채번) · §5.3·§5.4
  - **uiux** → `plan-uiux.md` U14(48·245~254행) · **581행** · 695·738·1145·**1174행** · 화면 **`01/M-01-10-재고이동불량반출.md`** 전문(+ `04/` 의 `W-04-11` 해당 파일 · 없으면 「없다」)
  - **integration** → `plan-integration.md` 177·301·320~327·588·823~830행 · 선행 `slices/I-12.md`(문의 059)·`I-5.md`·`I-4.md`·`I-9.md`

## 판정할 것 — 계획안 §0-1 의 **「반드시 볼 자리 5」가 그대로 판정 항목이다**

각 항목에 **✅ 동의 / ✏ 수정(대안 + 근거 `파일:줄`) / ⛔ 반대(근거 `파일:줄`)** 를 붙인다.

1. **① 창고 간 제한을 서버가 400 `INVALID`(field `toWarehouseId`)로 막는다.**
   ⭐ 물리 CHECK `ck_stock_transfer_warehouses` 가 **2026-08-26 에 DROP 됐고** 라인 CHECK 로 바뀌었다는 실측을 전제로 한 판정이다. 계약 `description`·x-internal-note·화면 `M-01-10` §8 과 대조한다. 뒤집히면 PR ② 의 검증 그물과 e2e 17 이 바뀐다.
2. **② 도착이 재고 상태를 «반출 라인의 `from_inventory_status_code` 로 되돌린다»**(§3-5).
   ⚠ `plan-integration.md:324` 초안은 `AVAILABLE` 고정이다. 적치·출고 선례(`putaway-posting.ts:52-53`·`issue-posting.ts:196-198`)가 근거로 옳은지, 「보류 재고가 이동만으로 가용이 된다」는 위험이 실재하는지 각 관점에서 본다.
3. **③ `:arrive` 는 한 번만 받는다(재도착 400 `STATE_LOCKED`).**
   ⚠ `plan-api.md:752` 전이표는 「부분 도착은 `received_qty` **합**이 담는다」로 **누적**을 전제한다. 계약·화면이 되풀이 도착을 요구하는지 실제로 확인한다. 뒤집히면 PR ③ 이 +60줄로 예산을 넘는다.
4. **④ `PUT …/lines` 는 «자물쇠까지만» 구현한다**(오늘 도달 불가 · 언제나 400 `STATE_LOCKED`).
   계약 `StockTransferCreate.description`(생성=반출 한 오퍼레이션)과 `StockTransferLineUpsert.description` 이 정말 그렇게 읽히는지, 「치환 본체를 안 짓는다」가 CLAUDE.md 와 맞는지 판정한다.
5. **⑤ 적치와 `STOCK_TRANSFER` 판별자를 공유해 문서진행 조회가 남의 원장을 집는 것을 이 슬라이스가 고친다**(`document-progress-query.service.ts:226-227` 에 `transaction_no` startsWith 조건 ≈6줄 · PR ④).
   `I-12.md` §11 ①·문의 059 와의 정합. 「미룬다」·「9유형 전건에 축을 더한다」와 비교.

추가로 **반드시** 본다:

6. **문의 6건(120~125)이 정말 새 물음인가** — `docs/design-inquiries/`(001~062) · `docs/계약-되돌림-mdm.md` · README §0 대기 15건과 대조. 각 건의 §2 절차 판정(가장자리/본길 · 2단계 기준 번호)에 동의하는가. ⭐ 특히 **121**(물리 CHECK 가 이미 완화됐는데 계약·화면이 옛 전제)과 **124**(부분 도착 잔여가 `IN_TRANSIT` 에 영구 잔류)를 직접 재확인한다.
7. **에러 코드 새 코드 0건**이 성립하는가 — `src/common/errors/error-codes.ts` 실측.
8. **e2e 39 · 단위 5 테스트 이름 목록**에서 **빠진 갈래**. 계획자가 「일어날 수 없다」로 접은 자리를 실측으로 뒤집을 수 있으면 지적한다.
9. **PR 4 분할**(통합 계획서 셋은 3 · U14 는 2)의 예산 근거가 자기 관점에서 성립하는가. 조회 PR ① 을 리뷰와 나란히 스폰해도 되는가(README §6-1 ③).
10. 자기 관점 계획서와 `I-13.md` 가 어긋나는 자리 중 **구현에 영향 주는 것만**(취향 차이 제외).

## 관점별로 특히 볼 것

- **api** — 계약 문장·스키마·`x-internal-note` 원문 · 횡단 4축이 `responses.*.headers` 실측과 맞는가 · 409 봉투 유형(`ConflictResponse` — `code` 칸 없음) · `X-Worker-No` required 판정 · 404 미선언 자리의 처리 · 권한 등록 건수 · 채번 형식 미정(`plan-api.md:1091`).
- **uiux** — 화면 `M-01-10` 을 **실제로 열어** 버튼·열·예외·§8 물러남과 대조 · 「불량 반출 사유」를 넣을 길이 없다는 지적(문의 122)이 화면과 맞는가 · `W-04-11` 화면의 실재 여부 · 세 슬라이스에 걸쳐 반쯤 열리는 문제(`plan-uiux.md:695`).
- **integration** — 원장 2단 전기의 트랜잭션 경계·잠금·멱등 · `IN_TRANSIT` 차원 축과 `location_id` NOT NULL · `issue/receipt_transaction_line_id` 되짝짓기 · `transitions.ts`·판별자·채번 등 **공용 자원 충돌**(⭐ 같은 레인 I-14 도 같은 날 `transitions.ts` 를 만진다) · I-12/I-5/I-4/I-9 와의 규약 정합 · baseline 마이그의 트리거·CHECK 원문.

## 금지

구현 · 계약/다른 문서 수정 · `git` 쓰기 · 실측 부록 재측정(위 예외 제외) · 130줄 초과.

## 마지막 5줄 요약

「재수립 결과 — `I-13.md` 에 반영할 수정 N건(목록) · `plan*.md` 에 반영할 것 · 문의 최종 건수 · ⛔ 반대 건수 · 멈춤 조건 해당 여부」.
