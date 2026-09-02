import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';

import { CredentialService } from './credential.service';
import { SessionController } from './session.controller';
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
  providers: [CredentialService, SessionService],
  exports: [CredentialService, SessionService],
})
export class AuthModule {}
