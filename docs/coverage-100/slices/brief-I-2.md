# I-2 P/O + 채번 코어 + 승인 상신 코어 — 개별 계획안 브리프 (계획만, 구현 금지)

산출물: `docs/coverage-100/slices/I-2.md` 하나. 저장소 파일을 고치거나 만들지 않는다(이 파일 하나만 쓴다).

## 읽을 것 (순서대로)
1. `docs/coverage-100/README.md` — §1-2 「차이가 크다」·§2 판정 절차·§5 불변 제약
2. `docs/coverage-100/plan.md` — §0 #3(채번)·#10, §1 2행, §3 「승인 상신 코어」·「채번」, §4 A1·A2·M-b, §5 횡단, §7(018·022 가 I-2 에 걸친다)
3. `docs/coverage-100/plan-integration.md` 153행(채번)·216~221행(I-2 상세)·491·567·597·623·627·661행
4. `docs/coverage-100/plan-api.md` 43~64행(S01) · 948~1074행(§5.3 횡단·§5.4 에러코드) · **1075~1140행(§5.5 채번 — 32전표 표·기본 패턴 권고)**
5. `docs/coverage-100/plan-uiux.md` 131~141행(U4 P/O·ASN)
6. **I-1 결과물** — `docs/coverage-100/slices/I-1.md` §0-재수립(R-2 시그니처·R-3 정본 연결·R-8 픽스처·R-11 문의 018·022) · §3-5(「`request()` 는 I-2 코어 PR」) · 실제 코어 `src/core/approval/approval.service.ts`(`selectRoute`·`expandSteps`·`currentStep`·`approve`·`reject` 시그니처 실측 — `request` 는 아직 없다) · `test/approval-request.fixture.ts`(`AP-E2E-{seq}` 리터럴 — I-2 가 채번으로 갈아끼운다)
7. 계약 원문: `contracts/logistics-01자재창고.json` 의 `/logistics/purchase-orders*` 7 오퍼레이션 전건 — `jq` 로 parameters·requestBody·responses·`x-*`·description 을 **전부** 읽는다. `components.schemas` 의 `PurchaseOrder*` 스키마 전건. `:request-approval` 의 description(「진행 중 요청은 하나」·`ROUTE_NOT_FOUND`·응답 형태)과 다른 `:request-approval` 3건(`goods-issues`·`adjustments`·`production-results`)·`lots:request-iqc-skip`·`document-progress/*:request-cancel`·`shipments:request-cancel` 의 description — **상신 코어가 9 호출자 공통으로 무엇을 해야 하는지** 여기서 뽑는다.
8. `prisma/schema.prisma` — `purchase_order`(1051행~)·`purchase_order_line`(1075행~)·`numbering_rule`(243행~)·`numbering_counter`(229행~)·`approval_request` + 관련 check/유일 제약(`prisma/migrations/` grep). `purchase_order.approval_request_id`·`source_inbound_receipt_line_id` 가 정말 없는지, `erp_purchase_order_no` 유일 제약이 없는지(§I-48) 실측.
9. `prisma/seed.ts` — `LOGISTICS_DOCUMENT_STATUS`·`PURCHASE_ORDER_*` 류 코드그룹 · `numbering_rule` 시드(`PRODUCTION_RESULT` 1건) · `entity_type_registry` 의 `PURCHASE_ORDER` 행(#186 이 넣음)
10. 기존 채번 사용처: `src/logistics/goods-receipt/receipt-posting.ts` 의 `GR-`·`PT-` 생성(`count()+1` 패턴 — 이관 대상) · `notice_no`(`src/app/notice/`) 는 이관 여부 판단
11. 기존 패턴: `src/logistics/goods-receipt/`(전표 CRUD·라인 치환·상태 전이 관행) · `src/common/permissions/`(`OPERATION_PERMISSIONS`·`manual-permissions.ts`) · `src/common/master`(`runIdempotent`·`runVersioned`) · `transitions.ts` · `test/logistics-goods-receipt.e2e-spec.ts` · `docs/server-architecture.md` §1~§3·C-6
12. 설계 저장소 사본(읽기 전용): `/Users/rangkim/projects/crefle/omf/apps/omf-mes/design/wiki/screens/01/W-01-11-신규PO등록.md`(§I-48 208행) · `W-01-09`·`W-01-03` · `design/schema/numbering-conventions.md`(전표 채번 규약이 «없다»는 것을 확인)
13. `docs/design-inquiries/README.md` + `018`·`022` — 요청서 형식과 I-2 에 걸친 문의

## 계획서에 반드시 담을 것
1. **계약 읽기 표** — 7건 각각: 파라미터·본문 필드·응답·에러코드(계약이 이름 적은 것)·멱등/If-Match/ETag/403·`x-*` 노트. 추측 금지, 계약 문장 인용.
2. **물리 대조** — 계약 스키마 ↔ `purchase_order`·`purchase_order_line` 컬럼. 없는 칸·다른 이름·제약. 마이그레이션 SQL 초안(A1 `approval_request_id?` FK · A2 `source_inbound_receipt_line_id?` · M-b 유일 제약(§I-48 — 어느 칸에, 부분 유일인지)). forward-only·추가만. FK 제약 이름은 Prisma 기본형(메모리 규칙 — `fk_*` 로 지으면 drift).
3. **채번 코어 인터페이스** — `src/core/numbering/` 시그니처(예: `next(tx, documentTypeCode, plantId, businessDate)`), `numbering_rule` 패턴 해석 범위(시드 1건의 패턴 문법을 실측해 그 문법만), 리셋 주기, **동시성**(`numbering_counter` 행 잠금 — `SELECT … FOR UPDATE` 또는 upsert 경합; e2e 로 어떻게 고정할지), 미등재 유형 기본값 `{PREFIX}-{YYYYMMDD}-{SEQ4}`, 접두어 목록 한 곳, `GR-`·`PT-` 이관 diff, `AP-` 승인 요청 번호. 코어 PR ≤200줄에 들어가는가.
4. **승인 상신 코어 인터페이스** — `request(tx, {...})`·`assertNoOpenRequest`·`assertApproved` 시그니처(I-1 R-2 축 `approvalTypeCode`, `selectRoute(businessUnitId)` 는 P/O 만 값), 「진행 중 요청은 하나」의 판정(부분 유일 인덱스 vs 조회 — §2 로), `approval_request_no` 채번 의존, 9 호출자가 쓸 모양. 코어 PR ≤200줄.
5. **상태기계** — `purchase_order.status_code` 값·전이·`transitions.ts` 등록 줄. `:request-approval` 이 상태를 옮기는지(API S01 초안 「안 옮긴다」)를 §2 로 판정. 승인 완료 뒤 P/O 상태는 누가·언제 옮기나(J-8 상태 조회 갈래 — I-3 입하가 `assertApproved` 로 확인?).
6. **횡단** — 403 등록(`manual-permissions.ts` 에 없는 것만), 멱등 4, If-Match 3, ETag, `X-Worker-No`.
7. **설계 미정 자리** — 각각 README §2 절차로 판정. 문의가 필요한 것은 제목만(요청서는 구현 시 작성, 023 부터). 018·022 와 겹치면 「기존」.
8. **PR 분할** — 코어 2(채번·상신 — 각 ≤200, 마이그레이션은 P/O 첫 PR 의 별도 선행 커밋) + P/O 조회 + P/O 쓰기·e2e. 각 PR 의 파일 목록·예상 diff·테스트 이름 목록(unit + e2e). 모델 배분(코어 opus · 조회/복제 sonnet).
9. **통합 계획 대조** — `plan.md` §1 2행·§3·§4 와 다른 점. README §1-2 3조건 중 걸리는 것이 있으면 맨 위에 ⚠ 로.

금지: 구현 코드 작성 · 계약 파일 수정 · 다른 문서 수정 · 값 지어내기(값 목록이 없으면 「없다」고 적고 §2 로 판정) · `omf-mes`·`omf-mes-client` 저장소 쓰기.
