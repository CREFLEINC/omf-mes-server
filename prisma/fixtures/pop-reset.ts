/**
 * 픽스처 W/O를 「막 배포된」 상태로 되돌린다.
 *
 * Postman 시나리오는 작업을 시작하고 실적을 올려 상태를 남기므로, 두 번째 실행부터는
 * 「이미 진행 중」 409로 막힌다. 매 회차를 같은 출발선에서 시작하려면 이걸 먼저 돌린다.
 *
 * 실행: `npm run fixtures:pop:reset`
 */
import { PrismaClient } from '@prisma/client';

import { resetPopWorkStartState, WORK_ORDER_NO } from './pop-work-start';

const prisma = new PrismaClient();

resetPopWorkStartState(prisma)
  .then(() => {
    // eslint-disable-next-line no-console
    console.log(`${WORK_ORDER_NO} — 세션·실적을 지우고 RELEASED로 되돌렸습니다.`);
  })
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
