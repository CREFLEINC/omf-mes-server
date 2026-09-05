# I-3 입하 — ASN 조회 · 입하 등록/수정/라인 · 차이 · 초과 분리 (12건) — 개별 계획안 브리프 (계획만, 구현 금지)

산출물: `docs/coverage-100/slices/I-3.md` 하나. 저장소 파일을 고치거나 만들지 않는다(이 파일 하나만 쓴다). 체크아웃 변경 금지(브랜치 `docs/coverage-100-i3-plan` 그대로). `git` 쓰기 금지.

## 읽을 것 (순서대로)
1. `docs/coverage-100/README.md` — §1-2 「차이가 크다」·§2 판정 절차·§5 불변 제약
2. `docs/coverage-100/plan.md` — §0 #4(적치 I-12 병렬)·#6(검사 M3 — 입하 LOT 은 검사 대기), §1 3행(I-3 · A3 · sonnet 조회/opus 차이·초과분리 · PR 3), §4 A3(`inbound_receipt_line.lot_id?`), §5 횡단, §7(「미등록 품목 생성 경로 없음」이 I-3 에 걸친다), §8 진행(I-2 ✅ 257)
3. `docs/coverage-100/plan-integration.md` 224~233행(I-3 상세 — 원장 없음 · `businessDate` 는 받아서 형식만 검증 · `:split` 한 트랜잭션 · `Lot.receiptDispositionCode` 판정 · ASN 시드) · 148행(다형 취소 I-5 가 입하를 판정 대상으로 삼는다) · 218행(체인 마디)
4. `docs/coverage-100/plan-api.md` 65~91행(S02 — 마이그 A3 · 상태기계 · PR 3 초안 · `:split` 원본 처분 문의 초안 · 횡단 표) · 948~1074행(§5.3 횡단·§5.4 에러코드) · §5.5 채번 표에서 `INBOUND_RECEIPT` 행
5. `docs/coverage-100/plan-uiux.md` 131~161행(U4 의 ASN 3건 · U5 입하 9건 — 화면 M-01-01·M-01-06·W-01-03·P-01-01)
6. **I-2 결과물** — `docs/coverage-100/slices/I-2.md` §0-재수립 전문(특히 **R-12 인계 ①②** — 순환 FK e2e 정리 순서 · 「발주수량 < 초과분 수량」 서버 대응은 I-3 몫) · §5-4(승인 끝난 P/O 는 아무도 안 옮긴다 — J-8) · §7-5(문의 023·025) · R-10 「알려둘 것」. 실재 코드: `src/logistics/purchase-order/purchase-order.service.ts`(`replaceLines` 가 `received_qty` 를 **잠그지 않고** 손검사한다 — I-3 의 귀속 갱신과 경합하면 `ck_po_line_received` 가 500 으로 샌다: 이 슬라이스가 잠금 순서를 정한다) · `purchase-order-query.service.ts` · `src/core/numbering/`(`next(documentTypeCode, plantId, periodDate)` — 트랜잭션 밖) · `src/core/approval/approval.service.ts`(`assertApproved` 는 아직 없다 — I-4 로 이관됨. 입하가 P/O 승인 여부를 봐야 하는지 §2 로 판정)
7. 계약 원문: `contracts/logistics-01자재창고.json` 의 `/logistics/asns*` 3건 · `/logistics/inbound-receipts*` 5건 · `/logistics/inbound-receipts:split` · `/logistics/inbound-receipt-lines/{id}/variances` 2건 — `jq` 로 parameters·requestBody·responses·`x-*`·description **전부**. `components.schemas` 의 `Asn*`·`InboundReceipt*`·`InboundVariance*`·`InboundReceiptSplit*` 전건. `Lot.receiptDispositionCode`(`trace` 계약)도.
8. `prisma/schema.prisma` — `asn`(691~)·`asn_line`(714~)·`inbound_receipt`(865~)·`inbound_receipt_line`(898~)·`inbound_variance`(~937)·`goods_receipt_line.inbound_receipt_line_id`(834)·`purchase_order.source_inbound_receipt_line_id`(1069)·`purchase_order_line.received_qty`+`ck_po_line_received`. 관련 check/유일 제약을 `prisma/migrations/` 에서 grep. `inbound_receipt_line.lot_id` 가 정말 없는지 실측.
9. `prisma/seed.ts` — `LOGISTICS_DOCUMENT_STATUS` · `INBOUND_VARIANCE_TYPE`(427) · `INBOUND_VARIANCE_REASON`(585) · `INBOUND_RECEIPT_EXCEPTION_TYPE`(640) · `entity_type_registry` 의 `INBOUND_RECEIPT`·`INBOUND_RECEIPT_LINE`(1349~1374, `INBOUND_LOT` 각주) · `numbering_rule` 시드
10. 기존 입고: `src/logistics/goods-receipt/`(전표 CRUD·라인 치환·`receipt-posting.ts`·`isDuplicateNo`·`NUMBER_RETRY`·`goods-receipt-view.ts` 가 `inbound_receipt_line` 을 어떻게 읽는지) · `test/logistics-goods-receipt.e2e-spec.ts`(입하 라인 픽스처를 이미 어떻게 세우는지 — I-3 e2e 가 재사용/대체) · `src/mdm/logistics/location.service.ts` 의 `inbound_receipt` 참조
11. 기존 패턴: `src/common/permissions/`(`OPERATION_PERMISSIONS`·`manual-permissions.ts`) · `src/common/master`(`runIdempotent`·`runVersioned`) · `src/common/optimistic-lock/` · `src/common/errors/prisma-error.ts`(FK/CHECK 매핑 갈래 — CHECK 는 500 으로 샌다) · `transitions.ts` · `docs/server-architecture.md` §1~§3
12. 설계 저장소 사본(읽기 전용): `/Users/rangkim/projects/crefle/omf/apps/omf-mes/design/wiki/screens/01/` 의 `M-01-01`·`M-01-06`·`W-01-03`·`W-01-09` · `P-01-01`(있으면) · `design/wiki/` 에서 「초과 입하」「분리 등록」「입하 차이」 grep
13. `docs/design-inquiries/README.md` + `016`·`023`·`025` — 요청서 형식 · 다음 번호 **026**
14. 이미 보낸 문의 1~15(`~/omf-design-requests/설계-문의-2026-09-0*.md`) 중 「회신 15」(businessDate) · `docs/계약-되돌림-mdm.md`

## 계획서에 반드시 담을 것
1. **계약 읽기 표** — 12건 각각: 파라미터·본문 필드·응답·에러코드(계약이 이름 적은 것)·멱등/If-Match/ETag/403·`x-*` 노트. 추측 금지, 계약 문장 인용. `:split` 의 요청/응답 형태와 「한 트랜잭션」 문장, variances 의 유형·사유 코드그룹.
2. **물리 대조** — 계약 스키마 ↔ `asn`·`asn_line`·`inbound_receipt`·`inbound_receipt_line`·`inbound_variance`. 없는 칸·다른 이름·제약. 마이그레이션 SQL 초안(A3 `lot_id?` FK — forward-only·추가만·FK 이름은 Prisma 기본형). `businessDate` 는 저장하지 않는다(통합 §3-1) — 그러면 계약 응답의 `businessDate` 는 무엇을 돌려주나 §2 로.
3. **P/O 귀속** — 입하 라인이 `purchase_order_line.received_qty` 를 언제 올리나(등록 시? 라인 치환 시 차분? 취소 시 I-5 가 되돌림). `ck_po_line_received` 를 500 으로 안 새게 하는 손검사와 **잠금 순서**(입하 등록이 `purchase_order` 부모 또는 라인을 `FOR UPDATE` — P/O `replaceLines` 와의 데드락 회피 포함). I-2 R-12 ② 「발주수량 < 초과분」 서버 대응. 입하가 P/O 승인 상태를 보는가(`assertApproved` 부재 · §5-4 J-8) — §2 로 판정. `source_inbound_receipt_line_id` 로 초과분 P/O 를 만드는 흐름이 이 슬라이스인가 아닌가.
4. **`:split`** — 정량분·초과분 두 입하를 한 트랜잭션으로; 원본 처분(계약 문자 그대로 + 문의 초안 확인); 채번 2회(트랜잭션 밖 · 실패 시 번호 소모 — 알려둘 것); 초과분 라인의 P/O 귀속 여부.
5. **차이(variance)** — 등록 대상 라인 상태 제약, 유형·사유 코드 검증, 입하 라인 수량과의 관계(차이가 `received_qty` 를 바꾸나).
6. **LOT** — A3 `lot_id`: 누가 채우나(입하 등록이 `POST /trace/lots` 를 부르지 않는다면 어느 오퍼레이션이 연결하나 — 기존 입고가 `inbound_receipt_line_id` 로 되짚는 흐름 실측). `Lot.receiptDispositionCode` 는 통합 판정(칸을 빼고 문의)을 유지하는지.
7. **상태기계** — `inbound_receipt.status_code` 값·전이·`transitions.ts` 등록 줄. 라인 `status_code` 의 값과 갱신 시점. 「작성중」 잠금(`STATE_LOCKED`) 이 실제로 도달 가능한지(입고가 상태를 옮기나).
8. **횡단** — 403 등록(`manual-permissions.ts` 에 없는 것만 · 도출표 중복 금지), 멱등 5, If-Match 2(+ POST 선택 1 — 「선택」의 뜻을 계약에서), ETag 3, `X-Worker-No`.
9. **e2e 정리 순서** — I-2 R-12 ① 순환 FK(`purchase_order.source_inbound_receipt_line_id → inbound_receipt_line → purchase_order_line → purchase_order`): cleanup 순서를 확정하고 P/O e2e(`test/logistics-purchase-order.e2e-spec.ts`)의 cleanup 이 깨지지 않는지. 기존 입고 e2e 의 입하 픽스처와 상수 충돌 실측. ASN 은 등록 경로가 없어 직접 INSERT.
10. **설계 미정 자리** — 각각 README §2 절차로 판정. 문의가 필요한 것은 제목만(요청서는 구현 시 작성, 026 부터). 기존 문의와 겹치면 「기존」.
11. **PR 분할** — 초안 3(① 조회 7건 · ② 마이그 선행 커밋 + 등록·헤더·라인 치환 + e2e · ③ `:split` + 차이 2건 + e2e). 비테스트 diff ≤400(코어성 ≤200 — `:split` 이 코어인지 판정). 각 PR 의 파일 목록·예상 diff·**테스트 이름 목록을 unit 과 e2e 로 나눠 각각** 적는다 — ⚠ #193·#194 리뷰 Major 재발 방지: e2e 로 도달 못 하는 가드(`STATE_LOCKED`·`LINE_REQUIRED`·남의 id·중복 id·404·409 류)는 **단위 테스트 이름을 여기서 확정**한다. 모델 배분(조회 sonnet · 귀속/`:split` opus).
12. **통합 계획 대조** — `plan.md` §1 3행·§4 A3·`plan-api.md` S02·`plan-integration.md` I-3·`plan-uiux.md` U5 와 다른 점. README §1-2 3조건 중 걸리는 것이 있으면 맨 위에 ⚠ 로.

금지: 구현 코드 작성 · 계약 파일 수정 · 다른 문서 수정 · 값 지어내기(값 목록이 없으면 「없다」고 적고 §2 로 판정) · `omf-mes`·`omf-mes-client` 저장소 쓰기 · `contracts:update`/`contracts:check`.
