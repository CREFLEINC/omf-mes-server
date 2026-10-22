import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AuthModule } from '../../auth/auth.module';
import { AutoPlanService } from '../../planning/production-order/auto-plan.service';
import { PlanningModule } from '../../planning/planning.module';
import { PrismaService } from '../../prisma/prisma.service';
import { bomTable } from './apply/bom.apply';
import { commonCodeTable } from './apply/common-code.apply';
import { employeeTable } from './apply/employee.apply';
import { itemTable } from './apply/item.apply';
import { partnerTable } from './apply/partner.apply';
import { productionOrderTable } from './apply/production-order.apply';
import { purchaseOrderTable } from './apply/purchase-order.apply';
import { salesOrderTable } from './apply/sales-order.apply';
import { ERP_SYNC_LANES, ErpSyncStatusService } from './erp-sync-status.service';
import { ERP_SEND_LEASE, ErpSendRunner } from './erp-send.runner';
import { erpSyncConfig } from './erp-sync.config';
import { ErpSyncController } from './erp-sync.controller';
import { ErpSyncRunner, Lane } from './erp-sync.runner';
import { InboundCycle } from './inbound-cycle';
import { RCV_TABLES } from './rcv-tables';
import { productionReceiptBuilder } from './send/production-receipt.send';
import { RelayClient } from './relay-client';
import { SyncLease } from './sync-lease';
import { SyncState } from './sync-state';

/**
 * ERP 연동 — api 프로세스 안에서 돈다. 다른 모듈에는 받은 ERP W/O 의 자동 계획에만 기댄다 — ERP 가 느려 화면에
 * 영향이 보이면 이 모듈만 띄우는 worker 로 떼어 낸다(2026-10-16 결정).
 * 인증 모듈은 연동 현황·「지금 읽기」 API(P-81)가 가드 밖에서 세션을 풀려고 쓴다 — 떼어 낼 때 그 API 는 api 쪽에 남긴다.
 */
@Module({
  imports: [PlanningModule, AuthModule],
  controllers: [ErpSyncController],
  providers: [
    {
      provide: ERP_SYNC_LANES,
      inject: [ConfigService, AutoPlanService],
      useFactory: (config: ConfigService, autoPlans: AutoPlanService): Lane[] => {
        const settings = erpSyncConfig(config);
        // 참조되는 쪽이 앞이다. 전표는 기준정보 회차가 끝난 뒤 같은 줄에서 돈다(실행기가 순서대로).
        const master: Lane = {
          code: 'MASTER',
          name: '기준정보',
          tables: [commonCodeTable, employeeTable, itemTable, partnerTable, bomTable],
          intervalMs: settings.masterIntervalMs,
        };
        const orders: Lane = {
          code: 'ORDER',
          name: '전표',
          tables: [
            purchaseOrderTable,
            salesOrderTable,
            // ERP 수신에는 세션이 없다 — 계획의 작성자를 비운다.
            productionOrderTable((id) => autoPlans.planReceived(Number(id), undefined)),
          ],
          intervalMs: settings.orderIntervalMs,
        };
        return [master, orders];
      },
    },
    {
      provide: ErpSyncRunner,
      inject: [ConfigService, PrismaService, ERP_SYNC_LANES],
      useFactory: (config: ConfigService, prisma: PrismaService, lanes: Lane[]): ErpSyncRunner => {
        const settings = erpSyncConfig(config);
        const relay = new RelayClient(settings.relay);
        return new ErpSyncRunner(
          settings.enabled,
          lanes,
          new InboundCycle(prisma, relay),
          new SyncLease(prisma),
          relay,
          new SyncState(prisma),
        );
      },
    },
    {
      provide: ErpSendRunner,
      inject: [ConfigService, PrismaService],
      useFactory: (config: ConfigService, prisma: PrismaService): ErpSendRunner => {
        const settings = erpSyncConfig(config);
        // 연결 풀을 받기와 나눈다 — 한쪽의 긴 회차가 다른 쪽 연결을 붙들지 않게.
        // 바꾸개는 표마다 따로 더한다 — 출하·구매입고는 아직 없다.
        return new ErpSendRunner(
          settings.sendEnabled,
          prisma,
          new SyncLease(prisma, ERP_SEND_LEASE),
          new RelayClient(settings.relay),
          [productionReceiptBuilder(prisma)],
          RCV_TABLES,
        );
      },
    },
    ErpSyncStatusService,
  ],
})
export class ErpSyncModule {}
