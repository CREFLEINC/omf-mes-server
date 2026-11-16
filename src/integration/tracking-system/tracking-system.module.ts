import { Module } from '@nestjs/common';

import { PlanningModule } from '../../planning/planning.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { ProductionModule } from '../../production/production.module';
import { AutoWorkOrderService } from './auto-work-order.service';

/** 추적 시스템(flowtrack) 연동 — OA 자동 W/O. 계획·생산 모듈이 내보낸 서비스를 부른다(사용자 결정 2026-11-16). */
@Module({
  imports: [PrismaModule, PlanningModule, ProductionModule],
  providers: [AutoWorkOrderService],
})
export class TrackingSystemModule {}
