import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    // 컨테이너에는 .env 파일이 없고 환경변수로 주입한다 — 파일이 없어도 동작한다.
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env'] }),
    PrismaModule,
    HealthModule,
  ],
})
export class AppModule {}
