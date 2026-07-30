import { INestApplication, ValidationPipe } from '@nestjs/common';
import { OpenAPIObject } from '@nestjs/swagger';

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

/** 인증부터 하지 않으면 나머지를 호출할 수 없으니 문서 맨 위에 둔다. */
export const AUTH_TAG = '인증';

/**
 * Swagger UI 는 `tagsSorter` 를 주지 않으면 **문서의 tags 배열 순서대로** 그룹을 그린다.
 * 그래서 태그를 문서에서 수집해 인증만 앞으로 빼고 나머지는 이름순으로 다시 적는다.
 *
 * 태그 목록을 손으로 나열하지 않는 이유는, 새 컨트롤러가 목록에서 빠져도 아무 경고 없이
 * 맨 뒤로 밀려나기 때문이다 — 문서에서 읽으면 저절로 따라온다.
 */
export function orderApiTags(document: OpenAPIObject): void {
  const found = new Set<string>();

  for (const pathItem of Object.values(document.paths ?? {})) {
    for (const operation of Object.values(pathItem ?? {})) {
      if (!operation || typeof operation !== 'object') continue;
      const tags: unknown = (operation as { tags?: unknown }).tags;
      if (!Array.isArray(tags)) continue;
      for (const tag of tags) {
        if (typeof tag === 'string') found.add(tag);
      }
    }
  }

  const rest = [...found].filter((tag) => tag !== AUTH_TAG).sort((a, b) => a.localeCompare(b, 'ko'));
  const ordered = found.has(AUTH_TAG) ? [AUTH_TAG, ...rest] : rest;

  document.tags = ordered.map((name) => ({ name }));
}
