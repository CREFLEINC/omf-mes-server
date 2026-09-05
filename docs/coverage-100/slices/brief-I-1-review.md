# I-1 개별 계획안 3관점 재검토 브리프 (README §1-2 「설계 문의가 새로 생김」 조건 발동)

대상: `docs/coverage-100/slices/I-1.md`. 결과는 **자기 관점 파일 하나**에만 쓴다 —
`docs/coverage-100/slices/I-1-review-{api|uiux|integration}.md` (150줄 이내). 다른 파일 수정 금지, 구현 금지.

## 공통으로 읽을 것
- `docs/coverage-100/README.md` §1-2·§2 · `docs/coverage-100/plan.md` §0·§1·§3·§7
- `docs/coverage-100/slices/I-1.md` 전문
- 계약 원문 `contracts/app-공통.json` 의 `/app/approval-*` 12 오퍼레이션과 `Approval*` 스키마(`jq`)
- 자기 관점 계획서: api → `plan-api.md` S09(242~268행)·§5.3·§5.4 / uiux → `plan-uiux.md` U1(§1-2 의 U1 절)·§6-2·§8-5·§9-3 / integration → `plan-integration.md` §2·§3-1 I-1(206~212행)·§9

## 판정할 것 (각 항목에 ✅ 동의 / ✏ 수정(대안+근거) / ⛔ 반대(근거))
1. **문의 후보 3건(018·019·020)이 정말 새 문의인가** — 계약·화면 명세·`docs/design-inquiries/`·이미 보낸 1~15번(`~/omf-design-requests/설계-문의-2026-09-0*.md`)·`docs/계약-되돌림-mdm.md` 에 이미 답이나 같은 물음이 있으면 「기존」으로 판정. 각 건마다 §2 절차 판정(가장자리/본길, 2단계 기준 번호)에 동의하는가.
2. **`request()`·`assertNoOpenRequest`·`assertApproved` 를 I-2 코어 PR 로 미룬 것**(§3-5) — 자기 관점에서 문제가 있나(예: I-1 e2e 가 승인 요청 행을 만들 방법, 채번 의존).
3. **J-8 후속 통지 = 상태 조회 갈래**(§3-4) — 동의하나.
4. **§6-2 `screenId` 생략 + `openable=false`**, **§6-3 `approverIsActive=false`** 판정.
5. **PR 4개 분할·순서**(§7) — 자기 관점에서 바꿀 것.
6. 자기 관점 계획서와 I-1.md 가 어긋나는 자리 중 **구현에 영향 주는 것**만(취향 차이는 제외).

마지막에 5줄 요약: 「재수립 결과 — I-1.md 에 반영할 수정 N건(목록), plan.md 에 반영할 것, 문의 최종 건수」.
