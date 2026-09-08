# I-14 개별 계획안 3관점 재검토 브리프 (재수립은 **기본값** · README §1-2 2026-09-07 개정)

대상: `docs/coverage-100/slices/I-14.md`(854줄). 결과는 **자기 관점 파일 하나**에만 쓴다 —
`docs/coverage-100/slices/I-14-review-{api|uiux|integration}.md` (**130줄 이내**). 다른 파일 수정 금지, **구현 금지**, `git` 쓰기 금지.
작업 위치: `/Users/hj.cho/A-Crefle/A-Project/OmfMes/omf-mes-server/.claude/worktrees/i14-plan`(브랜치 `docs/coverage-100-c-i14-plan` · base `origin/main` 771c541).
DB 는 `psql` SELECT 만(`postgresql://omf:omf@localhost:55432/omf_mes`) · `contracts/*.json` 읽기 전용 · `prisma migrate *`·`db:seed`·`contracts:*` 금지.
화면 사본은 메인 체크아웃 `/Users/hj.cho/A-Crefle/A-Project/OmfMes/omf-mes-server/.design-reference/omf-mes/design/wiki/screens/` 아래(읽기 전용).

## ⭐ 재측정 금지 규칙 (README §6-1 ①)

계획안 맨 끝 **「실측 부록」**(§801행~)의 값은 **재측정하지 않는다.** 겹쳐 재는 것이 지난 회차 findings 의 절반이었다.
**단 네 판정이 그 값을 뒤집는다면 반드시 재측정한다.**
너의 몫은 **계획자가 «보지 않은» 자리**다 — 계약 문장, 화면 명세, 다른 슬라이스와의 어긋남, 기존 코드의 반례.

## 공통으로 읽을 것

- `docs/coverage-100/README.md` §1-2 · **§2 판정 절차(0~3단계)** · §3 멈춤 조건 · §5 제약 · §6·§6-1
- `docs/coverage-100/lane-C.md` · `lanes.md` §1-4(소유 파일 — **`transitions.ts` 는 A 소유**) · `CLAUDE.md`
- `docs/coverage-100/plan.md` §0 · §1(59행) · §4(**I-14 행이 없다** · 141행 표 B) · **§5 횡단 1~12** · §6
- **`docs/coverage-100/slices/I-14.md` 전문**
- 계약 원문 `contracts/logistics-01자재창고.json` — path 30·193·244·364·444 · 스키마 `InventoryAdjustment*`(9733·9810·9853·9871·9951·9965)
- 자기 관점 계획서:
  - **api** → `plan-api.md` S07(184~218행) · 742~755행(D 표 A) · 967행(권한 미등록) · §5.3·§5.4
  - **uiux** → `plan-uiux.md` U17(51·273~283행) · 623·834·1146행 · §9-3 · 화면 **`01/W-01-12-재고조정.md`** 전문(+ `W-01-04-재고실사.md` · `W-01-13-물류문서진행현황취소.md`)
  - **integration** → `plan-integration.md` 178·292·330~336·338~342·665·833~841행 · 선행 `slices/I-4.md`·`I-1.md`·`I-5.md`·`I-12.md`

## 판정할 것 — 계획안 §0-1 의 **「반드시 볼 자리 5개」가 그대로 판정 항목이다**

각 항목에 **✅ 동의 / ✏ 수정(대안 + 근거 `파일:줄`) / ⛔ 반대(근거 `파일:줄`)** 를 붙인다.

1. **① 라인의 `quality_status_code`·`inventory_status_code`(+`ownershipTypeCode`)를 «등록·치환 시점»에 잔액 행에서 읽어 라인에 저장하고, `:post` 는 저장값을 그대로 싣는다. 0행 400 · 2행+ 400.**
   (§2-2 · §3-3 · §5-4 · 문의 130) — 「전기 시점 재조회」로 뒤집히나? 「NOT NULL 완화」로 뒤집히면 마이그가 2건이 된다.
   ⭐ **증(+) 라인은 되읽을 잔액 행이 아예 없을 수 있다** — 그 경우의 판정이 성립하는지 각 관점에서 본다.
2. **② 마이그 1건 — `inventory_adjustment_line.inventory_count_line_id BigInt?` + FK + 인덱스**(§2-4).
   계약 두 스키마가 그 칸을 정의한 것이 맞는지, 「계약 칸을 버린다」가 더 싼지(README §2 2단계 기준 3). 뒤집히면 §0 ①·PR ② 선행 커밋·I-15 인계가 사라진다.
3. **③ 부호 → `from`/`to` 가름 + 음수재고 3갈래 손검사가 `item.negative_stock_allowed` 를 «본다»**(§3-2 · §3-4).
   ⚠ I-4 출고는 그 칸을 **무시**했다(`issue-posting.ts:155`). **같은 저장소에서 두 오퍼레이션이 갈리는 것**이 옳은가 — 계약 문구와 화면 `W-01-12` §6 을 실제로 열어 대조한다.
4. **④ 원장 헤더 `plant_id` 를 라인 위치에서 역산 · 두 공장에 걸치면 400 `INVALID`**(§3-5 · 문의 133).
   「첫 라인의 공장」·「헤더에 칸 추가」와 비교. 화면이 여러 공장을 한 전표에 담을 수 있게 그렸는지 확인.
5. **⑤ PR 4 분할**(통합 계획서 셋은 **3** · U17 은 **2**) **+ `transitions.ts` 키 신설이 A 소유 파일**(§8 · §12).
   예산 근거(형제 `goods-issue` 7파일 실측 1,652줄)가 자기 관점에서 성립하는가. 조회 PR ① 을 리뷰와 나란히 스폰해도 되는가(README §6-1 ③).

추가로 **반드시** 본다:

6. **문의 6건(130~135)이 정말 새 물음인가** — `docs/design-inquiries/` 전건(001~062) · `docs/계약-되돌림-mdm.md` · `README.md` §0 대기 15건과 대조해 **「기존」이면 그렇게 판정**한다. 각 건의 §2 절차 판정(가장자리/본길 · 2단계 기준 번호)에 동의하는가.
   ⭐ 특히 **132**(조정에 취소·역분개 경로가 계약에 0건 — `I-5.md` 790~796행의 「I-14 = `reverse()` 둘째 사용처」가 뒤집힌다)는 근거를 직접 재확인한다.
7. **에러 코드 새 코드 0건**(§1-6)이 실제로 성립하는가 — `src/common/errors/error-codes.ts` 실측.
8. **e2e 35 · 단위 9 테스트 이름 목록**(§10-4·10-5)에서 **빠진 갈래**. 계획자가 「일어날 수 없다」로 접은 자리를 실측으로 뒤집을 수 있으면 지적한다.
9. 자기 관점 계획서와 `I-14.md` 가 어긋나는 자리 중 **구현에 영향 주는 것만**(취향 차이 제외).

## 관점별로 특히 볼 것

- **api** — 계약 문장·스키마·에러 봉투·`x-internal-note` 원문 · 횡단 4축(멱등·If-Match·ETag·403)이 계약 `responses.*.headers` 실측과 맞는가 · `derived-permissions.ts` / `manual-permissions.ts` 등록 건수 · 409 봉투 유형 · 상태·값 목록의 계약 근거.
- **uiux** — 화면 `W-01-12` 를 **실제로 열어** 버튼·열·예외 목록과 대조 · 화면이 요구하는데 계획안에 없는 것 · 계획안이 만드는데 화면에 없는 것 · 「실사 결과에서 불러오기」가 무엇을 부르는가(I-15 인계) · 목록 필터·정렬·집계 열.
- **integration** — 원장·체인·다른 슬라이스와의 어긋남 · 잠금·트랜잭션 경계·멱등 · `transitions.ts`/`entity_type_registry`/채번 등 **공용 자원 충돌** · I-4/I-5/I-1/I-15 와의 규약 정합 · baseline 마이그의 트리거·CHECK 원문.

## 금지

구현 · 계약/다른 문서 수정 · `git` 쓰기 · 실측 부록 재측정(위 예외 제외) · 130줄 초과.

## 마지막 5줄 요약

「재수립 결과 — `I-14.md` 에 반영할 수정 N건(목록) · `plan*.md` 에 반영할 것 · 문의 최종 건수 · ⛔ 반대 건수 · 멈춤 조건 해당 여부」.
