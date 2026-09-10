# 클라이언트 팀용 로컬 API 실행 가이드

이 저장소를 클론해 현재 구현된 API를 직접 실행하는 절차다. API는 호스트에서 실행하고,
PostgreSQL만 Docker로 실행한다. 명령은 macOS/Linux 또는 Windows WSL의 Bash/Zsh 기준이다.
명령이 실패하면 해당 단계의 원인을 해결한 뒤 다음 단계로 진행한다.

법인·사업부·공장·품목 등 업무 테스트 데이터는 클라이언트 팀에서 준비한다.
아래 `db:seed`는 서버에서 제공하는 단위·공통코드·채번규칙·역할·관리자 계정의 초기화다.
클라이언트 팀이 이 기본 데이터까지 별도로 구성한다면 생략할 수 있지만, 로그인과 업무 API의
동작에 필요한 값을 함께 준비해야 한다. 이 가이드에서는 신규 로컬 DB에 기본 시드를 적용한다.

## 1. 도구와 저장소 준비

- 이 저장소에 접근할 수 있는 GitHub SSH 인증
- Node.js 22: 저장소의 Dockerfile과 동일한 메이저 버전
- Corepack과 `package.json`의 `packageManager`에 지정된 pnpm
- Docker Engine/Desktop과 Docker Compose v2: 기존 PostgreSQL 16을 쓰면 불필요
- 최초 설치 시 npm 레지스트리와 Docker 이미지 다운로드가 가능한 네트워크

```bash
git clone git@github.com:CREFLEINC/omf-mes-server.git
cd omf-mes-server
git rev-parse HEAD
node --version
corepack enable
pnpm --version
docker compose version
```

Corepack 명령이 없다면 Node.js 설치 환경에 Corepack을 먼저 설치한다.
pnpm은 저장소가 지정한 버전을 사용한다. 서명 확인·다운로드 오류가 나면 레지스트리 접속,
프록시 및 Corepack 설치 상태를 확인한다. 버전 검증을 끄는 방식으로 진행하지 않는다.
API 팀과 재현할 때는 위에서 출력한 Git 커밋을 함께 전달한다.

## 2. 환경 변수 설정

최초 한 번만 복사한다. 이미 설정한 `.env`가 있다면 덮어쓰지 않고 필요한 항목만 수정한다.

```bash
cp .env.example .env
node -e 'console.log(require("node:crypto").randomBytes(48).toString("base64"))'
```

두 번째 명령으로 생성한 값을 `JWT_SECRET`에 넣는다. `.env` 예시는 다음과 같다.

```dotenv
DATABASE_URL="postgresql://omf:omf@localhost:5432/omf_mes?schema=public"
PORT=3100
API_PREFIX=api
NODE_ENV=development
JWT_SECRET="위에서 생성한 32자 이상의 값으로 교체"
JWT_EXPIRES_IN_SECONDS=28800
ADMIN_INITIAL_PASSWORD="직접 정한 초기 관리자 비밀번호로 교체"
COOKIE_SECURE=false
CORS_ORIGINS=http://localhost:5173
```

- DB 주소는 아래 개발용 Compose의 기본값이다. 기존 DB를 쓰면 사용자·비밀번호·호스트·포트를 맞춘다.
  접속 URL의 사용자명·비밀번호에 특수문자가 있으면 해당 부분을 URL 인코딩한다.
- `ADMIN_INITIAL_PASSWORD`는 빈 값으로 두지 말고 8자 이상으로 정한다.
  비어 있거나 해당 줄이 없으면 시드가 무작위 비밀번호를 생성해 한 번만 출력한다.
- `CORS_ORIGINS`는 실제 프런트엔드 오리진으로 바꾼다. 여러 개면 쉼표로 구분하며 끝에 `/`를 붙이지 않는다.
- `.env` 변경 후에는 API 프로세스를 재시작한다. 비밀번호와 `.env`는 Git에 올리지 않는다.

## 3. 의존성과 생성 파일 준비

```bash
pnpm install --frozen-lockfile
pnpm run prisma:generate
pnpm run contracts:generate
pnpm run build
```

Prisma Client와 계약 타입은 로컬에서 생성해야 한다. 계약 원본은 저장소의 `contracts/`에
포함되어 있으므로 별도 설계 저장소 클론이나 `contracts:update` 실행은 필요하지 않다.
타입 생성이 알려진 상류 계약 결함을 경고하고 종료 코드 0으로 끝나는 경우에도 이후 빌드 성공을
반드시 확인한다. 생성 또는 빌드 실패 시 해당 커밋과 오류를 API 팀에 전달한다.

## 4. PostgreSQL 및 스키마 준비

새 로컬 DB를 쓸 때:

```bash
docker compose -f docker-compose.yml up -d postgres
docker compose -f docker-compose.yml ps
```

`postgres`가 `healthy`가 된 뒤 다음 명령을 실행한다. 기존 PostgreSQL 16을 사용한다면
위 Docker 명령 대신 접속할 빈 DB와 마이그레이션 실행 권한이 있는 계정을 준비한다.
모든 명령은 `.env`의 `DATABASE_URL`을 대상으로 실행되므로 팀 공용 DB와 혼동하지 않는다.

```bash
pnpm exec prisma migrate deploy
pnpm exec prisma migrate status
pnpm run db:seed
```

`migrate status`에서 미적용 마이그레이션이 없는지 확인한다.
최초 로그인 ID는 `admin`, 비밀번호는 2단계에서 지정한 값이다.
무작위 생성 방식을 선택했다면 시드가 출력한 비밀번호를 기록한다.
기존 관리자 자격증명이 있는 DB에서는 시드를 다시 실행해도 관리자 비밀번호가 바뀌지 않는다.
시드는 공통코드·역할 등을 갱신하므로 일상적인 서버 실행 때마다 실행할 필요는 없다.

## 5. 서버 기동 및 확인

저장소 루트에서 실행하고 터미널을 유지한다.

```bash
pnpm run start:prod
```

이 명령은 3단계에서 빌드한 `dist/main`을 실행한다.
소스 변경을 감지하며 실행하려면 대신 `pnpm run start:dev`를 사용한다. 두 명령을 같은 포트로
동시에 실행하지 않는다. 환경 변수 변경이나 새 버전 반영 후에는 재시작한다.

다른 터미널에서 확인한다.

```bash
curl --fail --silent --show-error http://localhost:3100/api/health
```

정상이면 `status: "ok"`, `db: "up"`이 나온다. 이는 DB 연결까지 확인하며 업무 데이터의
완전성이나 모든 API의 성공을 의미하지는 않는다.

- Swagger: <http://localhost:3100/api/docs>
- OpenAPI JSON: <http://localhost:3100/api/docs-json>

Swagger에는 미구현 계약도 표시된다. 미구현 표시가 없는 API를 선택하고, 자동화에서는
OpenAPI 오퍼레이션의 `x-implemented: true`를 기준으로 구분한다. 구현 개수는 커밋마다 달라진다.

## 6. 클라이언트 연결과 로그인

프런트엔드에서 API를 직접 호출할 때는 2단계의 `CORS_ORIGINS` 설정과 함께
요청에 `credentials: 'include'`를 사용한다. Axios는 `withCredentials: true`를 사용한다.
인증은 `omf_session`이라는 HttpOnly 쿠키이며, 로그인 응답에서 Bearer 토큰을 꺼내는 방식이 아니다.

Postman에서는 다음 요청을 보내고 쿠키 저장 기능을 켠 상태로 후속 요청을 보낸다.

| 순서 | 메서드·URL | 본문 / 기대 결과 |
| --- | --- | --- |
| 로그인 | `POST http://localhost:3100/api/app/sessions` | JSON: `{"loginId":"admin","password":"직접 설정한 비밀번호"}` / 200 및 세션 쿠키 |
| 로그인 확인 | `GET http://localhost:3100/api/app/sessions/current` | 200 및 현재 세션 |
| 기본 조회 | `GET http://localhost:3100/api/mdm/uoms` | 200 및 단위 데이터 |

JSON 요청은 `Content-Type: application/json`으로 전송한다.
Swagger에서도 먼저 로그인 API를 실행한 뒤 같은 호스트의 다른 API를 호출할 수 있다.
추가 업무 데이터는 클라이언트 팀에서 구성한다.

프런트엔드 `localhost:5173`과 API `localhost:3100`처럼 **호스트 이름을 통일**한다.
`localhost`와 `127.0.0.1`을 섞으면 쿠키 정책 때문에 로그인 이후에도 401이 발생할 수 있다.
프런트엔드 개발 서버가 `/api`를 백엔드로 프록시하면 브라우저는 동일 오리진으로 요청할 수 있다.
HTTP 로컬 개발에서는 `COOKIE_SECURE=false`를 사용한다.

수정·등록 API의 `If-Match`, `Idempotency-Key` 등 필수 헤더와 입력값은 각 API 계약을 따른다.

## 7. API 팀의 새 변경을 받을 때

이 로컬 API를 실행한 터미널에서 `Ctrl+C`로 종료한 뒤 수행한다.
클라이언트 팀의 자체 변경이 있다면 먼저 별도 브랜치·커밋으로 정리한다.

```bash
git pull --ff-only
git rev-parse HEAD
pnpm install --frozen-lockfile
pnpm run prisma:generate
pnpm run contracts:generate
pnpm run build
pnpm exec prisma migrate deploy
pnpm exec prisma migrate status
pnpm run start:prod
```

기본 시드 변경이 API 팀에서 안내된 경우에만 `db:seed` 재실행 여부를 확인한다.
`prisma migrate reset`, `db push`, `db pull`은 이 실행 절차에 필요하지 않다.
테스트용 업무 데이터를 만들기 위해 전체 `test:e2e`를 실행하지 않는다. e2e는 DB 데이터를
생성·수정·삭제할 수 있으므로 클라이언트 테스트 DB와 분리해서 실행한다.

## 문제 해결

| 증상 | 확인할 내용 |
| --- | --- |
| `JWT_SECRET` 오류로 기동 실패 | `.env`의 값이 32자 이상인지, 저장소 루트에서 실행했는지 |
| Prisma `P1001` | DB 기동 상태, `DATABASE_URL`의 호스트·포트·계정 |
| 테이블·컬럼이 없다는 오류 | 같은 DB에 `prisma migrate deploy`를 실행했는지 |
| Prisma 또는 계약 타입을 찾지 못함 | 3단계의 생성 명령 후 다시 빌드 |
| `EADDRINUSE` | 이미 실행 중인 프로세스를 확인하거나 `.env`의 `PORT`를 변경하고 호출 URL도 변경 |
| PostgreSQL 5432 포트 충돌 | 기존 DB를 쓰거나 개인 Compose 포트 매핑과 `DATABASE_URL`을 함께 변경 |
| 브라우저 CORS 오류 | 실제 오리진과 `CORS_ORIGINS` 일치 여부, API 재시작 여부 |
| 로그인 후 401 | 쿠키 저장·전송, credentials 옵션, 호스트 통일, HTTP에서 Secure 설정 |
| 로그인 423 | 실패 누적으로 잠긴 계정. 시드 재실행은 잠금 해제나 비밀번호 재설정 수단이 아님 |
| 로그인 후 403 또는 빈 업무 목록 | 계정 권한과 팀에서 준비할 업무 데이터 확인 |

검증 범위: 이 문서는 저장소의 실행 설정과 명령에 맞춰 작성했다. 기존 개발 환경에서는
빌드·마이그레이션 상태·API 및 DB 상태 응답을 확인했으며, 새 PC의 클린 설치와 로그인 성공은
별도 검증 대상이다. Docker 배포 이미지의 검증 완료를 뜻하지 않는다.
