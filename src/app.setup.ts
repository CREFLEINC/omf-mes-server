import { INestApplication } from '@nestjs/common';

import { ErrorResponseFilter } from './common/errors';
import { configureCors } from './common/http/cors';

/**
 * 요청 파이프라인. **운영 부팅(main.ts)과 e2e 가 같은 함수를 쓴다** — 프리픽스나 파이프가
 * 어긋나면 e2e 가 통과해도 운영에서 다른 응답이 나간다.
 */
export function configureApp(app: INestApplication, prefix: string): string[] {
  app.setGlobalPrefix(prefix);
  app.useGlobalFilters(new ErrorResponseFilter());
  // 목록이 없으면 아무것도 열지 않는다 — 기본은 종전과 같다.
  return configureCors(app, process.env.CORS_ORIGINS);
}
