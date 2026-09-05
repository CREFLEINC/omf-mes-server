# I-1 승인 코어 — 개별 계획안 브리프 (계획만, 구현 금지)

산출물: `docs/coverage-100/slices/I-1.md` 하나. 저장소 파일을 고치거나 만들지 않는다(이 파일 하나만 쓴다).

## 읽을 것 (순서대로)
1. `docs/coverage-100/README.md` — §2 판정 절차·§5 불변 제약
2. `docs/coverage-100/plan.md` — §0 #2·#10, §1 1행, §3 승인·screenId, §4 A6, §5 횡단 규칙
3. `docs/coverage-100/plan-integration.md` 206~212행(I-1 상세) · 676~690행(12건 목록)
4. `docs/coverage-100/plan-api.md` 242~268행(S09) · 948~1027행(§5.3 횡단) · 1028~1074행(§5.4 에러코드)
5. 계약 원문: `contracts/app-공통.json` 의 `/app/approval-requests*`·`/app/approval-routes*` 12 오퍼레이션 전건 — `jq` 로 parameters·requestBody·responses·`x-*`·description 을 **전부** 읽는다. `components.schemas` 의 `Approval*` 스키마 전건.
   또 `:request-approval` 를 가진 오퍼레이션 4건(`purchase-orders`·`goods-issues`·`adjustments`·`production-results`)과 `lots:request-iqc-skip`·`document-progress/*:request-cancel`·`shipments:request-cancel` 의 description — **호출자가 코어에 무엇을 요구하는지**(`ROUTE_NOT_FOUND`·「진행 중 요청은 하나」·J-8 「승인은 자물쇠만 푼다」) 를 여기서 뽑는다.
6. `prisma/schema.prisma` 의 `approval_request`·`approval_route`·`approval_route_step`·`approval_step` 모델(76~170행 근처) + 관련 check 제약(`prisma/migrations/` 에서 `approval` grep)
7. `prisma/seed.ts` 의 `APPROVAL_TYPE`·`APPROVAL_REQUEST_STATUS`·`APPROVER_TYPE` 등 코드그룹(있는지/값)
8. 기존 패턴: `src/app/notice/`(app 도메인 CRUD 관행), `src/common/permissions/`(`OPERATION_PERMISSIONS`·`manual-permissions.ts`), `src/common/optimistic-lock/`, `src/common/idempotency/`, `src/common/contract/`, 상태기계 `transitions.ts`(`grep -rn transitions.ts src | head`), `test/app-notice.e2e-spec.ts` 류 e2e 관행, `docs/server-architecture.md` §1~§3
9. `docs/design-inquiries/README.md` + `016`·`017` — 요청서 형식

## 계획서에 반드시 담을 것
1. **계약 읽기 표** — 12건 각각: 파라미터·본문 필드·응답·에러코드(계약이 이름 적은 것)·멱등/If-Match/ETag/403·`x-*` 노트. 추측 금지, 계약 문장 인용.
2. **물리 대조** — 계약 스키마 ↔ 4모델 컬럼. 없는 칸·다른 이름·제약. 마이그레이션 SQL 초안(A6 부분 유일 인덱스 + 발견된 것). forward-only.
3. **코어 인터페이스** — 뒤의 9 호출자가 쓸 서비스 시그니처(예: `ApprovalService.request(tx, {...})`·`approve`·`reject`·`assertNoOpenRequest`), 결재선 선택 규칙(사업부 지정본 우선 → `ROUTE_AMBIGUOUS`), 순차 결재(`NOT_YOUR_TURN`), `APPROVER_TYPE_NOT_SUPPORTED`, J-8(승인이 대상 문서를 «실행»하지 않는다 — 호출자가 후속을 한다면 어떤 훅으로 알리나: 콜백/상태 조회 중 택1과 근거). `screenId` 생략 헬퍼.
4. **상태기계** — `approval_request.status_code` 값·전이·`transitions.ts` 등록 줄. 값 목록 근거(코드 사전/시드/계약 enum 중 무엇).
5. **횡단** — 403 등록 8건(`manual-permissions.ts` 근거 문구), 멱등 6건, If-Match 필수 6건, ETag 5건.
6. **설계 미정 자리** — 각각 README §2 절차로 판정(0단계 선례 → 1단계 → 2단계 기준 번호 → 3단계 흔적). 문의가 필요한 것은 제목만(요청서는 구현 시 작성).
7. **PR 분할** — 각 PR 의 파일 목록·예상 diff 줄수(≤400, 코어 ≤200)·테스트 이름 목록(unit + e2e). 마이그레이션은 첫 PR 의 별도 선행 커밋.
8. **통합 계획 대조** — `plan.md`/`plan-integration.md` I-1 과 다른 점. README §1-2 「차이가 크다」 3조건 중 걸리는 것이 있으면 맨 위에 ⚠ 로.

금지: 구현 코드 작성 · 계약 파일 수정 · 다른 문서 수정 · 값 지어내기(값 목록이 없으면 「없다」고 적고 §2 로 판정).
