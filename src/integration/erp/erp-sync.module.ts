import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../../prisma/prisma.service';
import { bomTable } from './apply/bom.apply';
import { commonCodeTable } from './apply/common-code.apply';
import { employeeTable } from './apply/employee.apply';
import { itemTable } from './apply/item.apply';
import { partnerTable } from './apply/partner.apply';
import { productionOrderTable } from './apply/production-order.apply';
import { purchaseOrderTable } from './apply/purchase-order.apply';
import { salesOrderTable } from './apply/sales-order.apply';
import { erpSyncConfig } from './erp-sync.config';
import { ErpSyncRunner } from './erp-sync.runner';
import { InboundCycle } from './inbound-cycle';
import { RelayClient } from './relay-client';
import { SyncLease } from './sync-lease';

/**
 * ERP 연동 — api 프로세스 안에서 돈다. 다른 모듈에 기대지 않게 두었다 — ERP 가 느려 화면에
 * 영향이 보이면 이 모듈만 띄우는 worker 로 떼어 낸다(2026-10-16 결정).
 */
@Module({
  providers: [
    {
      provide: ErpSyncRunner,
      inject: [ConfigService, PrismaService],
      useFactory: (config: ConfigService, prisma: PrismaService): ErpSyncRunner => {
        const settings = erpSyncConfig(config);
        const relay = new RelayClient(settings.relay);
        // 참조되는 쪽이 앞이다. 전표는 기준정보 회차가 끝난 뒤 같은 줄에서 돈다(실행기가 순서대로).
        const master = {
          name: '기준정보',
          tables: [commonCodeTable, employeeTable, itemTable, partnerTable, bomTable],
          intervalMs: settings.masterIntervalMs,
        };
        const orders = {
          name: '전표',
          tables: [purchaseOrderTable, salesOrderTable, productionOrderTable],
          intervalMs: settings.orderIntervalMs,
        };
        return new ErpSyncRunner(
          settings.enabled,
          [master, orders],
          new InboundCycle(prisma, relay),
          new SyncLease(prisma),
          relay,
        );
      },
    },
  ],
})
export class ErpSyncModule {}
