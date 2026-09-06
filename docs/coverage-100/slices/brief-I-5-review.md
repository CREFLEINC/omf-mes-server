# I-5 개별 계획안 3관점 재검토 브리프 (README §1-2 「설계 문의가 새로 생김」 조건 발동 — 032·033·034)

대상: `docs/coverage-100/slices/I-5.md`(1,019줄). 결과는 **자기 관점 파일 하나**에만 쓴다 —
`docs/coverage-100/slices/I-5-review-{api|uiux|integration}.md` (150줄 이내). 다른 파일 수정 금지, 구현 금지,
체크아웃 변경 금지(현재 브랜치 `docs/coverage-100-i5-plan` 그대로), `git` 쓰기 금지. 계약 `contracts/*.json` 은 읽기 전용(`jq`).
로컬 DB 는 읽기만(`psql` SELECT · `migrate reset`·`migrate diff --shadow-database-url` 절대 금지).

계획자 결론 요지: **「차이가 크다」 ⭕ — 조건 ③(문의 032·033·034 신설)**. ①·② 는 ✕(마이그 0 · 순서 그대로). 통합 계획서와 크게 어긋난 자리 —
ⓐ `entity_type_registry` 는 칸 4개·9종 중 5종만 → `plan-integration.md` §9 #5 「등록부에서 읽는다」를 **절반 기각**: 매핑은 코드 정적 표 `document-type-registry.ts`, 등록부는 부팅 대조만 · seed `ENTITY_TYPES` +7(§4-5)
ⓑ `:cancel` 본문 없음 → `business_date` = **원 트랜잭션의 것**(§3-4 ⭐ · 04 `ShipmentCancel` 은 `businessDate`·`occurredAt` required → 032) · `transaction_no` = `{원 번호}-R`(§3-5 · 채번 코어 안 부름) · `occurredAt` 은 서버 시각
ⓒ 취소 흔적은 `document_cancellation` 한 표만(`goods_issue` 취소 3칸 안 채움 · `reason_code='OTHER'` 상수 → 034 · §2-4)
ⓓ `CANCEL_IN_PROGRESS` 를 **400**(`plan-api.md` §5.4 는 409 · §7-4) · 반려 뒤 `CANCEL_REQUESTED` 되돌리는 전이 안 만듦(§6-5 → 033) · 5값 우선순위 `TYPE_NOT_CANCELABLE → ALREADY_CANCELLED → CANCEL_IN_PROGRESS → STATE_LOCKED → SUCCESSOR_EXISTS`(§4-4)
ⓔ PR 3 → **5**(§10 ①코어 ~162 · ②매핑+판정 ~265 · ③조회 ~378 sonnet · ④request-cancel ~258 · ⑤cancel+어댑터 ~330) · I-3 R-12 ⓑ 임시 자물쇠 **유지**(§6-1) · `putaway_task`·LOT 손대지 않음(§6-4).

## 공통으로 읽을 것
- `docs/coverage-100/README.md` §1-2·§2·§5·§6 · `docs/coverage-100/plan.md` §0 #5·§1 39행·43행·§3 「역트랜잭션」「다형 취소」·§5 #12·§8
- `docs/coverage-100/slices/I-5.md` 전문 · `brief-I-5.md`(읽을 것 15·담을 것 13) · 선행 `I-4.md` §0-재수립 R-1·R-2·R-9 ⓚ·R-12 ⓐ·§3-3·§3-8·§8-4 · `I-3.md` R-12 ⓐⓑⓒⓕⓘ·§7-4
- 계약 원문 `contracts/logistics-01자재창고.json` 의 `/logistics/document-progress*` 4건 + `DocumentProgress`·`DocumentProgressStep`·`DocumentProgressDetail`·`DocumentSuccessor`·`CancelResult`·`ApprovalRequestCreate` 스키마 · `x-code-key` 두 enum · `contracts/shipment-04제품출하.json` `ShipmentCancel` · `contracts/app-공통.json` 승인 경로 9건
- 실재 코드: `src/core/inventory-posting/inventory-posting.service.ts`(`post`·`move`·`PostingInput`·반환) · `src/logistics/goods-issue/issue-posting.ts`(`lockBalances` 7칸) · `src/logistics/goods-receipt/receipt-posting.ts` · `src/core/approval/approval.service.ts`(`assertApproved`·`assertNoOpenRequest`) · `src/core/document-state/transitions.ts`(:152-158) · `src/common/errors/error-codes.ts` · `src/common/http/derived-permissions.ts:48·49·167·168` · `prisma/schema.prisma`(`inventory_transaction` 610-688 · `document_cancellation` 3731-3745 · `entity_type_registry` 3747-3760 · 대상 3표) · `prisma/seed.ts`(`ENTITY_TYPES` · `LOGISTICS_DOCUMENT_STATUS` 1069-1078)
- 기존 문의 `docs/design-inquiries/016~031`(특히 026 입하 상태 축 · 030 폐기 출고 승인 게이트) · README 「알려둘 것」
- 자기 관점 계획서: api → `plan-api.md` S06(165~182)·§5.1-A(744~760)·§5.4(766~800)·936·1038 / uiux → `plan-uiux.md` 289~292·1027~1033·U18(1151) · 화면 명세(설계 저장소 사본 `/Users/rangkim/projects/crefle/omf/apps/omf-mes/design/wiki/screens/` 의 `01/W-01-13-물류문서진행현황취소.md` · `04/W-04-12-출하확정취소.md`) / integration → `plan-integration.md` 148~149·155·169·244~250·401·496·506·568·588·661·663·731~735·§6-2(I-5 ∥ I-8 금지)·§9 #5

## 판정할 것 (각 항목에 ✅ 동의 / ✏ 수정(대안+근거) / ⛔ 반대(근거))
1. **문의 032·033·034 가 정말 새 문의인가**(§9-2) — 032(역트랜잭션 영업일·시각·번호를 아무도 안 보낸다)가 C-8·026 과 겹치지 않나 · 033(반려 뒤 되돌릴 경로 없음)이 문의감인가, W-01-13 §5-7 「취소 요청 철회」와 계약 불일치를 어느 쪽에 물어야 하나 · 034(`reason_code` NOT NULL vs 자유 텍스트)가 문의인가 물리 정정(nullable 화 = 마이그)인가. 「알려둘 것」 12건(§9-3) 중 문의로 올려야 할 것이 있나. §9-1 판정표의 §2 절차 적용이 맞나.
2. **마이그레이션 0**(§2-6) — `document_cancellation` 9칸 · `inventory_transaction` 역 칸 2 + 복합 FK + CHECK 실재 실측에 동의하나 · seed `ENTITY_TYPES` +7 이 「마이그 아님」으로 지나가도 되나(`uq_entity_type_table` 중복) · `goods_issue` 취소 3칸을 비워 두는 것(§2-4 · 계약 프로퍼티 0)이 두-릴리스 삭제 규칙과 무관한가 · `plan.md`·`plan-integration.md` 정정 목록(§11)이 빠짐없나.
3. **`reverse()` 코어**(§3) — 시그니처(§3-1 · I-7·I-14·I-23 이 그대로 쓴다) · `from`/`to` 뒤집기 + `line_no` 복사 + 되짚기 칸 불변(§3-2) · **`business_date` = 원 트랜잭션의 것**(§3-4 ⓐ — `uq_inventory_idempotency(REVERSAL:{원 id}, 원 영업일)` 이 이중 역처리를 막는 부수 효과가 판정 근거인 것이 옳은가, 지난 영업일에 행이 붙는 대가) · `{원 번호}-R`(§3-5 · `uq_inventory_transaction_no` 와의 관계) · 세 겹 + 부분 유일 인덱스 안 검(§3-6) · 코어 안 선잠금 7칸 한 문장 + `post()` 안 고침(§3-7) · `NEGATIVE_BALANCE` 를 **코어**가 던지는 역전(§3-8 · I-4 §3-3 「음수 금지는 도메인」과의 정합) · ~162줄 ≤200(§3-9).
4. **후속 판정 함수 하나**(§4) — 세 호출자 · 문서 하류/재고 사용 두 갈래(§4-2) · 세지 않는 것 3규칙(§4-3) · 5값 우선순위와 `CANCEL_IN_PROGRESS` 의 OR 조건(§4-4) · **등록부는 검증·매핑은 코드**(§4-5 · `plan-integration.md` §9 #5 반박 — `$queryRawUnsafe` 금지 · `OnModuleInit` 대조는 로그 경고만) · 후속 5값 중 등록부에 없는 3값의 표 매핑.
5. **조회 2건**(§5) — 9종 한 형태(§5-1 · 외주 2종 FK 로 파기 §5-2) · 유니온이냐 유형별이냐·정렬·페이징(§5-3) · `steps` 는 상태 4값에 닿은 순간만 · 체인 안 거슬러 오름 · 입하 `POSTED` 줄 영원히 없음 · `POSTED` `actorName` 생략(§5-4) · `documentDateFrom/To` UTC 경계 · **sonnet 배분**(§5-6 · uiux 는 W-01-13 목록·상세 칸과 9종 회색 버튼이 이 응답으로 성립하는가 실측).
6. **상태기계·어댑터**(§6) — `transitions.ts` 키 하나에 더하고 키 둘을 연다 · `conflictStatus` 400 · `transitionCode` 안 씀 · 입하 `POSTED` 도달 불가를 그대로 둠 · **I-3 R-12 ⓑ 자물쇠 유지**(§6-1) · `:request-cancel` 순서(§6-2 · 승인 유형 `${type}_CANCEL` · 결재선 없으면?) · `:cancel` 순서 ③-2→③-3→③-4→③-5→③-6 (§6-3 · 재판정 실패 시 흔적 0) · 어댑터 3: 입하 `received_qty` 되돌림 부모 오름차순 잠금 · `putaway_task` 불변 · LOT ⓐ 손대지 않음 · 원 트랜잭션 2행+ 던짐(§6-4) · 반려 뒤 경로 없음(§6-5).
7. **횡단·PR 분할**(§7·§10) — 403 추가 0(`derived-permissions.ts` 4건 실재) · If-Match 토큰 = 대상 문서 `version_no` · 어댑터가 비교(§7-2) · `runIdempotent` 2 · `runVersioned` 불가(§7-3) · **`CANCEL_IN_PROGRESS` 400**(§7-4 · `plan-api.md` §5.4 409 와의 정합) · PR 5 분할·순서·모델 배분 · 각 PR **비테스트 예산 350 안**인가(README §6 ② — ③ ~378 은 초과) · 각 PR 의 **단위 테스트 이름 목록**이 e2e 로 못 가는 가드(세 겹 ③·`NEGATIVE_BALANCE` 0행·2행+ 던짐·5값 우선순위·반려 뒤 머묾)를 빠짐없이 덮는가 · §10-1 e2e 스위트·픽스처·정리 순서(원장 `TRUNCATE … CASCADE`) · J-8·M1.
8. 자기 관점 계획서와 I-5.md 가 어긋나는 자리 중 **구현에 영향 주는 것**만(취향 차이는 제외). §11 대조표의 자기 관점 행을 실측으로 확인. uiux 는 화면 명세(W-01-13 §5-2 파생 3칸 · §5-7 액션표 · 취소 사유 입력 · 9종 목록 · W-04-12 같은 규약의 둘째 구현)와의 정합을 실측으로.

마지막에 5줄 요약: 「재수립 결과 — I-5.md 에 반영할 수정 N건(목록), plan.md 에 반영할 것, 문의 최종 건수, PR 분할 최종안」.
