import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AuthModule } from './auth/auth.module';
import { ContractModule } from './common/contract';
import { IdempotencyModule } from './common/idempotency';
import { OptimisticLockModule } from './common/optimistic-lock';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    // 컨테이너에는 .env 파일이 없고 환경변수로 주입한다 — 파일이 없어도 동작한다.
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env'] }),
    // 계약 검증 가드를 전역으로 단다. @Contract 가 붙은 핸들러만 검사한다.
    ContractModule,
    PrismaModule,
    // ⛔ 계약 검증 가드 «뒤»에 온다 — 본문이 계약과 맞는지 먼저 보고, 그다음 멱등키를 본다.
    IdempotencyModule,
    OptimisticLockModule,
    AuthModule,
    HealthModule,
  ],
})
export class AppModule {}
