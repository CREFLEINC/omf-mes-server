import { INestApplication, ValidationPipe } from '@nestjs/common';

import { PrismaExceptionFilter } from './common/filters/prisma-exception.filter';

/**
 * 정본 물리 모델의 PK·FK는 전부 bigint라 Prisma가 BigInt를 돌려준다.
 * JSON.stringify는 BigInt에서 TypeError를 던지므로 문자열로 직렬화한다.
 * (number로 바꾸면 2^53 초과 시 정밀도가 깨진다 — 문자열이 안전하다.)
 */
export function enableBigIntSerialization(): void {
  (BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function (this: bigint) {
    return this.toString();
  };
}

/**
 * 요청 파이프라인. **운영 부팅(main.ts)과 e2e가 같은 함수를 쓴다** —
 * 파이프·필터가 어긋나면 e2e가 통과해도 운영에서 다른 응답이 나간다.
 */
export function configureApp(app: INestApplication, prefix: string): void {
  app.setGlobalPrefix(prefix);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      // 암묵 변환은 켜지 않는다 — 'false' 문자열을 Boolean(…)=true로 바꿔
      // DTO의 @Transform 결과를 덮어쓴다. 변환은 DTO에서 @Type/@Transform으로 명시한다.
    }),
  );
  app.useGlobalFilters(new PrismaExceptionFilter());
}
