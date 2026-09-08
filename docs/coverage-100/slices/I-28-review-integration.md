# I-28 통합 관점 독립 계획 리뷰

> 대상: `I-28.md` 전체·고정 계약 a6a87e1의 8건. 다른 관점 리뷰 미열람.
> 판정: **계획 수정 후 5건 진행 / 이벤트·구독 3건 보류 유지**. 구현 PR 승인이 아니다.
> 실측 부록의 DB·파일 크기 값은 유지했고 재측정하지 않았다. DB 조회·쓰기·E2E·git 쓰기 없음.

## §0의 다섯 축 판정

| # | 반드시 판정할 자리 | 판정 | 통합 결론 |
|---|---|---|---|
| 1 | 이벤트 정본 부재와 업무 데이터 0건을 구분했는가 | **수정 · 5/3 유지** | 발생 이력 0건과 코드 정의 부재는 다르다. 구독 GET의 저장행 조회 자체까지 불가능하다고 확대하지 말고, 미설정 정본 이벤트의 응답·최초 ETag를 구성할 근거 부재를 명시한다. |
| 2 | 이벤트별 토큰·Zalo와 사용자별 기존 표를 양립시켰는가 | **수정** | NULL/NULL 헤더·부분 유일·기존 행 보존·최초 잠금은 타당하다. GET의 한 스냅샷, 실제 HTTP ETag 억제, Prisma FK referential action을 추가한다. |
| 3 | ROLE 조직 경유와 비활성의 의미 | **유지 · 후보 확정 필요** | 사용자→부서→사업부와 user_role의 교집합을 유지한다. inactive 표시와 active-only totalCount는 명명된 가장자리 판정으로 기록한다. |
| 4 | 자기 알림·반열림 기간·read-all 개수·재전송 원자성 | **유지 · 검증 보강** | actor/query 지문과 전달받은 tx 사용을 유지한다. 전역 runner 수정 없이 경계별 재전송·실패 롤백·권한 선행을 확인한다. |
| 5 | 실측 예산과 병렬 공용 파일 | **수정** | 기존 수치는 배정 기준으로 유지하되 추가 HTTP/조회 원자성 작업을 포함한 실제 diff로 재배정한다. 선후행 PR과 공용 변경별 회귀 파일을 고정한다. |

## 고정 계약 8건과 보류 범위

| operation | 판정 | 근거와 정상 경로 |
|---|---|---|
| GET `/app/notifications` | 진행 | `contracts/app-공통.json:1757,4970` — 저장된 자기 notification/event가 원천이다. 데이터 0건도 정상 결과이며 코드 정의가 없어도 저장 eventCode·message·occurredAt을 반환할 수 있다. |
| GET `/app/notifications/unread-count` | 진행 | `contracts/app-공통.json:1860` — 자기 recipient_user_id의 read_at NULL 개수, 기간 제한 없음. |
| POST `/app/notifications/{notificationId}:read` | 진행 | `contracts/app-공통.json:1890` — 자기 행만 변경, 최초 read_at 보존, 204 무본문, 남의 행/없는 행 404. |
| POST `/app/notifications:read-all` | 진행 | `contracts/app-공통.json:1939` — UPDATE의 실제 변경 count와 멱등 응답을 한 tx에 저장한다. |
| POST `/app/notification-subscriptions/recipients:preview` | 진행 | `contracts/app-공통.json:3445` — 입력은 recipients이며 eventCode가 없다. 실제 사용자·조직·역할로 정상 전개할 수 있다. |
| GET `/app/notification-events` | 보류 | `contracts/app-공통.json:1980,2004,5053` — 계약 소유 목록인데 코드 문자열 자체가 미확정이다. 사건명 예시·발생 이력 DISTINCT·빈 정의 배열로 대체할 수 없다. |
| GET `/app/notification-subscriptions` | 보류 유지 | `contracts/app-공통.json:2022,2049` — 저장 설정만 조회하는 SQL은 가능하지만 이벤트 선택→개별 GET→If-Match의 최초 편집 경로는 미완이다. 정본 이벤트와 없는 입력을 구분할 근거·미설정 응답을 먼저 정해야 한다. |
| PUT `/app/notification-subscriptions` | 보류 | `contracts/app-공통.json:2074,2084,2090` — 이벤트 생성 API가 아니다. 허용 코드 집합 없이 임의 문자열을 신규 이벤트로 등록하거나 전건 거부하는 구현은 완료로 셀 수 없다. |

**보류 이유를 좁힌다.** `I-28.md:188`의 “정본 집합 없음”은 모든 저장 설정 SELECT를 막는 DB 제약이 아니다. 전체 GET을 “저장된 헤더만”으로 정하면 카탈로그 없이도 조회는 성립한다. 다만 초안 `:200~202`는 정본 이벤트별 초기 설정과 토큰까지 제공하는 계약 소비 흐름을 선택했다. 그 흐름을 버리고 저장행 0을 이벤트 설정 전체의 0으로 확정할 선례가 없다. 이를 코드 정의 부재·최초 설정 정책의 문제로 기록하고 현재 operation 보류를 유지한다. 보류를 5건의 저장 이력 조회/읽음/입력 전개로 확대하지 않는다.

README §2 적용: 계약 `:2004`의 미확정 명시까지가 0단계 근거이고, 목록/허용 코드 집합은 1단계 본길이다. 반면 비활성 사용자·Zalo 생략·설정 없는 **확정 이벤트**는 가장자리다. description의 빈 발생표와 internal note의 사건명은 양립하며, preview의 저장 금지와 응답 재생은 업무 쓰기 0·멱등 기록 1로 양립한다(`docs/coverage-100/plan-api.md:986`). **전 레인 중단을 요구할 계약 간 모순은 발견하지 않았다.**

**최소 해소 조건**: 권한 있는 정본에서 eventCode↔eventName 목록을 확인하면 이벤트 GET의 보류를 풀 수 있다. 구독 2건에는 그 목록과 함께 미설정 이벤트의 items/ETag 기준(초안의 `[]·false·1` 후보), 미등록 입력 처리, 위 토큰으로 최초 PUT이 가능한 규칙을 R로 확정한다. 발생기·검교정 배치·Zalo 전화번호/전송기는 해소 조건으로 추가하지 않는다. 고정 계약을 갱신하지 않는다.

**지금 적용할 마이그는 0건**이다. 즉시 5건은 기존 표만 사용한다. A7·A8, nullable 두 칸, 헤더 부분 유일, 자식 표/관계는 구독 보류 해소 뒤 조건부 ④에서만 적용하며, 실제 SQL 적용 전에 사전 SELECT·generate·deploy·drift 0을 기록한다.

## 놓친 통합 결함과 고치는 법

### Major 1 — setEtag 생략은 HTTP ETag 부재가 아니다

- 근거: `I-28.md:200,284,367,377`은 호출 생략으로 헤더 부재를 기대한다. 그러나 `src/app.setup.ts:10`에는 자동 ETag 억제가 없고, 설치본 `node_modules/.pnpm/express@5.2.1_supports-color@10.2.2/node_modules/express/lib/application.js:95`는 weak ETag가 기본, 같은 패키지 `lib/response.js:167,192`는 본문에서 ETag를 만든다. `contracts/app-공통.json:2049`는 전체 GET에서 ETag를 명시적으로 금지한다.
- 추가 확인: 포트·DB 없이 설치 Express의 response.send에 `{items:[]}`를 전달한 진단에서 `etagSetting=weak`, `ETag=W/"c-F6g7sByJuuOcYYkgTnzj94yg+ZE"`가 나왔다. E2E 실행이 아니다.
- 고치는 법: 조건부 구독 컨트롤러에 **응답 범위가 한정된** 헤더 억제/직접 JSON 종료 처리를 배정한다. 응답 전에 removeHeader만 호출하거나 요청마다 전역 `app.set('etag', false)`를 토글하면 자동 생성·동시 요청 문제가 남는다. 전역 `src/app.setup.ts` 변경을 선택한다면 별도 공용 HTTP 변경 책임·PR·회귀 범위를 R로 분리한다. 기존 version ETag는 보존한다.
- 테스트: `전체구독조회는실제HttpETag를내리지않는다`, `단일이벤트조회는버전ETag를유지한다`, `구독PUT첫응답과재전송에자동ETag가없다`.

### Major 2 — 구독 GET의 ETag와 recipients를 같은 스냅샷으로 읽는 규칙이 없다

- 근거: `I-28.md:200~203`은 GET 원자성을 명시하지 않고 `:279~283`은 PUT에서 헤더·자식을 함께 바꾼다. `contracts/app-공통.json:2049`의 토큰은 사용자가 읽은 해당 이벤트 설정의 판 번호여야 한다.
- 왜: 헤더 version 조회와 자식 조회 사이에 다른 PUT이 커밋되면 예전 version과 새 recipients, 또는 그 반대가 한 응답에 섞인다. 단순히 Prisma include나 기본 격리의 여러 SELECT를 쓰는 것으로 한 스냅샷을 보장했다고 판단하지 않는다.
- 고치는 법: 헤더·자식·Zalo·version을 단일 SQL 문장으로 읽거나, 여러 조회가 필요하면 읽기 전용 RepeatableRead tx를 명시한다. GET이 헤더를 생성하거나 잠금 토큰을 갱신하지 않는 원칙은 유지한다.
- 테스트: `구독조회중PUT이커밋돼도ETag와수신자가같은판이다`, `최초구독조회는헤더를생성하지않는다`.

### Minor 3 — SQL과 Prisma의 새 관계 동작을 명시해야 한다

- 근거: `I-28.md:142~147`의 SQL FK는 ON UPDATE/DELETE를 생략하며 `:179`는 Prisma 관계를 이름과 개수로만 제시한다. 기존 관계는 `prisma/schema.prisma:25,347,1659,3872`처럼 `onDelete: NoAction, onUpdate: NoAction`이다.
- 고치는 법: 새 부모·사업부·역할·사용자 관계 4개에도 SQL과 같은 NoAction을 명시하고 기존 nullable 전환 관계의 옵션을 유지한다. 짝 CHECK·부분 유일을 일반 Prisma unique로 치환하지 않는다. 자식이 legacy 부모를 가리키지 않는 것은 서비스 헤더 선택 조건으로 유지하며 직접 DB 쓰기에도 보장된다고 과장하지 않는다.
- 테스트: `마이그후FK동작과Prisma모델의드리프트가없다`, `legacy행에는새수신자규칙을붙이지않는다`, `혼합NULL헤더와중복ROLE_USER규칙이거부된다`.

### Major 4 — 예산·공용 등록부 회귀의 실행 범위를 고정한다

- 근거: `I-28.md:419,422`의 199/195 배정은 각각 여유가 1/5줄이고, `:380,426`은 영향 회귀의 구체적 대상을 남기지 않았다. `docs/coverage-100/lanes.md:80~85`는 자동 병합이어도 양쪽 기능의 앱 부팅 E2E를 요구한다.
- 고치는 법: 즉시 ①→②와 ②의 write-context→③, 조건부 ④의 schema/GET 및 ③의 규칙 검증→⑤ 의존을 표기한다. ①에 write-context 준비를 옮기더라도 해당 R 확정 뒤에만 넣는다. HTTP 처리·스냅샷 읽기 추가분은 기존 배정에 포함된 것으로 간주하지 말고 실제 diff로 재산정한다. 초과하면 준비 PR을 별도로 분리하며 새 총합을 추정 확정하지 않는다.
- 등록부만 바꾸면 통합자는 변경 알림 E2E와 `test/app-user.e2e-spec.ts`, `test/app-approval-request.e2e-spec.ts`를 실행하고, 최신 main에서 추가된 A의 첨부/대시보드·B의 발행 기능이 있으면 해당 파일을 더한다. 수신자 참조 변경 영향은 `test/app-role.e2e-spec.ts`, 권한 1줄은 `test/permission-gate.e2e-spec.ts`로 확인한다.
- **즉시 조회 PR ①**은 같은 PR의 `test/app-notification.e2e-spec.ts`에서 조회 응답 전칸·자기 사용자·반열림·정렬/총수를 검증한다. 통합자의 등록부 회귀는 위 app-user/app-approval-request 및 최신 main에서 실제 겹친 기능 파일이다. 공용 HTTP 변경은 조건부 구독 문제이므로 ①의 선행으로 끌어오지 않는다.
- 공용 HTTP 설정까지 바꾸면 별도 범위로 `test/optimistic-lock.e2e-spec.ts`, `test/cors.e2e-spec.ts`와 기존 ETag 사용 도메인 파일을 더한다. 구현자 lint/tsc/단위 전체/변경 E2E 실측 → 리뷰어 단위 전체+변경 파일 → 통합자 영향 회귀 1회의 역할 분리는 유지한다.

## 유지할 불변식과 R 반영 제안

| R 제안 | 반영할 결정·필수 테스트 |
|---|---|
| R-통합1 | 5건 진행/3건 보류의 이유를 위 표로 좁힌다. 저장 0건은 조회 성공이며 발생 이력은 카탈로그가 아니다. `미등록eventCode알림목록필터는빈결과다`, `인원없는유효ROLE규칙은빈전개로성공한다`. |
| R-통합2 | 헤더 NULL/NULL + 부분 유일 + version1 삽입→잠금→비교→version2, 수신자 0명에도 헤더 보존을 유지한다. `동시최초PUT다른키같은IfMatch는하나만성공한다`, `첫PUT실패는헤더와멱등기록을남기지않는다`, `수신자전부해제뒤토큰은되돌아가지않는다`. |
| R-통합3 | Major 1·2, Minor 3을 조건부 ④·⑤의 진입 조건에 반영한다. 새 공용 파일 수정은 별도 책임을 배정하며 이 리뷰에서는 구현하지 않는다. |
| R-통합4 | ROLE은 직접 부서의 business_unit_id와 user_role 둘 다 일치해야 한다(`prisma/schema.prisma:25,341,1646`). 부서·사업부 NULL에서 상위부서·worker·접근범위로 소속을 도출하지 않는다. `부서의사업부NULL도ROLE에포함되지않고USER는포함된다`. |
| R-통합5 | inactive를 users에 싣는 것은 계약 `:3513`, active-only totalCount는 화면 `W-CO-11-알람수신자설정.md:171`의 제외/표시를 함께 만족시키는 후보로 확정·문의한다. 활성/비활성 혼합 2명에서 users.length=2, totalCount=1과 중복 제거를 단언한다. 비활성 조직/역할로 합성 isActive를 만들지 않는다. |
| R-통합6 | `IdempotencyService.run`의 tx 전달·완료기록 원자성(`src/common/idempotency/idempotency.service.ts:66~87`)을 유지한다. `notification-write-context`는 actor를 필수로 받고 실제 method/path·PUT eventCode·body를 지문에 넣는다. 4개 명령 각각 다른 actor 재전송 409, 다른 notificationId/eventCode 409, 같은 키 실패 후 재시도, read 204 재전송을 단언한다. |
| R-통합7 | 멱등 완료기록 실패 주입을 read뿐 아니라 read-all·preview·조건부 PUT에 연결한다. `readAll완료기록실패는읽음변경을롤백한다`, `preview완료기록실패뒤같은키재시도는다시전개한다`; preview 업무표 변경 0도 유지한다. |
| R-통합8 | I-1이 참조 사용자/역할의 선행이며 I-30 발생기는 의존으로 추가하지 않는다(`docs/coverage-100/lane-B.md:30`). I-29에는 실제 Notification 매핑·self unread 조건·openable=false 한계만 인계하고 알림 service를 새 공용 코어로 이동하지 않는다. Major 4의 PR DAG·회귀 범위를 마감표에 넣는다. |

보안은 세션 주체·권한 선행·actor 지문 방향을 유지한다(`src/auth/authentication.guard.ts:41~54`, `src/common/permissions/permission.guard.ts:40`). 정확성은 위 Major 해소가 필요하고, 성능은 ROLE의 일괄 전개와 PK 중복 제거를 유지한다. CREFLE coding-rules와 code-review 스킬은 작은 책임·명시적 실패 전파·동시성 근거·검증 가능한 테스트 이름에 적용했다. 문의 번호는 통합자가 B 대역에서 배정하며 3단계 흔적을 붙인다.
