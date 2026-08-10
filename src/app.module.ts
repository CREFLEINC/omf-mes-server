import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AuthModule } from './auth/auth.module';
import { IdempotencyModule } from './common/idempotency/idempotency.module';
import { HealthModule } from './health/health.module';
import { CodeModule } from './mdm/code/code.module';
import { DepartmentModule } from './mdm/department/department.module';
import { LookupModule } from './mdm/lookup/lookup.module';
import { LocationModule } from './mdm/location/location.module';
import { WarehouseModule } from './mdm/warehouse/warehouse.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    // 컨테이너에는 .env 파일이 없고 환경변수로 주입한다 — 파일이 없어도 동작한다.
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env'] }),
    PrismaModule,
    IdempotencyModule,
    AuthModule,
    HealthModule,
    CodeModule,
    DepartmentModule,
    LocationModule,
    LookupModule,
    WarehouseModule,
  ],
})
export class AppModule {}
