# I-28 개별 계획 독립 리뷰 — API

| §0의 검토 축 | 판정 | API 근거와 필요한 정정 |
|---|---|---|
| 1. 이벤트 정본 부재와 업무 데이터 0건을 구분했는가 | **유지: 현재 5건 진행·3건 보류 / 해소 조건 수정** | `contracts/app-공통.json:1980,2004,5059`가 정본 소유와 코드 문자열 미확정을 함께 명시한다. 발생 이력·구독 0행을 이벤트 정의 0건으로 반환하지 않는다. 구독 GET의 선택 이벤트·초기 토큰까지 충족하려면 정본 이벤트 식별이 필요하다. 다만 초기 토큰에 대한 별도 회신까지 보류 조건으로 넓히지 않는다(F2). |
| 2. 이벤트별 토큰·Zalo와 사용자별 기존 표를 양립시켰는가 | **구조 유지 / 응답 경계 수정** | 이벤트별 NULL/NULL 헤더·규칙 자식·빈 recipients에도 헤더 보존은 `app-공통.json:2049,2074,5082`의 잠금·치환 단위와 일치한다. 과거 사용자채널 행은 새 설정으로 합치지 않는다. 전체 GET의 ETag 금지는 자동 헤더까지 막아야 한다(F1). |
| 3. ROLE 조직 경유와 비활성의 의미 | **유지, 해석 후보를 R로 확정** | 부서→사업부와 user_role의 교집합, USER 직접 지정, 최종 사용자 중복 제거가 두 축을 보존한다. `app-공통.json:3513`의 비활성 표시와 `W-CO-11-알람수신자설정.md:171`의 제외+표시를 함께 지키도록 users에는 전원·totalCount에는 active만 포함하는 후보를 권고한다. 비활성 조직/역할을 사용자 isActive로 합성하지 않는다. |
| 4. 자기 알림·반열림 기간·read-all 개수·재전송 원자성 | **유지 / 인증·HTTP 단언 보강** | 기간은 계약 `app-공통.json:1790,1801` 그대로, readCount는 실제 UPDATE 수. actor/eventCode 지문과 전달 tx 사용을 유지한다. 인증된 주체는 현재 반드시 활성 app_user이고 terminal-only는 401이다(V1). 204는 저장 응답 null 재생도 무본문이어야 한다(V2). |
| 5. 실측 예산과 병렬 공용 파일 | **분할 원칙 유지 / 확정 예산은 유보** | PR ①의 응답 칸 테스트, 권한 1줄 단독 커밋, app-domain 자기 등록을 유지한다. 실측 부록의 기존 파일 줄 수를 그대로 인수하되 새 경계 코드의 실제 diff를 증명하지는 않는다. F1은 조건부 ④ 책임이며 전역 HTTP 변경으로 확대하지 않는다. |

현재 단계는 계획 리뷰이며 PR 코드 리뷰 승인이 아니다. 계획 502줄과 고정 계약 8 operation 및 연결 스키마·헤더·오류를 직접 대조했다. 다른 관점 리뷰는 읽지 않았다. 실측 부록의 DB·코어 값은 인수했고 DB/E2E/게이트는 실행하지 않았다.

## 놓친 결함과 근거

### F1 — Major: `setEtag` 미호출은 전체 구독 GET의 ETag 금지를 보장하지 않는다

- 계획 `docs/coverage-100/slices/I-28.md:200`은 명시적 `setEtag`를 하지 않는 것으로 전체 GET을 처리하고, `:367`은 헤더가 없음을 검증한다. 계약 `contracts/app-공통.json:2049`는 **eventCode 없는 응답에는 ETag를 내리지 않는다**고 명시한다.
- 현재 `src/app.setup.ts:10`은 Express ETag를 끄지 않는다. 설치본 `node_modules/.pnpm/express@5.2.1_supports-color@10.2.2/node_modules/express/lib/application.js:95`는 기본 weak이고, 같은 경로 `response.js:167,192`는 기존 ETag가 없으면 응답 본문으로 자동 생성한다. `node_modules/@nestjs/platform-express/adapters/express-adapter.js:68`은 객체를 `response.json`으로 보낸다.
- 네트워크·DB 없이 실제 Express 응답 객체의 `json({items:[]})`를 호출한 진단 결과: `defaultEtag=weak`, `ETag=W/"c-F6g7sByJuuOcYYkgTnzj94yg+ZE"`. 기존 실측 부록 값을 뒤집은 것이 아니라 관찰되지 않은 HTTP 계층을 추가 확인했다.
- **수정**: 조건부 구독 GET 컨트롤러에서 전체/없는 이벤트 분기는 JSON을 직렬화해 `response.type('application/json').status(200).end(...)`로 완료하는 등 해당 응답에서만 자동 생성 경로를 피한다. eventCode가 가리키는 정본 이벤트 응답만 숫자 버전 ETag를 명시한다. 직접 응답이면 Nest 이중 전송이 없도록 `@Res()`와 반환 책임도 일치시킨다.
- 전역 `app.set/disable('etag')`를 요청 중 바꾸면 다른 응답과 경합한다. 공용 설정 변경·새 범용 응답 추상화는 I-28에 요구하지 않는다. 다른 GET/PUT의 **ETag 미선언**은 이 **명시적 금지**와 다르다. PUT `:284,377`은 새 버전 ETag를 만들지 않는다는 뜻으로 정정하고, 헤더 완전 부재까지 독자 규칙으로 확장하지 않는다.
- **테스트**: `전체 구독 GET은 빈 목록과 여러 이벤트 모두 ETag 헤더 자체가 없다`, `선택 이벤트 GET만 그 이벤트의 숫자 ETag를 반환한다`, `구독 GET 직접 응답은 items JSON 봉투를 한 번만 전송한다`.

### F2 — Minor: 보류 해소 조건이 초기 토큰까지 정본 회신을 요구하는 것으로 읽힌다

- 계획 `:195`는 코드↔이름 **및 초기 행/토큰 기준이 권한 있는 정본에서 확인**되는 것을 해소 조건으로 적었다. 반면 `:201,390`은 이미 정의된 이벤트의 구독 미설정을 **가장자리**로 분류하고, GET 무쓰기·초기1·최초 저장2라는 후보와 선례를 제시했다.
- **왜**: 이벤트 정의 부재는 모든 정상 호출의 식별이 비는 본길이다. 이미 정본에 있는 이벤트의 미설정은 일부 상태이며 `docs/coverage-100/README.md:43`의 본길 보류를 그대로 적용할 사유가 아니다. 발생 트리거 미정도 구독 설정 보류 해소 조건으로 넣으면 안 된다.
- **수정**: 현재 3건 보류 이유는 코드 정본 부재로 한정한다. 코드↔이름이 확인되면 통합자가 R로 초기1·GET 무쓰기·최초 PUT2를 결정하고 문의에 흔적을 남겨 재개한다. 초기 토큰 추가 회신을 필수로 기다린다는 문장은 제거한다. 미설정 헤더를 GET에서 만들거나 임의 eventCode마다 토큰을 발급하지 않는다.
- **테스트**: `정본 이벤트의 미설정 GET은 쓰기 없이 같은 초기 ETag를 준다`, `초기 ETag로 저장하면 버전2이며 다음 초기 토큰 저장은 충돌한다`.

## 추가 경계 판정 — 새 코어 결함으로 확대하지 않음

- **V1 인증 주체**: `src/auth/authentication.guard.ts:36`은 로그인 외 모든 `@Contract`에 세션을 요구하고 `:53`에서 붙인다. `session-resolver.service.ts:54`는 typ=session만, `session.service.ts:21`은 활성 app_user만 인정한다. 따라서 초안 `:209`의 자기 userId는 추측이 아니다. 로컬 주체 추출은 undefined를 명시적으로 401 처리하는 기존 `src/app/notice/notice.controller.ts:150` 선례를 쓴다. optional userId가 Prisma where에서 빠지는 구현을 피한다.
- **V1 테스트**: `세션 없음·terminal-only·비활성 계정은 401이며 알림 조회와 읽음 업무가 실행되지 않는다`, `다른 사용자로 같은 멱등키를 보내면 앞 응답을 노출하지 않는다`. 인증/terminal 코어나 새 기능권한을 추가할 필요는 없다.
- **V2 204 재생**: `src/common/idempotency/idempotency.service.ts:84,127`에서 undefined가 DB null로 보관·재생되지만 Nest ExpressAdapter `:48`은 둘 다 `send()` 처리한다. 204를 명시하고 완료를 await한 뒤 void 반환하면 두 경로 모두 무본문이다. `IdempotentOutcome`의 replayed/status/body를 API 봉투로 그대로 반환하지 않도록 로컬 경계 책임을 명시한다.
- **V2 테스트**: `읽음 최초·같은 키 재전송·다른 키 이미읽음은 모두 204이고 raw body가 비어 있다`. 기존 `IdempotencyService`를 변경할 근거는 없다.
- **V3 계약 봉투**: 8건의 성공/선언 오류는 초안 `:35` 표와 일치한다. 400·403·404는 `{errors:[{scope,code,message,...}]}`(`contracts/app-공통.json:3624,3664`), 409는 `{conflictCause,message}`(`:3678`)를 유지한다. 공통 인증/멱등 가드의 미선언 401·400·409는 기존 경계 차이로 문의에 남기며 오류 enum이나 계약을 수정하지 않는다.
- **V4 nullable/required**: `NotificationRecipient` ID 3칸은 optional이지만 null 불허(`app-공통.json:5119`). ROLE의 나머지 축·USER의 나머지 축은 **생략**한다. preview `departmentName`과 Notification `screenId/locationPath`만 명시적으로 null을 허용하며, 초안의 원천 없을 때 생략은 유효하다. recipient 빈 배열·활성0/비활성1 전개도 성공 스키마를 만족해야 한다.
- **V4 테스트**: `recipient FK null은 정확한 필드의 INVALID이며 ROLE/USER 응답에는 반대 축 키가 없다`, `비활성 수신자만 있으면 users에는 false 한 명과 totalCount 0을 반환한다`.
- **V5 읽기 의미**: Notification의 required 6칸은 저장값으로 제공 가능하다. eventCode 필터는 저장 이력의 정확 일치이며 정의 등록이 아니다. 이벤트 이름 조회가 보류돼 제목까지 화면이 완결되지 않는다는 초안 `:193`의 한계는 유지한다. openable=false·화면 키 생략은 계약 `:5034,5039`가 허용하므로 이를 이유로 조회2건까지 보류하지 않는다.

## R-n 반영 제안

| R 후보 | 최종 계획에 반영할 내용 | 구현/검증 책임 |
|---|---|---|
| R-API-1 | 현재 5진행/3보류 유지. 코드 정본 부재·발생0건·구독미설정을 각각 구분하고 F2의 해소 조건 정정 | 통합자, §3·§9·보류 목록 |
| R-API-2 | 전체 구독 GET의 자동 ETag를 국소 차단. 미선언 PUT과 금지 GET 구별 | 조건부 PR ④ 컨트롤러+헤더 E2E; 실제 diff 재측정 |
| R-API-3 | ROLE 조인·inactive 표시/active count 권고 확정, nullable/반대 축 생략 단언 | PR ③ preview·규칙 검증; 조건부 ⑤ 동일 규칙 재사용 |
| R-API-4 | actor/eventCode 지문·전달 tx 유지, 계정없음401·204 재생 무본문·Outcome 비노출 추가 | PR ① 인증 조회 단언, ② 쓰기 경계, ③ preview 경계; 공용 runner 수정 없음 |
| R-API-5 | 일반350/상한400·심장200은 구현 diff로 검증. F1 준비를 즉시 조회 PR에 불필요하게 선반영하지 않음 | 공용 app-domain 자기 등록·단독 권한 커밋은 기존 소유 규칙 유지 |

양쪽 어느 것도 충족할 수 없는 계약 간 모순은 발견하지 않았다. 3건은 operation별 본길 유보이며 레인 전체 멈춤이 아니다. 작성에는 documentation의 독자·근거 우선 방식과 coding-rules의 명시적 오류/작은 책임을 적용했다. 코드·계약·DB·git·외부 메시지 쓰기 없이 이 리뷰 파일만 작성했다.
