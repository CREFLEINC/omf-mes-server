import { INestApplication, ValidationPipe } from '@nestjs/common';

import { PrismaExceptionFilter } from './common/errors/prisma-exception.filter';
import { contractValidationException } from './common/errors/validation.error';
import { duplicateWarehouseCode } from './mdm/warehouse/warehouse.validator';

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

  // 유니크 위반의 컬럼 목록 → 계약 오류. 마스터가 늘 때마다 여기 한 줄씩 붙는다.
  // 키가 제약 이름(uq_warehouse)이 아닌 이유는 PrismaExceptionFilter 주석에 있다.
  app.useGlobalFilters(
    new PrismaExceptionFilter(new Map([['plant_id,warehouse_code', duplicateWarehouseCode]])),
  );
}
