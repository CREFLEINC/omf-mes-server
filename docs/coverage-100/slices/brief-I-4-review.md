# I-4 개별 계획안 3관점 재검토 브리프 (README §1-2 「설계 문의가 새로 생김」 조건 발동 — 030·031)

대상: `docs/coverage-100/slices/I-4.md`(894줄). 결과는 **자기 관점 파일 하나**에만 쓴다 —
`docs/coverage-100/slices/I-4-review-{api|uiux|integration}.md` (150줄 이내). 다른 파일 수정 금지, 구현 금지,
체크아웃 변경 금지(현재 브랜치 `docs/coverage-100-i4-plan` 그대로), `git` 쓰기 금지. 계약 `contracts/*.json` 은 읽기 전용(`jq`).
로컬 DB 는 읽기만(`psql` SELECT · `migrate reset`·`migrate diff --shadow-database-url` 절대 금지).

계획자 결론 요지: **「차이가 크다」 ⭕ — 조건 ③(문의 030·031 신설)**. 통합 계획서와 크게 어긋난 셋 —
ⓐ M-c(`goods_issue.destination_*` nullable 화)가 **이미 적용**돼(`20260901090000` · #44) 이 슬라이스 마이그 0 · `plan.md` §4·`plan-integration.md` §6-3 이 낡음
ⓑ LOT 상태 차단 잠정 판정(`status_code ∈ {DEFECTIVE,SCRAPPED,INSPECTION_PENDING}` 400)을 **뒤집어** `mdm.judgment_type_control.blocks_issue` 를 읽는다(오늘은 `JUDGMENT_TYPE` 0개라 아무것도 안 막음)
ⓒ `plan-api.md` S04 「결재선 존재 = 승인 필수」 초안을 **기각**하고 「그 전표에 `GOODS_ISSUE_DISPOSAL` 승인 요청이 있으면 승인 전표」(상신 흔적)로 가른다.

## 공통으로 읽을 것
- `docs/coverage-100/README.md` §1-2·§2·§5 · `docs/coverage-100/plan.md` §0 #5·#12 · §1 5행 · §3 · §4 M-c · §5 #9 · §7
- `docs/coverage-100/slices/I-4.md` 전문 · 선행 `I-3.md` §0-재수립(R-12 ⓓ 인계) · `I-2.md` R-9·R-11
- 계약 원문 `contracts/logistics-01자재창고.json` 의 `/logistics/goods-issues*` 7건(목록·등록·상세·라인 목록·라인 치환·`:post`·`:request-approval`) + `GoodsIssue*`·`GoodsIssueLineUpsert` 스키마 · `x-internal-note`(`postImmediately`)
- 실재 코드: `src/core/inventory-posting/inventory-posting.service.ts`(`post`·`PostingInput`·머리 주석) · `src/core/approval/approval.service.ts`(`request`·`assertNoOpenRequest`·`selectRoute`) · `src/core/document-state/transitions.ts`(축 5개) · `src/logistics/goods-receipt/`(`receipt-posting.ts` — 전기 함수 선례) · `src/logistics/inbound-receipt/inbound-receipt.service.ts`(`createWithin`·잠금 순서) · `prisma/schema.prisma` `goods_issue`(736~)·`goods_issue_line`(774~)·`inventory_balance`·`judgment_type_control` · `prisma/seed` 의 `GOODS_ISSUE_REASON`·`LOGISTICS_DOCUMENT_STATUS`·`JUDGMENT_TYPE`
- 기존 문의 `docs/design-inquiries/016~029`(특히 022 결재선 사업부 · 023 P/O 상태 축 · 026 입하 상태 축) · `docs/계약-되돌림-mdm.md`
- 자기 관점 계획서: api → `plan-api.md` S04(111~141행)·§5.1 A 표(744~760)·1090행 / uiux → `plan-uiux.md` U12(225~235)·46·580행 · 화면 명세(설계 저장소 사본 `/Users/rangkim/projects/crefle/omf/apps/omf-mes/design/wiki/screens/` 의 `W-01-05`·`W-01-06`·`M-01-08`·`M-01-09`·`P-01-02`·`W-04-10`, 읽기 전용) / integration → `plan-integration.md` §3-1 I-4(234~242행)·399~400행(I-23 데이터 모양 재사용)·598행·§6-3·I-20 절

## 판정할 것 (각 항목에 ✅ 동의 / ✏ 수정(대안+근거) / ⛔ 반대(근거))
1. **문의 030·031 이 정말 새 문의인가**(§8-2) — 030(폐기 출고 승인 게이트 축 없음 · 갈래 ①~④ · `postImmediately=true` 로 승인을 건너뛰는 구멍)이 022·023 과 겹치지 않나. 031(출고 라인 잔액 차원 두 칸 없음)이 문의감인가, 아니면 §3-2 되읽기로 끝나는가. 「알려둘 것」 9건(§8-3) 중 문의로 올려야 할 것이 있나.
2. **마이그레이션 0**(§2-3) — M-c 이미 적용 실측에 동의하나. `plan.md` §1 5행·§4 M-c·§3 코어표(`assertApproved` 행)·`plan-integration.md` §6-3 정정 목록(§10)이 빠짐없나. `goods_issue_spare_line` 을 범위 밖으로 둔 것(§2-4).
3. **`:post` 전기 모양**(§3) — `from` 을 `(le,bu,plant,warehouse,location,item,lot)` 7칸으로 `inventory_balance` 를 잠그고 되읽어 품질·재고 상태를 얻는 것(1행 채택 · 0행 400 `NEGATIVE_BALANCE` · 2행+ 400 `INVALID`) · `to`=`from` · 음수 손검사를 도메인(`issue-posting.ts`)에서 `available_qty >= issue_qty` 로 하고 `negative_stock_allowed` 를 무시하는 것 · 이중 전기 세 겹(§3-8) · `postImmediately` 가 등록 tx 안에서 전기하고 `document-post` 전이를 안 부르는 것(§3-9) · `transitions.ts` 첫 줄 등록 + 재전기 400 `STATE_LOCKED`(§3-7). 데드락·경합·되돌림(I-5 취소)·오프라인 큐(C-8·C-9) 관점 구멍.
4. **승인 게이트**(§4) — `assertApproved(tx, targetTypeCode, targetId, approvalTypeCode)` 시그니처·다형 축(FK 없음) · 「상신 흔적 = 승인 전표」 규칙 · `PENDING` 400 `APPROVAL_IN_PROGRESS` · 022 권고안 ② 실측 불가(`mdm.item` 에 `business_unit_id` 없음) → 갈래 ④ 공통본 · 승인 대기 중 `PUT …/lines` 400 `APPROVAL_IN_PROGRESS`(023 과 갈리는 이유가 서는가). §2 판정 절차 2단계(뒤집는 비용)로 보아 잠정 판정이 되돌릴 수 있는가.
5. **LOT 차단 뒤집기**(§5) — `judgment_type_control.blocks_issue` 를 읽는 것 · 문자열 집합을 박지 않는 것 · `lot_hold` 무시 · M-01-08 보류 차단은 I-8 `blocks_picking` 으로 미루는 경계 · 오늘 아무것도 안 막는 상태로 폐기·반품·피킹 화면이 성립하는가(uiux 실측).
6. **PR 5개 분할·순서·모델 배분**(§9) — plan 3 → 5 · ② 코어 ≤200 · ③ e2e 가 전표를 직접 INSERT 해 `:post` 를 먼저 세우는 순서 · 각 PR 의 **단위 테스트 이름 목록**이 e2e 로 못 가는 가드(`STATE_LOCKED`·404·409·`LINE_REQUIRED`·`APPROVAL_IN_PROGRESS`·`NEGATIVE_BALANCE`·2행+ `INVALID`)를 빠짐없이 덮는가. §7-1 「타입만 export」 인계가 아키텍처 §1 에 서는가.
7. 자기 관점 계획서와 I-4.md 가 어긋나는 자리 중 **구현에 영향 주는 것**만(취향 차이는 제외). §10 대조표의 자기 관점 행을 실측으로 확인. uiux 는 화면 명세(W-01-05 반품 `postImmediately` 값 · W-01-06/W-04-10 승인 흐름 · M-01-08 피킹 확정 · M-01-09 라인 치환 불가)와의 정합을 실측으로.

마지막에 5줄 요약: 「재수립 결과 — I-4.md 에 반영할 수정 N건(목록), plan.md 에 반영할 것, 문의 최종 건수」.
