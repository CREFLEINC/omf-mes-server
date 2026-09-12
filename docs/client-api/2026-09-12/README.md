# OMF MES 클라이언트 API 설계서 — 서버 구현 기준 임시 최신본

> 전달 대상: 클라이언트 개발팀
>
> 상태: **임시 서버 구현 기준선 — 설계팀 확정본 아님**
>
> 작성일: 2026-09-12
>
> 서버: `v0.1.3-next` · `21c83c41b9d21bdb41f217a9521cb61984b56938`
>
> 앞 전달본: [2026-09-11](../2026-09-11/README.md) — 무엇이 달라졌는지는 아래 「2026-09-11 전달본에서 달라진 것」을 본다.
>
> 원본 설계 계약: `a6a87e144116ebaa32c01df5a12a0fd2924427e7`

## 먼저 할 일

1. [클라이언트 우선 대응표](client-action-matrix.md)의 P0부터 반영한다.
2. 타입·API 클라이언트 생성에는 이 폴더의 `openapi/*.json` 7개를 각각 사용한다.
3. 각 오퍼레이션의 `x-omf-server-implementation.status`를 확인한다.
   - `implemented`: 서버 구현 완료
   - `partial`: API는 응답하지만 외부 연동·발송 등 일부가 범위 밖
   - `not-implemented`: 호출하지 않는다
4. 설계팀 확정본이 오면 이 기준선을 계속 수정하지 말고, 확정본으로 교체한 뒤 차이를 다시 대조한다.

## 인증 공통 규칙

- `POST /app/sessions` 성공 응답은 `omf_session` HttpOnly 쿠키를 발급한다. 이 로그인 API만 익명 호출이다.
- 로그인 외 현재 제공 API 482건은 쿠키 인증이 필요하며, 쿠키가 없거나 유효하지 않으면 401 `ErrorResponse`를 반환한다. 미구현 4건은 서버 경로 자체가 없으므로 호출하지 않는다.
- 브라우저 `fetch`는 `credentials: "include"`, Axios는 `withCredentials: true`를 사용한다. 개발 환경에서 교차 출처 호출할 때도 같다.
- 로그인 자체의 401은 공통 `ErrorResponse`가 아니라 기존 `LoginFailure`다.

## 이 자료가 반영한 것

- 계약 오퍼레이션 487건과 서버 `@Contract` 바인딩을 전수 대조해 **474건 구현·9건 부분 구현·4건 미구현** 상태를 오퍼레이션마다 표시했다. 호출 가능한 바인딩은 구현·부분 구현을 합쳐 483건이다.
- 서버가 실제로 반환하지만 원본 계약 enum에 없던 읽기 값(`SHIPMENT`, `C17`~`C20`, `DISPOSITION_DECISION`, `STOCK_TRANSFER`)을 **응답 스키마**에 반영했다.
- 블라인드 실사의 `systemQty` 생략, 출하·재등록 409의 필수 `conflictCause`, 서버가 내는 400 응답을 반영했다.
- 출하 목록의 필수 기간과 실제 허용 정렬 키를 반영했다.
- 요청 허용 범위는 서버 검증과 다르게 넓히지 않았다. 예를 들어 `GET /trace/lot-status-events?transitionCode=C20`은 현재 서버가 400으로 거부하므로 질의 enum은 그대로다.
- 설계팀이 아직 이름을 정하지 않은 값은 만들지 않았다. 출하 소유 전표의 취소 차단은 현재 서버가 반환하는 `STATE_LOCKED`로 설명만 보강했다.

## 2026-09-11 전달본에서 달라진 것

⭐ **사용자 등록이 초기 비밀번호까지 만든다**(사용자 결정 2026-09-12). 앞 전달본까지는
`POST /app/users`가 계정만 만들었고, 관리자가 `:reset-password`를 따로 누르기 전에는 그
계정으로 로그인할 수 없었다. 로그인 실패는 계정 존재를 숨기는 401이라 화면에서는
「비밀번호가 틀리다」와 구분되지 않았다.

- `AppUserCreate.password`(선택)가 생겼다. 보내면 그 값이 계정의 비밀번호가 되고 **첫 로그인
  강제 변경이 걸리지 않는다**. 최소 길이는 8이고 조합 규칙은 없다.
- 생략하면 서버가 임시 비밀번호를 만들어 등록 응답 `temporaryPassword`로 **한 번만**
  내려준다. 화면은 이 값을 그 자리에서 관리자에게 보여 주어야 한다 — 다시 받을 길은
  `:reset-password`로 새로 뽑는 것뿐이다.
- 201 응답 스키마가 `AppUser`에서 `AppUserCreated`(= `AppUser` + `temporaryPassword`)로 바뀌었다.

⭐ **`Session.mustChangePassword`가 생겼다.** 서버는 이 값을 이미 계산하고 있었으나 원본
계약에 칸이 없어 내리지 못했다. 로그인 응답과 `GET /app/sessions/current` 양쪽에 **항상**
실리므로 필수 칸으로 두었다. `true`면 화면은 곧바로
`POST /app/users/me:change-password`로 보낸다.

⚠ **`GET /app/document-issues/{documentIssueLogId}/rendition`이 미구현에서 부분 구현으로
옮겨졌다.** `MATERIAL_LOT_LABEL` 발행 기록만 PNG로 렌더링하고 다른 문서 유형은 422다.
산출물을 저장하지 않으므로 호출할 때마다 다시 그린다. 그래서 미구현이 5건에서 4건으로,
부분 구현이 8건에서 9건으로 바뀌었다.

## 원본 계약과의 관계

저장소 `contracts/*.json`은 설계 저장소의 읽기 전용 사본이다. 이 전달본은 원본을 직접 고치지 않고 별도 생성된다.

각 파일에는 다음 확장이 있다.

| 확장                          | 의미                                 |
| ----------------------------- | ------------------------------------ |
| `x-omf-server-baseline`       | 원본 계약·서버 버전·임시 문서 상태   |
| `x-omf-server-implementation` | 오퍼레이션별 구현 상태와 제한        |
| `x-omf-known-differences`     | 관련 설계 통보 번호와 현재 서버 동작 |

파일별 해시·오퍼레이션 수·미구현/부분 구현 목록은 [manifest.json](manifest.json)에 있다.

## 재생성 및 검증

저장소 루트에서 실행한다.

```bash
node scripts/client-api/build-implementation-baseline.mjs
node --check scripts/client-api/build-implementation-baseline.mjs
for spec in docs/client-api/2026-09-12/openapi/*.json; do pnpm exec openapi-typescript "$spec" -o "/tmp/$(basename "$spec" .json).d.ts"; done
git diff --exit-code -- docs/client-api/2026-09-12
```

생성기는 다음 조건이 달라지면 실패한다.

- 계약 오퍼레이션 수가 487이 아님
- 구현되지 않은 오퍼레이션이 현재 확정한 4건과 다름
- 계약에 없는 `@Contract` 바인딩이 생김
- 현재 `src` 트리가 문서에 표시한 서버 커밋과 다름
- 보정 대상 스키마·오퍼레이션·파라미터가 사라짐

## 전달 범위 밖

- 화면 설계서·업무 요구서는 포함하지 않았다.
- 서버 내부 DB 모델은 포함하지 않았다.
- 설계팀이 아직 확정하지 않은 새 코드값·새 필드는 임의로 추가하지 않았다.
- 실제 파일 저장소, Zalo 발송, ERP 실송신은 이 자료로 구현 완료로 간주하지 않는다.
