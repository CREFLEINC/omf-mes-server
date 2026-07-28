import { config } from 'dotenv';

import { enableBigIntSerialization } from '../src/app.setup';

// e2e는 실제 앱과 실제 DB를 쓴다. ConfigModule이 뜨기 전에 PrismaClient가
// DATABASE_URL을 읽으므로 여기서 먼저 .env를 로드한다.
config();

// 운영 부팅과 같은 BigInt 직렬화 — main.ts가 모듈 로드 시점에 하는 일이다.
enableBigIntSerialization();

const missing = [
  !process.env.DATABASE_URL && 'DATABASE_URL',
  (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) && 'JWT_SECRET(32자 이상)',
].filter(Boolean);

if (missing.length > 0) {
  throw new Error(
    `e2e는 실제 앱을 부팅한다 — .env에 ${missing.join(' · ')}이(가) 필요하다.\n` +
      'DB가 떠 있어야 한다: docker compose up -d && npm run prisma:migrate && npm run db:seed',
  );
}
