# I-3 개별 계획안 3관점 재검토 브리프 (README §1-2 「마이그레이션 추가」·「설계 문의가 새로 생김」 두 조건 발동)

대상: `docs/coverage-100/slices/I-3.md`. 결과는 **자기 관점 파일 하나**에만 쓴다 —
`docs/coverage-100/slices/I-3-review-{api|uiux|integration}.md` (150줄 이내). 다른 파일 수정 금지, 구현 금지,
체크아웃 변경 금지(현재 브랜치 `docs/coverage-100-i3-plan` 그대로), `git` 쓰기 금지. 계약 `contracts/*.json` 은 읽기 전용(`jq`).

## 공통으로 읽을 것
- `docs/coverage-100/README.md` §1-2·§2·§5 · `docs/coverage-100/plan.md` §0 #4·#6·#10 · §1 3행 · §3 · §4 A3·행 N · §7
- `docs/coverage-100/slices/I-3.md` 전문 · 선행 `I-2.md` §0-재수립(R-1~R-12 — 특히 R-1 404 · R-6 삭제 가드 · R-12 인계)
- 계약 원문 `contracts/logistics-01자재창고.json` 의 `/logistics/asns*` 3건 · `/logistics/inbound-receipts*` 6건 · `/logistics/inbound-receipt-lines/{id}/variances` 2건 + `Asn*`·`InboundReceipt*`·`InboundVariance*`·`Split*` 스키마 · `trace` 계약의 `Lot.receiptDispositionCode`
- 실재 코드: `src/logistics/purchase-order/purchase-order.service.ts`(`replaceLines` 의 잠금·`received_qty` 손검사) · `src/logistics/goods-receipt/`(입고가 `inbound_receipt_line_id` 를 어떻게 쓰는지) · `src/trace/`(LOT 등록 서비스 — I-3.md §5-1 이 `createWithin(tx, …)` 추출을 제안) · `src/core/numbering/` · `prisma/schema.prisma` 의 5모델 + `purchase_order.source_inbound_receipt_line_id` · baseline `migration.sql` 의 `inbound_variance.reason_code NOT NULL`·`ck_po_line_received`
- 기존 문의 `docs/design-inquiries/016~025` · 이미 보낸 1~15번(`~/omf-design-requests/설계-문의-2026-09-0*.md` — 회신 15 businessDate) · `docs/계약-되돌림-mdm.md` §Z-2·§Z-4·§Z-5
- 자기 관점 계획서: api → `plan-api.md` S02(65~91행)·§5.3·§5.4·§5.5 / uiux → `plan-uiux.md` U4 ASN(144~146)·U5(148~161) · 화면 명세(설계 저장소 사본 `/Users/rangkim/projects/crefle/omf/apps/omf-mes/design/wiki/screens/01/` 의 `M-01-01`·`M-01-06`·`W-01-03`·`W-01-09`, 읽기 전용) / integration → `plan-integration.md` §3-1 I-3(224~233행)·148행(I-5 취소 축)·218행·§6·§8

## 판정할 것 (각 항목에 ✅ 동의 / ✏ 수정(대안+근거) / ⛔ 반대(근거))
1. **문의 026 이 정말 새 문의인가** — 023(P/O 상태 축)의 입하판이라 합치지 않는다는 판정, 「문의로 올리지 않는 것」 5건(§7-6 ⛔), `:split` 원본 처분 문의 **철회**(`W-01-03` §5-1 근거). 「알려둘 것」 8건(§7-5) 중 문의로 올려야 할 것이 있나.
2. **마이그레이션 한 파일**(§2-6) — A3 `lot_id?` + `inbound_variance.reason_code` NOT NULL 해제. §4 행 N(`x-no-code-key` status_code nullable)을 **걸지 않고** 상수 `'REGISTERED'` 로 가는 판정(§5-4 · §9 #6 — `plan.md` §0 #10 을 좁히자는 제안)에 동의하나. forward-only·두 릴리스 규칙 위반 없나.
3. **P/O 귀속·잠금**(§3) — 정량분만 `received_qty` += · 초과분은 `purchase_order_line_id` NULL · 부모 `purchase_order` 행을 `purchase_order_id` 오름차순 `FOR UPDATE`(I-2 코드 불변) · `ck_po_line_received` 손검사 · 입하는 P/O 승인을 **보지 않는다**(`assertApproved` I-4 유지) · `source_inbound_receipt_line_id` 흐름은 이 슬라이스 아님. 데드락·경합·되돌림(I-5) 관점에서 구멍이 있나.
4. **`:split`·차이**(§4) — 정량분·초과분 두 전표 한 트랜잭션 · 채번 2회 트랜잭션 밖 · 초과분 `exceptionTypeCode` 는 요청값 · 차이는 `received_qty`·라인 상태를 안 바꿈 · `varianceQty` 상한 없음.
5. **LOT·상태**(§5) — 등록 시 `LotService.createWithin(tx, …)` 로 LOT 을 함께 만들고 `lot_id` 를 채움(누가·언제 · `TraceModule` import) · `inspection_required` 는 품목 승계 · `manufactured_at` 안 채움 · `inbound_receipt.status_code` 전이 0(`transitions.ts` 미등록) · §7-4 「입고가 붙은 라인은 수정·삭제 400 `SUCCESSOR_EXISTS`」(계약 밖 자물쇠)가 §2 기준 2 로 서는가.
6. **PR 5개 분할·순서·모델 배분**(§8) — plan 3 → 5. 마이그 선행 커밋이 PR ②(등록) 에 서는 것. 각 PR 의 **단위 테스트 이름 목록**이 e2e 로 못 가는 가드(`STATE_LOCKED`·404·409·`LINE_REQUIRED`·중복/남의 id)를 빠짐없이 덮는가(#193·#194 리뷰 Major 재발 방지).
7. 자기 관점 계획서와 I-3.md 가 어긋나는 자리 중 **구현에 영향 주는 것**만(취향 차이는 제외). uiux 는 화면 명세(M-01-01 OCR·초과 분리 UX·W-01-03) 와의 정합을 실측으로.

마지막에 5줄 요약: 「재수립 결과 — I-3.md 에 반영할 수정 N건(목록), plan.md 에 반영할 것, 문의 최종 건수」.
