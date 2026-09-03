import { Module } from '@nestjs/common';

import { IdempotencyModule } from '../common/idempotency';
import { PrismaModule } from '../prisma/prisma.module';
import { InterfaceDefinitionController } from './interface/interface-definition.controller';
import { InterfaceDefinitionService } from './interface/interface-definition.service';

/**
 * 계약 최상위 경로 `/integration` — 연계 정의·메시지·송신 항목 설정.
 * (`docs/server-architecture.md` §1 「모듈 배치는 계약 경로를 따른다」)
 */
@Module({
  imports: [PrismaModule, IdempotencyModule],
  controllers: [InterfaceDefinitionController],
  providers: [InterfaceDefinitionService],
})
export class IntegrationModule {}
