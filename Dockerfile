# syntax=docker/dockerfile:1
#
# OMF MES API — 최소 배포 이미지.
# API와 마이그레이션이 같은 이미지를 쓴다(커맨드만 다름). 그래서 prisma CLI를
# devDependencies가 아닌 dependencies에 둔다 — 운영 서버에서 migrate deploy를 돌려야 한다.

# Prisma 쿼리 엔진이 OpenSSL을 요구한다. alpine(musl)은 엔진 바이너리 타깃이 갈리므로
# 트러블이 적은 debian slim을 쓴다.
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN corepack enable \
 && apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app


# ── 1. 전체 의존성 (빌드용 — devDependencies 포함)
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
# @prisma/client의 postinstall이 스키마를 읽어 클라이언트를 생성한다 — 설치 전에 있어야 한다.
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN pnpm install --frozen-lockfile


# ── 2. 빌드 (SWC 트랜스파일 + tsc 타입 검사)
FROM deps AS build
COPY tsconfig.json tsconfig.build.json tsconfig.all.json nest-cli.json .swcrc ./
COPY src ./src
RUN pnpm run build
# 운영 이미지에는 ts-node가 없다 — 시드를 미리 JS로 컴파일해 둔다(prisma.config.ts 참조).
RUN pnpm exec swc prisma/seed.ts -o dist/seed.js


# ── 3. 운영 의존성만 (devDependencies 제외)
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN pnpm install --frozen-lockfile --prod


# ── 4. 런타임
FROM base AS runtime
ENV NODE_ENV=production \
    PORT=3100

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# migrate deploy가 스키마·마이그레이션 이력을 읽는다
COPY prisma ./prisma
COPY prisma.config.ts ./

# node 이미지에 기본 포함된 비루트 사용자로 실행한다
USER node

EXPOSE 3100
CMD ["node", "dist/main"]
