import path from 'node:path';

import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'prisma/config';

/**
 * Prisma 설정 정본.
 * package.json의 `prisma` 필드는 Prisma 7에서 제거되므로 이 파일로 대체한다.
 *
 * 주의: 설정 파일이 있으면 Prisma CLI가 .env를 자동으로 읽지 않는다
 * ("Prisma config detected, skipping environment variable loading").
 * schema.prisma가 env("DATABASE_URL")을 쓰므로 여기서 직접 로드한다.
 * 컨테이너에서는 .env 파일이 없고 환경변수로 주입되므로 이 호출은 무해하게 지나간다.
 */
loadEnv({ path: path.join(__dirname, '.env'), quiet: true });

/**
 * 운영 이미지에는 ts-node(devDependency)가 없다.
 * 빌드 단계에서 seed를 dist/seed.js로 미리 컴파일해 두고, 운영에서는 그것을 실행한다.
 */
const seed =
  process.env.NODE_ENV === 'production' ? 'node dist/seed.js' : 'ts-node prisma/seed.ts';

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    path: path.join('prisma', 'migrations'),
    seed,
  },
});
