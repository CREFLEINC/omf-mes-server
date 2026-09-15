# syntax=docker/dockerfile:1
#
# OMF MES API — 최소 배포 이미지.
# API와 마이그레이션이 같은 이미지를 쓴다(커맨드만 다름). 그래서 prisma CLI를
# devDependencies가 아닌 dependencies에 둔다 — 운영 서버에서 migrate deploy를 돌려야 한다.

# Prisma 쿼리 엔진이 OpenSSL을 요구한다. alpine(musl)은 엔진 바이너리 타깃이 갈리므로
# 트러블이 적은 debian slim을 쓴다.
# node:22-bookworm-slim 에는 libssl 도 CA 번들도 들어 있지 않다 — 직접 넣어야 한다.
FROM node:22-bookworm-slim AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app


# ── 0. 빌드 전용 베이스
# pnpm은 설치·빌드에서만 쓴다. 운영 이미지(runtime)는 base에서 바로 갈라져 나가므로
# 패키지 매니저를 싣지 않는다.
FROM base AS toolchain
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN corepack enable


# ── 1. 전체 의존성 (빌드용 — devDependencies 포함)
FROM toolchain AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile
# prisma 파일은 install '뒤에' 복사한다 — 스키마를 한 줄 고칠 때마다
# 의존성 설치 레이어까지 다시 도는 것을 막는다.
COPY prisma/schema.prisma ./prisma/
COPY prisma.config.ts ./
# [필수] Prisma Client는 install 만으로 생성되지 않는다.
# @prisma/client 의 postinstall 은 자기 패키지 안에서 prisma CLI 를 찾지 못하면
# "In order to use @prisma/client, please install Prisma CLI" 경고만 남기고 조용히 건너뛴다.
# (pnpm 의 격리 링킹에서 특히 그렇다 — .npmrc 의 node-linker=isolated)
# 생성하지 않으면 다음 build 단계의 tsc 타입검사가 모델 타입을 못 찾아 실패한다.
RUN pnpm exec prisma generate


# ── 2. 빌드 (SWC 트랜스파일 + tsc 타입 검사)
FROM deps AS build
# tsconfig.all.json 은 `pnpm typecheck` 전용이다. nest build 는 tsconfig.build.json 을
# 쓰므로 여기서는 복사하지 않는다 — 넣어봐야 캐시만 헛되이 깨진다.
COPY tsconfig.json tsconfig.build.json nest-cli.json .swcrc ./
# [필수] 계약 타입은 커밋하지 않는다(.gitignore) — Prisma Client 와 같다.
# 생성하지 않으면 아래 build 의 tsc 타입검사가 계약 스키마를 못 찾아 실패한다.
# src 보다 '앞에' 복사한다 — 계약은 src 보다 훨씬 덜 바뀌므로, 코드를 한 줄 고칠 때마다
# 생성 레이어까지 다시 도는 것을 막는다(위 deps 스테이지의 prisma 복사와 같은 이유).
COPY contracts ./contracts
# 계약 타입 생성 스크립트와 계약 목록 정의도 빌드 스테이지에 필요하다.
COPY scripts/contracts ./scripts/contracts
RUN pnpm run contracts:generate
COPY src ./src
RUN pnpm run build
# 운영 이미지에는 ts-node가 없다 — 시드를 미리 JS로 컴파일해 둔다(prisma.config.ts 참조).
# nest build 가 dist를 지우므로(deleteOutDir) 반드시 그 뒤에 온다.
COPY prisma/seed.ts ./prisma/
RUN pnpm exec swc prisma/seed.ts -o dist/seed.js


# ── 3. 운영 의존성만 (devDependencies 제외)
FROM toolchain AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --prod
COPY prisma/schema.prisma ./prisma/
COPY prisma.config.ts ./
# [필수] 런타임 이미지는 이 단계의 node_modules 를 그대로 복사해 간다.
# 여기서 생성하지 않으면 운영에서 첫 쿼리에 다음 에러로 죽는다:
#   "@prisma/client did not initialize yet. Please run 'prisma generate'"
# prisma CLI 가 dependencies 에 있으므로 --prod 설치에서도 실행 가능하다.
RUN pnpm exec prisma generate


# ── 4. 런타임
FROM base AS runtime
ENV NODE_ENV=production \
    PORT=3100

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# 락파일·워크스페이스 설정은 설치 시점 파일이라 런타임에는 읽는 주체가 없다.
COPY package.json ./
# migrate deploy가 스키마·마이그레이션 이력을 읽는다.
COPY prisma/schema.prisma ./prisma/
COPY prisma/migrations ./prisma/migrations
COPY prisma.config.ts ./
# 계약 검증기가 부팅 때 읽는다. 빼면 「계약 파일이 없다」로 죽는다 —
# 타입 생성(build 스테이지)과 달리 런타임에도 원본이 필요하다.
COPY contracts ./contracts
# 첨부 파일 저장 경로. compose 가 이 자리에 이름 있는 볼륨을 건다 — 빈 볼륨이 처음 붙을 때
# Docker 가 이 디렉터리의 소유권(node)을 볼륨으로 복사해 가서, 서버에서 sudo chown 없이 쓸 수 있다.
RUN install -d -o node -g node -m 0700 /var/lib/omf-mes/attachments

# node 이미지에 기본 포함된 비루트 사용자로 실행한다
USER node

EXPOSE 3100
CMD ["node", "dist/main"]
