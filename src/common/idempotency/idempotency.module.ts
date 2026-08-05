import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { IdempotencyInterceptor } from './idempotency.interceptor';
import { IdempotencyStore } from './idempotency.store';

/**
 * 전역 인터셉터로 건다. 계약이 전 쓰기에 `Idempotency-Key` 를 필수로 요구하므로,
 * 엔드포인트마다 붙이면 새 쓰기를 만들며 깜빡한 곳이 보호 없이 나간다.
 */
@Global()
@Module({
  providers: [IdempotencyStore, { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor }],
  exports: [IdempotencyStore],
})
export class IdempotencyModule {}
