# I-2 개별 계획안 3관점 재검토 브리프 (README §1-2 「설계 문의가 새로 생김」 조건 발동)

대상: `docs/coverage-100/slices/I-2.md`. 결과는 **자기 관점 파일 하나**에만 쓴다 —
`docs/coverage-100/slices/I-2-review-{api|uiux|integration}.md` (150줄 이내). 다른 파일 수정 금지, 구현 금지,
체크아웃 변경 금지(현재 브랜치 `docs/coverage-100-I-2-plan` 그대로). 계약 `contracts/*.json` 은 읽기 전용(`jq`).

## 공통으로 읽을 것
- `docs/coverage-100/README.md` §1-2·§2 · `docs/coverage-100/plan.md` §0 #3·§1 2행·§3·§4 A1·A2·M-b·§7
- `docs/coverage-100/slices/I-2.md` 전문 · 선행 `I-1.md` §0-재수립(R-1~R-12)
- 계약 원문 `contracts/logistics-01자재창고.json` 의 `/logistics/purchase-orders*` 7 오퍼레이션과 `PurchaseOrder*` 스키마,
  `:request-approval` 류 9자리의 description(공통분모 — I-2.md §1-4)
- 실재 코드: `src/core/approval/approval.service.ts`(I-1 코어) · `prisma/schema.prisma` `purchase_order`·`purchase_order_line`·`numbering_rule`·`numbering_counter` · `prisma/seed.ts` 의 `numbering_rule` 행 · `GR-`/`PT-`/`NTC-` 의 `count()+1` 세 자리
- 기존 문의 `docs/design-inquiries/016~022` · 이미 보낸 1~15번(`~/omf-design-requests/설계-문의-2026-09-0*.md`) · `docs/계약-되돌림-mdm.md`
- 자기 관점 계획서: api → `plan-api.md` S01(43~64행)·§5.3·§5.4·§5.5(1075~1140행) / uiux → `plan-uiux.md` U4(131~141행)·W-01-11 화면 명세(설계 저장소 사본 `/Users/rangkim/projects/crefle/omf/apps/omf-mes`, 읽기 전용) / integration → `plan-integration.md` §2 채번·§3-1 I-2(216~221행)·§6-1·§6-3 M-b·§7 대기 10·14·§8 위험 4

## 판정할 것 (각 항목에 ✅ 동의 / ✏ 수정(대안+근거) / ⛔ 반대(근거))
1. **문의 후보 2건(023·024)이 정말 새 문의인가** — 위 기존 자료에 같은 물음·답이 있으면 「기존」으로 판정. 각 건마다 §2 절차 판정(가장자리/본길·2단계 기준 번호)에 동의하는가. 「문의로 올리지 않는 것」 3건(§7-5 ⛔)도 맞는가.
2. **채번 코어**(§3) — 시그니처·동시성(한 문장 UPDATE … RETURNING)·기본 패턴 `{PREFIX}-{YYYYMMDD}-{SEQ4}`·규칙 없는 유형에 규칙 행 자동 생성·`GR-`/`PT-`/`NTC-` 세 자리 이관·`reset_cycle_code≠DAILY` 던짐. 자기 관점에서 문제가 있나(예: 계약 `example` `PO-2026-000123` 과의 불일치, 카운터 잠금 경합, 오프라인 재전송 멱등과의 관계).
3. **상신 코어**(§4) — `request`·`assertNoOpenRequest` 둘만 만들고 `assertApproved` 는 I-4 로 미룸 · 「진행 중 하나」를 부분 유일 인덱스 없이 조회로 판정 · `:request-approval` 이 `status_code` 를 안 옮기고 `version_no` 도 안 올림(202 에 ETag 없음).
4. **상태기계**(§5) — 전이 0 이라 `transitions.ts` 미등록 · 「작성중」= `REGISTERED` 하나 · 문의 023 과의 관계.
5. **마이그레이션 한 파일(A1·A2·M-b)**(§2-5) — 부분 유일 `erp_purchase_order_no` 를 지금 거는 것(§7-3 기준 2) 에 동의하나. 두 릴리스 규칙·forward-only 위반 없나.
6. **PR 5개 분할·순서·모델 배분**(§8) — 자기 관점에서 바꿀 것. ③ 조회 PR 이 마이그를 싣는 것이 맞나(쓰기 PR 이 아니라).
7. 자기 관점 계획서와 I-2.md 가 어긋나는 자리 중 **구현에 영향 주는 것**만(취향 차이는 제외).

마지막에 5줄 요약: 「재수립 결과 — I-2.md 에 반영할 수정 N건(목록), plan.md 에 반영할 것, 문의 최종 건수」.
