import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../../prisma/prisma.service';
import { commonCodeTable } from './apply/common-code.apply';
import { employeeTable } from './apply/employee.apply';
import { itemTable } from './apply/item.apply';
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
        const master = {
          name: '기준정보',
          // 참조되는 쪽이 앞이다.
          tables: [commonCodeTable, employeeTable, itemTable],
          intervalMs: settings.masterIntervalMs,
        };
        return new ErpSyncRunner(
          settings.enabled,
          [master],
          new InboundCycle(prisma, relay),
          new SyncLease(prisma),
          relay,
        );
      },
    },
  ],
})
export class ErpSyncModule {}
