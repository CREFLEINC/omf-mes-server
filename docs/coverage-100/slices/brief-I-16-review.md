# I-16 개별 계획안 3관점 재검토 브리프 (재수립은 **기본값** · README §1-2 2026-09-07 개정)

대상: `docs/coverage-100/slices/I-16.md`(934줄). 결과는 **자기 관점 파일 하나**에만 쓴다 —
`docs/coverage-100/slices/I-16-review-{api|uiux|integration}.md` (**130줄 이내**). 다른 파일 수정 금지, **구현 금지**, `git` 쓰기 금지.
작업 위치: `/Users/hj.cho/A-Crefle/A-Project/OmfMes/omf-mes-server/.claude/worktrees/i16-plan`(브랜치 `docs/coverage-100-c-i16-plan` · base `origin/main` 771c541).
DB 는 `psql` SELECT 만(`postgresql://omf:omf@localhost:55432/omf_mes`) · `contracts/*.json` 읽기 전용 · `prisma migrate *`·`db:seed`·`contracts:*` 금지.
화면 사본은 메인 체크아웃 `/Users/hj.cho/A-Crefle/A-Project/OmfMes/omf-mes-server/.design-reference/omf-mes/design/wiki/screens/` 아래(읽기 전용).
⚠ 같은 레인의 `I-13.md`·`I-14.md` 는 이 worktree 에 **없다** — 각각 `.claude/worktrees/i13-plan/`·`i14-plan/` 안의 같은 경로에 있다.

## ⭐ 재측정 금지 규칙 (README §6-1 ①)

계획안 맨 끝 **「실측 부록」**의 값은 **재측정하지 않는다.** 겹쳐 재는 것이 지난 회차 findings 의 절반이었다.
**단 네 판정이 그 값을 뒤집는다면 반드시 재측정한다.**
너의 몫은 **계획자가 «보지 않은» 자리**다 — 계약 문장, 화면 명세, 다른 슬라이스와의 어긋남, 기존 코드의 반례.

## 공통으로 읽을 것

- `docs/coverage-100/README.md` §1-2 · **§2 판정 절차(0~3단계)** · §3 멈춤 조건 · §5 제약 · §6·§6-1
- `docs/coverage-100/lane-C.md` · `lanes.md` §1-4(소유 파일 · **공용 등록부 규칙**) · `CLAUDE.md`
- `docs/coverage-100/plan.md` **§0 #9**(새 표 3 판정 — 이 슬라이스의 심장) · **§0 #10** · §1 61행 · §4(**I-16 행이 없다**) · **§5 횡단 1~12**(특히 **9 `X-Worker-No`**) · §6
- **`docs/coverage-100/slices/I-16.md` 전문**
- 계약 원문 `contracts/logistics-01자재창고.json` — path **1200·1361·1412·1525·1568** · 스키마 `HandlingUnit`(8482)·`Content`(8551)·`ContentUpsert`(8616)·`Create`(8653)·**`RepackEvent`(8724)**·**`RepackEventLine`(8770)**·`Pack`(8818)
- 자기 관점 계획서:
  - **api** → `plan-api.md` S07(184~218행) · 725행 · 967행 · 1045행 · 1098~1099행 · §5.2 표 A·B·C · §5.3·§5.4
  - **uiux** → `plan-uiux.md` U27(61·389~399행) · **592행** · 화면 전문 `02/P-02-08-포장작업.md` · `04/M-04-03-포장재구성스캔.md` · `04/P-04-01-Packing실적등록.md` · `04/P-04-04-재구성신규라벨발행.md` · `01/P-01-02-출고QR발행.md`
  - **integration** → `plan-integration.md` 129·180·345~349·521·590·854~862행 · 선행 `slices/I-12.md` · `../../../i13-plan/…/I-13.md` · `../../../i14-plan/…/I-14.md`

## 판정할 것 — 계획안 §0-2 의 **「반드시 볼 자리 5」가 그대로 판정 항목이다**

각 항목에 **✅ 동의 / ✏ 수정(대안 + 근거 `파일:줄`) / ⛔ 반대(근거 `파일:줄`)** 를 붙인다.

1. ⭐ **① `HandlingUnitRepackEvent(+Line)` 는 기존 `handling_unit_reconfiguration(+_line)` 에 못 담는다 → 표 2 신설**(§2-3).
   근거 셋을 각자 검증한다 — 라인 필수 6칸 중 **4칸 결손** · 헤더 NOT NULL 3칸이 계약에 원천 0 · **`ck_handling_unit_reconfiguration_distinct`(source ≠ target)가 대표 경로를 구조적으로 막는다**. ⛔ 뒤집히면 **마이그 PR ② 가 통째로 사라지고 PR 3 → 2** 다. `plan.md` §0 #9 가 이 자리를 명시적으로 재수립 조건에 걸어 두었다.
2. ⭐ **② `handling_unit.status_code` 상수가 «둘»**(`OPEN`·`PACKED`) — `plan-api.md:194` 의 「고정 상수 **하나**」와 `plan.md` §0 #10 의 nullable 을 둘 다 뒤집는 판정이다. 계약 `:pack` 의 「이미 확정된 포장은 409」와 `HandlingUnit.required` 를 직접 확인한다.
3. **③ `PUT …/contents` 가 재포장 이벤트를 «언제나» 만든다**(최초 채움도 `qtyBefore=0`). 계약 description 과 `app.qty_t` CHECK 를 확인한다.
4. **④ `X-Worker-No` 없으면 셋 다 400 `REQUIRED`** — `plan.md` §5 규칙 9 의 **예외 축**(POP 단말만 부르는 자리)에 걸리는가. 소유 화면에 관리웹 `W-` 가 정말 0건인가.
5. **⑤ PR 분할 4**(통합 계획서 셋은 전부 3) — 예산 근거가 자기 관점에서 성립하는가. 조회 PR ① 을 리뷰와 나란히 스폰해도 되는가(README §6-1 ③).

추가로 **반드시** 본다:

6. **문의 5건(140~144)이 정말 새 물음인가** — `docs/design-inquiries/`(001~062) · `계약-되돌림-mdm.md` · README §0 대기 15건 · **같은 회차의 120~125(I-13)·130~135(I-14)** 와 대조. 각 건의 §2 절차 판정에 동의하는가.
7. **에러 코드 새 코드 0건** — `src/common/errors/error-codes.ts` 실측.
8. **e2e·단위 테스트 이름 목록에서 빠진 갈래.** 계획자가 「일어날 수 없다」로 접은 자리를 실측으로 뒤집을 수 있으면 지적한다. ⭐ 신설 표를 **지나는** 테스트가 있는지 반드시 본다(I-13 재수립 R-15 가 같은 종류의 공백을 잡았다 — 마이그가 만든 칸을 테스트가 한 번도 통과하지 않는 문제).
9. **부수 발견 2건의 사실 여부** — 계획안이 「알려둘 것」에 적은 `I-13.md:1071`(「`inventory_transaction_line.handling_unit_id` FK 없다」가 오기) · `I-12.md:26`(잔액 11칸 열거 오기). integration 이 확인한다.
10. 자기 관점 계획서와 `I-16.md` 가 어긋나는 자리 중 **구현에 영향 주는 것만**.

## 관점별로 특히 볼 것

- **api** — 계약 문장·스키마·`x-internal-note`·`x-no-code-key` 원문 · 횡단 4축이 `responses.*.headers` 실측과 맞는가 · 409/400 봉투와 코드 · 권한 등록 건수(⚠ `plan-api.md:967` 은 S07 미등록 4건이 **전부 실사·조정**이라 적었다 — 취급단위 셋은 어디에 있나) · 채번 형식.
- **uiux** — 화면 다섯을 **실제로 열어** 대조. 화면이 요구하는데 계획안에 없는 것 / 계획안이 만드는데 화면에 없는 것 · 버튼 활성 조건 · 목록 필터·열 · 예외 목록 · 화면이 물러난 자리(§8) · `plan-uiux.md:592` 의 U27 판정이 지금도 맞는가.
- **integration** — 원장을 안 지난다는 판정(잔액 차원 11칸에 `handling_unit_id` 없음)의 파급 · 트랜잭션 경계·잠금·멱등 · 신설 표의 FK·인덱스·CHECK 설계 · 공용 자원 충돌(⭐ **같은 레인 I-13·I-14 가 `inventory.module.ts`·`transitions.ts`·`DEFAULT_PREFIX` 를 같은 시기에 만진다**) · I-12/I-13/I-14/I-22 와의 규약 정합 · baseline 마이그의 트리거·CHECK 원문.

## 금지

구현 · 계약/다른 문서 수정 · `git` 쓰기 · 실측 부록 재측정(위 예외 제외) · 130줄 초과.

## 마지막 5줄 요약

「재수립 결과 — `I-16.md` 에 반영할 수정 N건(목록) · `plan*.md` 에 반영할 것 · 문의 최종 건수 · ⛔ 반대 건수 · 멈춤 조건 해당 여부」.
