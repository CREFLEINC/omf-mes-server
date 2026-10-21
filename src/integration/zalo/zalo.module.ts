import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { IdempotencyModule } from '../../common/idempotency';
import { SecretBox } from '../../core/crypto/secret-box';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncLease } from '../erp/sync-lease';
import { ZaloClient } from './zalo-client';
import { ZaloConnectionController } from './zalo-connection.controller';
import { ZALO_DELIVERY_ENABLED, ZALO_SECRET_BOX, ZaloConnectionService } from './zalo-connection.service';
import { ZALO_DELIVERY_LEASE, ZaloDeliveryRunner } from './zalo-delivery.runner';
import { ZaloTokenService } from './zalo-token.service';
import { ZaloConfig, zaloConfig } from './zalo.config';

export const ZALO_CONFIG = Symbol('ZALO_CONFIG');

/** Zalo 알림 연계(omf-all-around#160) — 연결 설정과 발송 러너. 러너는 api 프로세스 안에서 돈다(ERP 러너와 같다). */
@Module({
  imports: [PrismaModule, IdempotencyModule],
  controllers: [ZaloConnectionController],
  providers: [
    { provide: ZALO_CONFIG, inject: [ConfigService], useFactory: zaloConfig },
    {
      provide: ZALO_SECRET_BOX,
      inject: [ZALO_CONFIG],
      useFactory: ({ credentialKey }: ZaloConfig): SecretBox | null => (credentialKey === '' ? null : new SecretBox(credentialKey)),
    },
    { provide: ZALO_DELIVERY_ENABLED, inject: [ZALO_CONFIG], useFactory: (config: ZaloConfig): boolean => config.deliveryEnabled },
    ZaloConnectionService,
    {
      provide: ZaloDeliveryRunner,
      inject: [ZALO_CONFIG, ZALO_SECRET_BOX, PrismaService],
      useFactory: (config: ZaloConfig, box: SecretBox | null, prisma: PrismaService): ZaloDeliveryRunner => {
        const client = new ZaloClient({ apiBaseUrl: config.apiBaseUrl, oauthBaseUrl: config.oauthBaseUrl });
        // 키가 없으면 발송이 꺼져 있다(`zaloConfig` 가 켜짐 + 키 없음을 막는다) — 토큰 서비스는 쓰이지 않는다.
        const tokens = box === null ? { access: () => Promise.resolve(null) } : new ZaloTokenService(prisma, box, client);
        return new ZaloDeliveryRunner(config.deliveryEnabled, prisma, new SyncLease(prisma, ZALO_DELIVERY_LEASE), client, tokens);
      },
    },
  ],
})
export class ZaloModule {}
