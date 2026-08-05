import { INestApplication, ValidationPipe } from '@nestjs/common';

import { PrismaExceptionFilter } from './common/errors/prisma-exception.filter';
import { contractValidationException } from './common/errors/validation.error';
import { UNIQUE_VIOLATIONS } from './mdm/unique-violations';

/**
 * 요청 파이프라인. **운영 부팅(main.ts)과 e2e 가 같은 함수를 쓴다** — 프리픽스나 파이프가
 * 어긋나면 e2e 가 통과해도 운영에서 다른 응답이 나간다.
 */
export function configureApp(app: INestApplication, prefix: string): void {
  app.setGlobalPrefix(prefix);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      // 암묵 변환은 켜지 않는다 — 'false' 문자열을 Boolean(…)=true 로 바꿔
      // DTO 의 @Transform 결과를 덮어쓴다. 변환은 DTO 에서 @Type/@Transform 으로 명시한다.
      exceptionFactory: contractValidationException,
    }),
  );

  app.useGlobalFilters(new PrismaExceptionFilter(UNIQUE_VIOLATIONS));
}
