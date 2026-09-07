# I-26 독립 계획 리뷰 — Integration

> 대상: `.backend-dev/lane-b/I-26-draft.md` 489줄 전체. 기준은 통합자 전달 main `f85cb51`, 공식 **346/487**, 고정 계약 `a6a87e1`이다. 공식 게이트를 재실행한 값이 아니다.
> brief·CLAUDE·README·lanes·lane-B·plan·I-24 형식과 통합 리뷰 예시, 해당 3관점 정본 절, 계약 GET/POST·연결 schema/headers/errors, P-02-05 전체, 실제 Prisma·소비 코드를 대조했다. 다른 I-26 리뷰 원문은 읽지 않았다.
> `coding-rules`·`pr-review`와 연결 TypeScript/commit/checklist/severity/template를 직접 읽었다. 계획 리뷰이며 소스·DB·E2E·게이트·git·외부 글 쓰기 0. 초안의 DB 시점값·줄 예산을 반복 측정하지 않았다.

## 심각도 및 다섯 축 판정

| Blocker | Major | Minor | Nit |
|---:|---:|---:|---:|
| 0 | 3 | 2 | 0 |

| 정확히 다섯 축 | 판정 | 통합 결론 |
|---|---|---|
| 1. statusCode 필수 원천·서버 위임·POST 본길 | 채택 | GET은 저장값 그대로, POST는 원천 확인 전 유보. 번호 위임을 상태 위임으로 넓히지 않는다 |
| 2. 전역 번호·결번·배치 전량 원자성 | 조건부 채택 | 전역 UNIQUE 유지, 선채번은 멱등 tx 밖, 개체+멱등 결과는 같은 tx. 결번 허용은 번호 정책으로 명시 |
| 3. LOT 배분합·누계·소수·병렬 | 수정 필요 | LOT별 합과 모든 개체 count, 잠금 뒤 재조회는 맞다. **배분 UOM→개체 수 의미가 빠졌다(M1)** |
| 4. 발번/발행·If-Match·사번/단말·409 | 수정 필요 | API 분리·선택 헤더 판정·로컬 멱등 사용은 유지. **fingerprint에 bigint를 넣지 않는다(M2)** |
| 5. TraceModule·실측 예산·PR 분리·회귀 | 수정 필요 | GET 180/350·코어 ≤200 분리는 타당. **조건부 쓰기의 NumberingModule/AuthModule 배선 누락(M3)** |

## 1. 버그·정확성

### M1 — Major: 배분 수량의 단위를 개체 수로 간주한다

- 지점: `I-26-draft.md:225`, `:235`, `:240`, `:338`. Decimal은 정밀도를 보장할 뿐 수량 단위를 같게 만들지 않는다.
- 실제 원천: `prisma/schema.prisma:2869` 배분 `uom_id`, `:2824` 실적 `uom_id`, `:3522` LOT `uom_id`, `:1731` 품목 `base_uom_id`가 따로 있다. `production-result.service.ts:106`은 요청 `uomId`를 배분에 그대로 쓰며 `:179`의 검사는 UOM 존재뿐이다. `:153`의 슬롯 조회도 UOM을 비교하지 않는다.
- 따라서 같은 LOT에 서로 다른 단위의 실적을 넣을 수 있다. 예를 들어 10 EA와 1 BOX를 더한 11은 11개체의 근거가 아니며, 전부 KG여도 정수라는 이유로 개체가 되지 않는다. `LotProgress`의 기존 숫자 합은 개체 환산의 선례가 아니다. 배분 상한 트리거(`20260727000000_baseline_physical_model_v3/migration.sql:2902`)도 단위는 검사하지 않는다.
- 구체 수정: §5/§9/§8-2에 **단위 원천 판정**을 추가한다. 잠금 뒤 배분을 UOM별로 조사하고, 개체 1개와 수량 1의 대응 또는 환산 원천이 입증된 집합만 비교한다. 혼합/환산 미확정 집합의 처리는 README §2에 따라 400 `INVALID`와 문의로 명시한다. `EA` 문자열·decimalScale·base_uom 동일 여부만으로 개체 단위를 지어내지 않는다.
- 최소 해소: 허용 단위와 환산 기준의 출처, 혼합 단위 처리, 소수 잔량 규칙을 R-n에 적고 해당 실패/성공 테스트 이름을 추가한다. I-7·LOT 진척에 이미 있는 단위 한계는 별도 인계하며 이번 GET에서 고치지 않는다.

### M2 — Major: 실제 terminalId 타입과 fingerprint 함수가 맞지 않는다

- 지점: `I-26-draft.md:248`, `:276`, `:294`. `resolveTerminalId`의 서명은 `Promise<bigint | null>`(`src/auth/terminal-token.ts:26`)이다.
- `requestFingerprint`는 `stableJson`을 호출하고 primitive에서 `JSON.stringify(value)`를 한다(`src/common/idempotency/idempotency.service.ts:31`, `:35`). 초안 식의 `actor.terminalId`에 실제 반환값을 넣으면 정상 단말 요청도 bigint 직렬화 오류로 번호 준비 전에 실패한다.
- 구체 수정: 로컬 actor DTO와 정규화 규칙을 계약으로 적는다. 지문에는 `terminalId?.toString() ?? null` 같은 JSON 안전한 문자열/null을, DB 게이트에는 원래 bigint를 사용한다. `Number(terminalId)`로 바꿔 정밀도를 잃지 않는다. 준비 객체 전체를 fingerprint에 넣지 않는다.
- 최소 해소: 「실제 bigint 단말 ID로 지문 생성 성공 / 같은 ID 재생 / 다른 ID 충돌」 테스트 이름과 타입을 명시한다. 공용 `stableJson` 수정은 필요 없다.

### M3 — Major: 조건부 POST의 Nest 모듈 의존성이 빠졌다

- 지점: `I-26-draft.md:209`, `:294`, `:416`. `NumberingService` 및 `resolveTerminalId`용 `JwtService`를 쓸 계획인데 조건부 파일·등록 목록에 두 모듈이 없다.
- `src/trace/trace.module.ts:17`은 Prisma/Idempotency/LotRegistry만 import한다. `NumberingModule`은 `src/core/numbering/numbering.module.ts:7`에서 로컬 provider/export이며, `JwtModule`은 `src/auth/auth.module.ts:37`이 export한다. 둘 다 Global이 아니므로 AppModule의 형제 import만으로 TraceModule에 주입되지 않는다.
- 구체 수정: GET PR은 현재 imports 유지. POST PR 파일·줄 예산에 **TraceModule의 `NumberingModule`과 `AuthModule` imports** 및 해당 service/controller 주입을 포함한다. JwtModule을 새 비밀키로 재등록하거나 NumberingService provider를 복제하지 않는다.
- 최소 해소: §10 조건부 배선 표에 imports 두 개를 적고, 재개 E2E는 실제 AppModule과 정상 단말 토큰으로 부팅·발번한다. 공용 등록부는 B 등록만 더하고 A 등록을 보존한다.

### 승인 가능한 경계와 실제 의존성

- 상태: 계약 `production-02생산실행.json:5987`은 상태 축 미정·코드 그룹 금지, `:5999`는 응답 required다. 물리 `schema.prisma:3682`도 기본값 없는 NOT NULL이다. `:4151`/`:4215`의 서버 위임은 **번호**에만 있다. P-02-05 `:173`과 문의053은 상태 원천을 새로 주지 않는다. **GET 진행/POST 본길 유보**가 맞다.
- 채번: `next(type, null, period)`와 도메인 공장/LOT 접두어는 기존 전역 코어를 사용할 수 있다. N개의 예약이 끊기거나 rollback되면 번호만 소모될 수 있다는 한계를 유지한다. 화면 `P-02-05:184`의 연속성 어휘와 계약의 N행/0행 보장을 같다고 단정하지 않는다.
- 풀/tx: `IdempotencyService.run(context, work)`는 tx를 실제 전달(`:56`, `:77`)하므로 로컬 조정안은 성립한다. run 이전 순차 선채번, work 안의 읽기·INSERT·검증은 **전부 전달된 tx**로 하면 업무 중 추가 Prisma 연결을 기다리지 않는다. `runIdempotent` 또는 내부 `$transaction`을 겹치면 이 성질이 사라진다.
- `run`은 트랜잭션 옵션 인자를 제공하지 않는다(`:56`~`:90`). GET의 RepeatableRead 옵션을 POST에 그대로 옮길 수 없으며, 같은 LOT 대기 후 새 집계를 쓰려면 현재 READ COMMITTED 경계를 유지한다. 1000건·동시 요청의 시한/풀 오류까지 무조건 재생 201로 보장하지 않고, 실제 실패를 번호 P2002로 오인하지 않는 회귀를 둔다.
- 동일 LOT 직렬 발번: LOT 잠금 뒤 별도 문장 count는 타당하다. I-7의 양수 append와 정정의 배분 미변경(`production-result-correct.service.ts:35`)은 초안의 제한 범위와 일치한다. 향후 배분 감소·삭제 생산자는 같은 잠금 규칙과 기발번 하한 정책의 추가 의존성이다.
- 현재 GET 필드에는 물리 결손이 없어 **마이그 0**이 맞다. `serial_component_relation` 쓰기·LOT 상태 변경·serial 상태 default/nullable 변경은 필요 없다. POST 귀속 칸 결손/멱등 보존을 해결하는 DDL은 아직 승인된 것이 아니므로 GET에 얹지 않는다.

## 2. 보안·횡단 계약

- 계정 인증과 단말 구성 게이트의 분리는 맞다. 기능 권한은 `derived-permissions.ts:260`, GET 권한 미검사는 `permission.guard.ts:40`으로 설명된다. 신규 ERROR_CODE·권한표·인증 우회가 필요 없다.
- Worker-No의 존재/길이/공백 검사는 유지하되, 지문 해시는 사번 귀속의 저장 대체물이 아니다. §9 #11의 문의에 「개체 행만으로 귀속 사번·단말을 복원할 수 없음」을 명확히 적는다. created_by에 worker_id를 넣는 해법은 금지한다.
- If-Match 부재 허용은 확정이다. 정상 헤더의 대상은 공유계약 `B-1-1:891`대로 계약에 명시돼야 한다. LOT ETag가 존재한다는 사실만으로 그 토큰을 시리얼 생성에 차용하지 않는다. 초안의 제공 건 400은 **잠정 가장자리 판정**으로 R-n에 확정하고 문의하며, 상태 유보를 푸는 근거로 쓰지 않는다.
- 멱등 충돌에만 409 필수 code를 보완하는 로컬 처리와 완료 응답 우선 재생은 유지한다. `ConflictException.conflict`(`src/common/errors/conflict.exception.ts:39`)로 기존 cause를 보존하며 다른 예외·번호 설정 오류를 멱등 충돌로 덮지 않는다.

## 3. 테스트·실제 소비자 체인

- GET 최소 마디는 `GET /trace/lots/{id}?withProgress=true` → `GET /trace/serial-numbers?lotId={id}`의 **page.total**이다. `LotController:44`/`:51`, `LotService:219`가 실제 생산자다. two-GET 원자 스냅샷은 없으며 최종 잔량은 POST가 재확인한다. GET의 unknown 상태/NULL 시각/반열림/페이지 분리 검증은 충분하다.
- 재개 후 마디는 POST serial 응답 N개 ID → `POST /app/document-issues`의 `{documentTypeCode:'IDENTIFICATION_TAG', targets:[{targetTypeCode:'SERIAL_NUMBER',targetId,lotId}]}`다. `app-공통.json:4524`~`:4526`은 targets 1~1000과 전량 원자성을 명시해 I-26 최대1000과 맞는다. ① 성공/② 실패 시 같은 대상·발행 요청 키로 ②만 재시도한다.
- I-27은 기존 serial/LOT/HU 대상 기록 부분을 별도 진행할 수 있다. GET만으로 새 인식표 발번·인쇄가 완성됐다고 보고하지 않는다. `P-02-12:27`은 정상 인식표 경로를 재사용하고, `P-04-04:78`의 신규 발번 대상은 HU이므로 시리얼 생성 의존으로 묶지 않는다.
- 추가 테스트: M1 단위 불일치·개체 환산 원천, M2 bigint actor, M3 실제 DI 부팅, 잠금 대기 뒤 재집계, core 실패/P2002 이외 예외 전파. SQL 실패 주입과 low connection_limit은 지정 B DB E2E에서 구현 시 수행한다.
- 영향 회귀: GET 병합 때 `trace-lot.e2e-spec.ts`; 조건부 코어 변경 때 numbering 전체 단위; POST 재개 때 production-result 생성→동일 LOT 발번 마디. I-27이 서는 시점의 「발행 기록 실패→개체 유지→②만 재시도」 체인은 I-27 통합자에게 넘긴다. 이 리뷰에서 실행하지 않았다.

## 4. 컨벤션·통합 문서

- **Minor N1** — `I-26-draft.md:409` 브랜치 `codex/coverage-100-b-i26-query`는 `lanes.md:48`의 B 소유 판정 접두어와 다르다. 구현 브랜치는 `feat/coverage-100-b-i26-query`, 계획은 `docs/coverage-100-b-i26-plan`으로 맞춘다. PR의 `[B]`는 유지한다.
- **Minor N2** — `I-26-draft.md:429`의 목표 **480→479**는 현재 정본보다 한 단계 뒤다. `plan.md:173`은 이미 I-30 보류를 반영한 **479**다. 다른 변화가 없으면 I-26 POST 보류 확정 뒤 목표는 **478/487**이며 실제 main **346/487**과 구분한다. `plan-integration.md:190`, `:425`에도 GET/POST 분리·조건부 코어·재개 의존성을 반영한다.
- GET 비테스트180 배정과 조건부350은 구현 실측이라고 주장하지 않아 적절하다. M2/M3·단위 판정 추가분을 조건부 재측정에 포함하고, 초과하면 순수 규칙/준비 → 원자적 업무+멱등 handler로 분리한다. 코어 PR을 업무 PR과 합치지 않는다.

## 판정·보류 해소 최소 조건

**GET 1건은 진행 가능. POST는 상태 본길 유보를 유지한다.** 발견 Major 3개는 조건부 POST 계획의 수정 요구이며, GET의 가짜 상태/POST 거부 핸들러 구현을 요구하지 않는다.
POST 재개 최소 조건은 ① 상태 의미/값의 원천 또는 명시적 서버 위임 ② 개체 단위 대응·혼합 단위 판정(M1) ③ 번호 형식/UTC 기간·결번 경계와 If-Match R-n 확정 ④ actor 직렬화(M2)·DI(M3)·same-tx 인터페이스 명시다. 이후 코어/업무 PR 분할 및 지정 검증을 수행한다. 사번 귀속·멱등 기록 삭제 한계는 문의와 배포 제한에서 계속 추적한다.
스킬의 근거·심각도·4영역 점검 형식을 적용했으며 외부 코멘트/병합은 위임 범위가 아니므로 수행하지 않았다.
