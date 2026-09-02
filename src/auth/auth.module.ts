import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';

import { AuthenticationGuard } from './authentication.guard';
import { CredentialService } from './credential.service';
import { SessionController } from './session.controller';
import { SessionResolver } from './session-resolver.service';
import { SessionService } from './session.service';

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const secret = config.get<string>('JWT_SECRET');
        // ⛔ 기본값을 두지 않는다. 두면 그 값으로 배포된 서버의 세션을 누구나 위조할 수 있고,
        // 빠졌다는 사실이 드러나지 않는다. 부팅에서 죽는 편이 낫다.
        if (!secret || secret.length < 32) {
          throw new Error('JWT_SECRET 이 없거나 32자 미만이다 (.env.prod.example 참조)');
        }
        return { secret };
      },
    }),
  ],
  controllers: [SessionController],
  providers: [
    CredentialService,
    SessionService,
    SessionResolver,
    { provide: APP_GUARD, useClass: AuthenticationGuard },
  ],
  exports: [CredentialService, SessionService, SessionResolver],
})
export class AuthModule {}
