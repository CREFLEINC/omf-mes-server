import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { InventoryPostingModule } from '../../core/inventory-posting';
import { NumberingModule } from '../../core/numbering';
import { PlanningModule } from '../../planning/planning.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { ProductionModule } from '../../production/production.module';
import { SyncLease } from '../erp/sync-lease';
import { AUTO_WORK_ORDER_LEASE, AutoWorkOrderRunner } from './auto-work-order.runner';
import { AutoWorkOrderService } from './auto-work-order.service';
import { TrackingSystemController } from './tracking-system.controller';
import { StockIssueService } from './stock-issue.service';
import { StockMoveService } from './stock-move.service';
import { TrackingStockService } from './tracking-stock.service';
import { TrackingProduction } from './tracking-production';
import { WorkOrderCloseReportService } from './work-order-close-report.service';

/** 추적 시스템(flowtrack) 연동 — OA 자동 W/O · 포장 입고이동 · 출하 출고 · 마감 보고 · 재고 조회 · 수량 출고. 다른 도메인이 내보낸 서비스·함수를 부른다(사용자 결정 2026-11-16). */
@Module({
  imports: [PrismaModule, PlanningModule, ProductionModule, NumberingModule, InventoryPostingModule],
  controllers: [TrackingSystemController],
  providers: [
    AutoWorkOrderService,
    StockMoveService,
    StockIssueService,
    TrackingProduction,
    WorkOrderCloseReportService,
    TrackingStockService,
    // 운영 서버에서 AUTO_WORK_ORDER_ENABLED=true 여야 돈다 — 켜는 때는 현장이 정한다(사용자 2026-11-16).
    {
      provide: AutoWorkOrderRunner,
      inject: [ConfigService, PrismaService, AutoWorkOrderService],
      useFactory: (config: ConfigService, prisma: PrismaService, auto: AutoWorkOrderService): AutoWorkOrderRunner =>
        new AutoWorkOrderRunner(
          config.get<string>('AUTO_WORK_ORDER_ENABLED') === 'true',
          prisma,
          new SyncLease(prisma, AUTO_WORK_ORDER_LEASE),
          auto,
        ),
    },
  ],
})
export class TrackingSystemModule {}
