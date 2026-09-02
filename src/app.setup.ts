import { INestApplication } from '@nestjs/common';

import { ErrorResponseFilter } from './common/errors';

/**
 * 요청 파이프라인. **운영 부팅(main.ts)과 e2e 가 같은 함수를 쓴다** — 프리픽스나 파이프가
 * 어긋나면 e2e 가 통과해도 운영에서 다른 응답이 나간다.
 *
 * 검증 파이프는 계약 검증기가 서는 PR 에서 이 함수에 더한다.
 */
export function configureApp(app: INestApplication, prefix: string): void {
  app.setGlobalPrefix(prefix);
  app.useGlobalFilters(new ErrorResponseFilter());
}
