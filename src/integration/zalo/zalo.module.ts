import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { IdempotencyModule } from '../../common/idempotency';
import { SecretBox } from '../../core/crypto/secret-box';
import { PrismaModule } from '../../prisma/prisma.module';
import { ZaloConnectionController } from './zalo-connection.controller';
import { ZALO_DELIVERY_ENABLED, ZALO_SECRET_BOX, ZaloConnectionService } from './zalo-connection.service';
import { zaloConfig } from './zalo.config';

/** Zalo 알림 연계(omf-all-around#160) — 연결 설정. 발송 러너는 api 프로세스 안에서 돈다(ERP 러너와 같다). */
@Module({
  imports: [PrismaModule, IdempotencyModule],
  controllers: [ZaloConnectionController],
  providers: [
    {
      provide: ZALO_SECRET_BOX,
      inject: [ConfigService],
      useFactory: (config: ConfigService): SecretBox | null => {
        const { credentialKey } = zaloConfig(config);
        return credentialKey === '' ? null : new SecretBox(credentialKey);
      },
    },
    {
      provide: ZALO_DELIVERY_ENABLED,
      inject: [ConfigService],
      useFactory: (config: ConfigService): boolean => zaloConfig(config).deliveryEnabled,
    },
    ZaloConnectionService,
  ],
})
export class ZaloModule {}
