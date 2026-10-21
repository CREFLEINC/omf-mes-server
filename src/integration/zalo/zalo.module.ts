import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { IdempotencyModule } from '../../common/idempotency';
import { SecretBox } from '../../core/crypto/secret-box';
import { PrismaModule } from '../../prisma/prisma.module';
import { ZaloConnectionController } from './zalo-connection.controller';
import { ZALO_DELIVERY_ENABLED, ZALO_SECRET_BOX, ZaloConnectionService } from './zalo-connection.service';
import { ZaloConfig, zaloConfig } from './zalo.config';

export const ZALO_CONFIG = Symbol('ZALO_CONFIG');

/** Zalo 알림 연계(omf-all-around#160) — 연결 설정. 발송 러너는 api 프로세스 안에서 돈다(ERP 러너와 같다). */
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
  ],
})
export class ZaloModule {}
